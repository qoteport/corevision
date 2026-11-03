"""User accounts and login for a single-organization deployment.

- Passwords: scrypt (stdlib), per-user salt, constant-time verify.
- Sessions: random token in an HttpOnly, SameSite=Lax cookie; only its SHA-256 is stored. 14 days, sliding.
- Every /api route needs a session except health, auth status, login and first-run setup.
- Roles: admin (everything, incl. users), geologist (log and edit data), viewer (read and export only).
- CSRF: unsafe requests must carry `X-Requested-With: corevision` (cross-site forms cannot set it),
  on top of SameSite=Lax cookies.
- Login is rate-limited per IP + email.
"""
import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db

router = APIRouter()

ROLES = ("admin", "geologist", "viewer")
COOKIE = "cv_session"
SESSION_TTL = 14 * 24 * 3600
TOUCH_EVERY = 3600  # extend a session at most once an hour, to limit writes
MIN_PASSWORD = 10
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "corevision"
SETUP_TOKEN = os.environ.get("CV_SETUP_TOKEN", "").strip() or None

PUBLIC = {("GET", "/api/health"), ("GET", "/api/auth/status"), ("POST", "/api/auth/login"),
          ("POST", "/api/auth/setup")}
# Unsafe requests a viewer may still make (their own account).
VIEWER_WRITES = {"/api/auth/logout", "/api/auth/password"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# ---------- passwords ----------

_N, _R, _P = 2 ** 15, 8, 1  # scrypt cost; ~50 ms per hash


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=_N, r=_R, p=_P, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, h = stored.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                              maxmem=64 * 1024 * 1024, dklen=len(base64.b64decode(h)))
        return hmac.compare_digest(calc, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = hash_password(secrets.token_hex(16))  # spend the same time when the email is unknown


def check_password_strength(pw: str) -> None:
    if len(pw) < MIN_PASSWORD:
        raise HTTPException(422, f"Password must be at least {MIN_PASSWORD} characters.")
    if pw.lower() == pw and pw.isalpha():
        raise HTTPException(422, "Use a longer passphrase, or mix in numbers or symbols.")


# ---------- rate limiting (per instance) ----------

_fails: dict[str, list[float]] = {}
_fails_lock = threading.Lock()
MAX_FAILS, FAIL_WINDOW = 8, 15 * 60


def _limited(key: str) -> bool:
    now = time.time()
    with _fails_lock:
        hits = [t for t in _fails.get(key, []) if now - t < FAIL_WINDOW]
        _fails[key] = hits
        return len(hits) >= MAX_FAILS


def _fail(key: str) -> None:
    with _fails_lock:
        _fails.setdefault(key, []).append(time.time())


def _reset_fails(key: str) -> None:
    with _fails_lock:
        _fails.pop(key, None)


# ---------- sessions ----------

def _hash_token(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def user_out(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "active": bool(u["active"]),
            "created_at": u.get("created_at"), "last_login_at": u.get("last_login_at")}


def create_session(c, user_id: str, user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    t = db.now()
    c.execute("INSERT INTO user_session (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) "
              "VALUES (?,?,?,?,?,?)", (_hash_token(token), user_id, t, t + SESSION_TTL, t, (user_agent or "")[:200]))
    c.execute("DELETE FROM user_session WHERE expires_at < ?", (t,))  # housekeeping
    return token


def session_user(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    with db.tx() as c:
        r = c.execute("SELECT s.token_hash, s.expires_at, s.last_seen_at, u.* FROM user_session s "
                      "JOIN app_user u ON u.id = s.user_id WHERE s.token_hash=?", (_hash_token(token),)).fetchone()
        if not r:
            return None
        r = dict(r)
        t = db.now()
        if r["expires_at"] < t or not r["active"]:
            c.execute("DELETE FROM user_session WHERE token_hash=?", (r["token_hash"],))
            return None
        if t - (r["last_seen_at"] or 0) > TOUCH_EVERY:
            c.execute("UPDATE user_session SET last_seen_at=?, expires_at=? WHERE token_hash=?",
                      (t, t + SESSION_TTL, r["token_hash"]))
        return r


def _set_cookie(resp: Response, request: Request, token: str) -> None:
    resp.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True, samesite="lax",
                    secure=request.url.scheme == "https", path="/")


def revoke_sessions(c, user_id: str) -> None:
    c.execute("DELETE FROM user_session WHERE user_id=?", (user_id,))


def current_user(request: Request) -> dict:
    u = getattr(request.state, "user", None)
    if not u:
        raise HTTPException(401, "Sign in required")
    return u


# ---------- middleware ----------

def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"detail": msg}, status_code=status)


def _admin_only(method: str, path: str) -> bool:
    if path.startswith("/api/users") or path == "/api/org" and method != "GET":
        return True
    # deleting a whole project is irreversible: admins only
    return method == "DELETE" and re.fullmatch(r"/api/projects/[^/]+", path) is not None


async def auth_middleware(request: Request, call_next):
    path, method = request.url.path, request.method
    if not path.startswith("/api/"):
        return await call_next(request)  # the frontend itself; it shows the login screen
    if method not in SAFE_METHODS and request.headers.get(CSRF_HEADER, "").lower() != CSRF_VALUE:
        return _err(403, "Missing request header. Reload the page and try again.")
    if (method, path) in PUBLIC:
        return await call_next(request)
    user = await run_in_threadpool(session_user, request.cookies.get(COOKIE))
    if not user:
        return _err(401, "Sign in required")
    if method not in SAFE_METHODS:
        if user["role"] == "viewer" and path not in VIEWER_WRITES:
            return _err(403, "Your account is read-only. Ask an admin for geologist access.")
        if _admin_only(method, path) and user["role"] != "admin":
            return _err(403, "Only admins can do that.")
    elif path.startswith("/api/users") and user["role"] != "admin":
        return _err(403, "Only admins can do that.")
    request.state.user = user
    return await call_next(request)


# ---------- org settings ----------

def get_setting(c, key: str, default: str = "") -> str:
    r = c.execute("SELECT value FROM app_setting WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_setting(c, key: str, value: str) -> None:
    if c.execute("SELECT 1 FROM app_setting WHERE key=?", (key,)).fetchone():
        c.execute("UPDATE app_setting SET value=? WHERE key=?", (value, key))
    else:
        c.execute("INSERT INTO app_setting (key, value) VALUES (?,?)", (key, value))


# ---------- auth endpoints ----------

class SetupIn(BaseModel):
    org_name: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)
    setup_token: Optional[str] = None


class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


def _norm_email(e: str) -> str:
    e = e.strip().lower()
    if not EMAIL_RE.match(e):
        raise HTTPException(422, "Enter a valid email address.")
    return e


@router.get("/api/auth/status")
def status(request: Request):
    with db.tx() as c:
        n = c.execute("SELECT COUNT(*) AS n FROM app_user").fetchone()["n"]
        org = get_setting(c, "org_name")
    user = session_user(request.cookies.get(COOKIE)) if n else None
    return {"setup_required": n == 0, "setup_token_required": n == 0 and SETUP_TOKEN is not None,
            "org_name": org, "user": user_out(user) if user else None}


@router.post("/api/auth/setup")
def setup(body: SetupIn, request: Request, response: Response):
    """First run only: name the organization and create the first admin."""
    if SETUP_TOKEN and not hmac.compare_digest((body.setup_token or "").strip(), SETUP_TOKEN):
        raise HTTPException(403, "Wrong setup token.")
    email = _norm_email(body.email)
    check_password_strength(body.password)
    pw_hash = hash_password(body.password)
    with db.tx() as c:
        if c.execute("SELECT COUNT(*) AS n FROM app_user").fetchone()["n"]:
            raise HTTPException(409, "This deployment is already set up. Sign in instead.")
        uid = db.new_id()
        t = db.now()
        c.execute("INSERT INTO app_user (id, email, name, password_hash, role, active, created_at, last_login_at) "
                  "VALUES (?,?,?,?,?,?,?,?)", (uid, email, body.name.strip(), pw_hash, "admin", 1, t, t))
        set_setting(c, "org_name", body.org_name.strip())
        token = create_session(c, uid, request.headers.get("user-agent", ""))
        u = db.get_or_404(c, "app_user", uid)
    _set_cookie(response, request, token)
    return {"user": user_out(u), "org_name": body.org_name.strip()}


@router.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    email = body.email.strip().lower()
    key = f"{request.client.host if request.client else '?'}|{email}"
    if _limited(key):
        raise HTTPException(429, "Too many failed sign-in attempts. Wait 15 minutes and try again.")
    with db.tx() as c:
        r = c.execute("SELECT * FROM app_user WHERE email=?", (email,)).fetchone()
        u = dict(r) if r else None
        ok = verify_password(body.password, u["password_hash"] if u else _DUMMY_HASH) and bool(u)
        if not ok or not u["active"]:
            _fail(key)
            # same message either way: don't reveal which emails have accounts
            raise HTTPException(401, "Email or password is incorrect, or the account is disabled.")
        c.execute("UPDATE app_user SET last_login_at=? WHERE id=?", (db.now(), u["id"]))
        token = create_session(c, u["id"], request.headers.get("user-agent", ""))
        org = get_setting(c, "org_name")
    _reset_fails(key)
    _set_cookie(response, request, token)
    return {"user": user_out(u), "org_name": org}


@router.post("/api/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db.tx() as c:
            c.execute("DELETE FROM user_session WHERE token_hash=?", (_hash_token(token),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def me(request: Request):
    return user_out(current_user(request))


@router.post("/api/auth/password")
def change_password(body: PasswordIn, request: Request, response: Response):
    u = current_user(request)
    if not verify_password(body.current_password, u["password_hash"]):
        raise HTTPException(403, "Current password is incorrect.")
    check_password_strength(body.new_password)
    with db.tx() as c:
        c.execute("UPDATE app_user SET password_hash=? WHERE id=?", (hash_password(body.new_password), u["id"]))
        revoke_sessions(c, u["id"])  # sign out everywhere else
        token = create_session(c, u["id"], request.headers.get("user-agent", ""))
    _set_cookie(response, request, token)
    return {"ok": True}


# ---------- organization ----------

class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.get("/api/org")
def get_org():
    with db.tx() as c:
        return {"name": get_setting(c, "org_name")}


@router.patch("/api/org")
def patch_org(body: OrgIn):
    with db.tx() as c:
        set_setting(c, "org_name", body.name.strip())
        return {"name": body.name.strip()}


# ---------- user admin (admins only; enforced in the middleware) ----------

class UserIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    name: str = Field(min_length=1, max_length=120)
    role: str = "geologist"
    password: str = Field(min_length=1, max_length=200)


class UserPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    role: Optional[str] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(None, max_length=200)


def _check_role(role: str) -> str:
    if role not in ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(ROLES)}")
    return role


def _active_admins(c, excluding: str | None = None) -> int:
    q, args = "SELECT COUNT(*) AS n FROM app_user WHERE role='admin' AND active=1", []
    if excluding:
        q += " AND id<>?"
        args.append(excluding)
    return c.execute(q, args).fetchone()["n"]


@router.get("/api/users")
def list_users():
    with db.tx() as c:
        return [user_out(dict(r)) for r in c.execute("SELECT * FROM app_user ORDER BY active DESC, name")]


@router.post("/api/users", status_code=201)
def create_user(body: UserIn):
    email = _norm_email(body.email)
    _check_role(body.role)
    check_password_strength(body.password)
    with db.tx() as c:
        if c.execute("SELECT 1 FROM app_user WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "A user with that email already exists.")
        uid = db.new_id()
        c.execute("INSERT INTO app_user (id, email, name, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,?)",
                  (uid, email, body.name.strip(), hash_password(body.password), body.role, 1, db.now()))
        return user_out(db.get_or_404(c, "app_user", uid))


@router.patch("/api/users/{uid}")
def update_user(uid: str, body: UserPatch, request: Request):
    me_ = current_user(request)
    with db.tx() as c:
        u = db.get_or_404(c, "app_user", uid)
        demoting = (body.role is not None and body.role != "admin") or body.active is False
        if u["role"] == "admin" and u["active"] and demoting and _active_admins(c, excluding=uid) == 0:
            raise HTTPException(409, "Keep at least one active admin.")
        if uid == me_["id"] and body.active is False:
            raise HTTPException(409, "You can't disable your own account.")
        if body.name is not None:
            c.execute("UPDATE app_user SET name=? WHERE id=?", (body.name.strip(), uid))
        if body.role is not None:
            c.execute("UPDATE app_user SET role=? WHERE id=?", (_check_role(body.role), uid))
        if body.active is not None:
            c.execute("UPDATE app_user SET active=? WHERE id=?", (int(body.active), uid))
        if body.password:
            check_password_strength(body.password)
            c.execute("UPDATE app_user SET password_hash=? WHERE id=?", (hash_password(body.password), uid))
        # Any change to access signs the user out, so it takes effect immediately.
        if (body.role is not None and body.role != u["role"]) or body.active is False or body.password:
            if uid != me_["id"]:
                revoke_sessions(c, uid)
        return user_out(db.get_or_404(c, "app_user", uid))


@router.delete("/api/users/{uid}", status_code=204)
def delete_user(uid: str, request: Request):
    me_ = current_user(request)
    if uid == me_["id"]:
        raise HTTPException(409, "You can't delete your own account.")
    with db.tx() as c:
        u = db.get_or_404(c, "app_user", uid)
        if u["role"] == "admin" and u["active"] and _active_admins(c, excluding=uid) == 0:
            raise HTTPException(409, "Keep at least one active admin.")
        c.execute("DELETE FROM app_user WHERE id=?", (uid,))  # sessions cascade; edits keep the user id
