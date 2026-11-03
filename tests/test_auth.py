"""Accounts, sessions, roles and request protections."""
from fastapi.testclient import TestClient

from app import auth
from app.main import app
from conftest import ADMIN, CSRF, signed_in_client


def anon() -> TestClient:
    c = TestClient(app, headers=CSRF)
    c.__enter__()
    return c


def test_password_hashing():
    h = auth.hash_password("a long passphrase 1")
    assert h.startswith("scrypt$") and "a long" not in h
    assert auth.verify_password("a long passphrase 1", h)
    assert not auth.verify_password("a long passphrase 2", h)
    assert not auth.verify_password("x", "garbage")


def test_api_requires_login(client):
    a = anon()
    assert a.get("/api/projects").status_code == 401
    assert a.get("/api/health").status_code == 200  # public, for health checks
    st = a.get("/api/auth/status").json()
    assert st["setup_required"] is False and st["user"] is None and st["org_name"] == "Test Org"
    assert client.get("/api/auth/status").json()["user"]["role"] == "admin"


def test_setup_only_once(client):
    r = anon().post("/api/auth/setup", json={"org_name": "Evil", "name": "x", "email": "x@x.io", "password": "another pass 99"})
    assert r.status_code == 409


def test_csrf_header_required(client):
    bare = TestClient(app)
    bare.__enter__()
    bare.cookies = client.cookies
    r = bare.post("/api/projects", json={"name": "no header"})
    assert r.status_code == 403
    assert client.post("/api/projects", json={"name": "with header"}).status_code == 201


def test_login_errors_and_rate_limit(client):
    a = anon()
    r1 = a.post("/api/auth/login", json={"email": ADMIN["email"], "password": "wrong password 1"})
    r2 = a.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong password 1"})
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"] == r2.json()["detail"]  # does not reveal which emails exist
    for _ in range(auth.MAX_FAILS):
        a.post("/api/auth/login", json={"email": "victim@example.com", "password": "nope nope nope"})
    assert a.post("/api/auth/login", json={"email": "victim@example.com", "password": "nope nope nope"}).status_code == 429


def test_roles_and_user_admin(client):
    # admin creates a geologist and a viewer
    weak = client.post("/api/users", json={"email": "g@example.com", "name": "Geo", "role": "geologist", "password": "short"})
    assert weak.status_code == 422
    g = client.post("/api/users", json={"email": "G@Example.com", "name": "Geo", "role": "geologist",
                                        "password": "geologist pass 1"}).json()
    assert g["email"] == "g@example.com"
    assert client.post("/api/users", json={"email": "g@example.com", "name": "Dup", "role": "viewer",
                                           "password": "geologist pass 1"}).status_code == 409
    v = client.post("/api/users", json={"email": "v@example.com", "name": "View", "role": "viewer",
                                        "password": "viewer pass 12"}).json()

    geo = signed_in_client("g@example.com", "geologist pass 1")
    p = geo.post("/api/projects", json={"name": "Geo project"})
    assert p.status_code == 201
    assert geo.get("/api/users").status_code == 403                       # no user admin
    assert geo.delete(f"/api/projects/{p.json()['id']}").status_code == 403  # admins delete projects
    assert geo.patch("/api/org", json={"name": "x"}).status_code == 403

    view = signed_in_client("v@example.com", "viewer pass 12")
    assert view.get("/api/projects").status_code == 200
    assert view.post("/api/projects", json={"name": "nope"}).status_code == 403
    assert view.get(f"/api/projects/{p.json()['id']}/export/collars.csv").status_code == 200
    # viewers can still change their own password
    assert view.post("/api/auth/password", json={"current_password": "viewer pass 12",
                                                 "new_password": "viewer pass 34"}).status_code == 200

    # promoting / disabling signs the user out immediately
    client.patch(f"/api/users/{v['id']}", json={"role": "geologist"})
    assert view.get("/api/projects").status_code == 401
    client.patch(f"/api/users/{g['id']}", json={"active": False})
    assert geo.get("/api/projects").status_code == 401
    assert anon().post("/api/auth/login", json={"email": "g@example.com", "password": "geologist pass 1"}).status_code == 401

    # admin password reset
    client.patch(f"/api/users/{g['id']}", json={"active": True, "password": "reset by admin 1"})
    signed_in_client("g@example.com", "reset by admin 1")

    # can't remove the last admin, or yourself
    me = client.get("/api/auth/me").json()
    assert client.patch(f"/api/users/{me['id']}", json={"role": "viewer"}).status_code == 409
    assert client.delete(f"/api/users/{me['id']}").status_code == 409
    assert client.delete(f"/api/users/{v['id']}").status_code == 204
    assert client.delete(f"/api/projects/{p.json()['id']}").status_code == 204


def test_logout_and_audit(client):
    c = signed_in_client(ADMIN["email"], ADMIN["password"])
    p = c.post("/api/projects", json={"name": "Audit"}).json()
    h = c.post(f"/api/projects/{p['id']}/holes", json={"name": "A-1"}).json()
    import io
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (200, 100)).save(b, "JPEG")
    im = c.post(f"/api/holes/{h['id']}/images", files={"file": ("a.jpg", b.getvalue(), "image/jpeg")},
                data={"analyze": "false"}).json()
    c.put(f"/api/images/{im['id']}/features", json=[{"id": "fa1", "label": "py", "category": "mineralization",
                                                     "pts": [[1, 1], [5, 1], [5, 5]]}])
    me = c.get("/api/auth/me").json()
    assert c.get(f"/api/images/{im['id']}/history").json()[0]["user_id"] == me["id"]
    assert c.get(f"/api/images/{im['id']}").json()["uploaded_by"] == me["id"]
    assert c.post("/api/auth/logout").status_code == 200
    assert c.get("/api/projects").status_code == 401
