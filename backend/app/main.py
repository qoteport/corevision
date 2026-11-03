"""Core Vision API: projects, holes, surveys, core images, AI logging, features, 3D model and exports."""
import csv
import io
import json
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

from . import ai, assays, auth, config, db, geotech, intervals
from .storage import store
from .geo import CATEGORIES, CORE_DIAMETERS, OPEN_CATEGORIES, desurvey, feature_depth, point_depth

@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield
    db.close()


app = FastAPI(title="Core Vision", version="0.3.0", lifespan=lifespan)
app.middleware("http")(auth.auth_middleware)
app.include_router(auth.router)
app.include_router(intervals.router)
app.include_router(assays.router)
app.include_router(geotech.router)


# ---------- models ----------

class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    deposit_style: str = ""
    crs_epsg: Optional[int] = None


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    deposit_style: Optional[str] = None
    crs_epsg: Optional[int] = None


class HoleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    x: float = 0
    y: float = 0
    z: float = 0
    azimuth: float = 0
    dip: float = Field(60, ge=-90, le=90)
    length: float = Field(100, gt=0)
    core_size: str = "NQ"


class HolePatch(BaseModel):
    name: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    azimuth: Optional[float] = None
    dip: Optional[float] = Field(None, ge=-90, le=90)
    length: Optional[float] = Field(None, gt=0)
    core_size: Optional[str] = None


def _check_core_size(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip().upper()
    if v not in CORE_DIAMETERS:
        raise HTTPException(422, f"core_size must be one of {', '.join(CORE_DIAMETERS)}")
    return v


class SurveyIn(BaseModel):
    depth: float = Field(ge=0)
    azimuth: float
    dip: float = Field(ge=-90, le=90)


class ImagePatch(BaseModel):
    from_m: Optional[float] = None
    to_m: Optional[float] = None
    direction: Optional[str] = None
    clear_from: bool = False
    clear_to: bool = False
    core_boxes: Optional[list[list[float]]] = None  # manual core rows [x0,y0,x1,y1] 0-1000
    clear_boxes: bool = False
    scale_px_per_mm: Optional[float] = Field(None, gt=0)
    clear_scale: bool = False


class FeatureIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    label: str = "feature"
    category: str
    confidence: int = Field(100, ge=0, le=100)
    closed: bool = True
    pts: list[list[float]]
    source: str = "user"
    verified: bool = False


# ---------- helpers ----------

_get = db.get_or_404
_boxes = db.effective_boxes


def _recompute_depths(c, image: dict) -> None:
    """Recompute feature and break depths after the run, direction or core rows change."""
    boxes = _boxes(image)
    for f in c.execute("SELECT id, pts FROM feature WHERE image_id=?", (image["id"],)).fetchall():
        d = feature_depth(image, json.loads(f["pts"]), boxes)
        c.execute("UPDATE feature SET from_m=?, to_m=? WHERE id=?",
                  (d[0] if d else None, d[1] if d else None, f["id"]))
    for b in c.execute("SELECT id, x, y FROM core_break WHERE image_id=?", (image["id"],)).fetchall():
        d = point_depth(image, (b["x"], b["y"]), boxes)
        c.execute("UPDATE core_break SET depth_m=? WHERE id=?", (round(d, 3) if d is not None else None, b["id"]))


def _image_full(c, image_id: str) -> dict:
    img = db.image_out(c.execute("SELECT * FROM core_image WHERE id=?", (image_id,)).fetchone())
    img["features"] = [db.feature_out(f) for f in c.execute(
        "SELECT * FROM feature WHERE image_id=? ORDER BY created_at", (image_id,))]
    img["breaks"] = [dict(b) | {"natural": bool(b["natural"])} for b in c.execute(
        "SELECT id, x, y, \"natural\", source, depth_m FROM core_break WHERE image_id=? ORDER BY depth_m", (image_id,))]
    return img


def _project_tree(c, pid: str) -> dict:
    p = _get(c, "project", pid)
    holes = [dict(h) for h in c.execute("SELECT * FROM hole WHERE project_id=? ORDER BY created_at", (pid,))]
    for h in holes:
        h["surveys"] = [dict(s) for s in c.execute(
            "SELECT depth, azimuth, dip FROM survey WHERE hole_id=? ORDER BY depth", (h["id"],))]
        h["images"] = [_image_full(c, r["id"]) for r in c.execute(
            "SELECT id FROM core_image WHERE hole_id=? ORDER BY from_m IS NULL, from_m, created_at", (h["id"],))]
    p["holes"] = holes
    return p


def _clean_pts(pts) -> list:
    return [[round(min(1000.0, max(0.0, float(p[0]))), 1), round(min(1000.0, max(0.0, float(p[1]))), 1)]
            for p in pts if len(p) == 2]


# ---------- health ----------

@app.get("/api/health")
def health():
    return {"ok": True, "ai_configured": config.ai_configured(), "model": config.MODEL, "effort": config.EFFORT,
            "database": "postgres" if db.IS_PG else "sqlite", "storage": store().kind,
            "categories": CATEGORIES, "deposit_styles": list(ai.DEPOSIT_HINTS), "core_sizes": CORE_DIAMETERS}


# ---------- projects ----------

@app.get("/api/projects")
def list_projects():
    with db.tx() as c:
        return [dict(r) for r in c.execute(
            "SELECT p.*, (SELECT COUNT(*) FROM hole h WHERE h.project_id=p.id) AS holes "
            "FROM project p ORDER BY created_at")]


@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn):
    pid = db.new_id()
    with db.tx() as c:
        c.execute("INSERT INTO project VALUES (?,?,?,?,?)",
                  (pid, body.name.strip(), body.deposit_style, body.crs_epsg, db.now()))
        return _project_tree(c, pid)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    with db.tx() as c:
        return _project_tree(c, pid)


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch):
    with db.tx() as c:
        _get(c, "project", pid)
        for k, v in body.model_dump(exclude_none=True).items():
            c.execute(f"UPDATE project SET {k}=? WHERE id=?", (v, pid))
        return dict(_get(c, "project", pid))


@app.delete("/api/projects/{pid}", status_code=204)
def delete_project(pid: str):
    with db.tx() as c:
        keys = [r["storage_key"] for r in c.execute(
            "SELECT i.storage_key FROM core_image i JOIN hole h ON h.id=i.hole_id WHERE h.project_id=?", (pid,))]
        c.execute("DELETE FROM project WHERE id=?", (pid,))
    for k in keys:
        store().delete(k)


# ---------- holes & surveys ----------

@app.post("/api/projects/{pid}/holes", status_code=201)
def create_hole(pid: str, body: HoleIn):
    hid = db.new_id()
    with db.tx() as c:
        _get(c, "project", pid)
        c.execute("INSERT INTO hole (id, project_id, name, x, y, z, azimuth, dip, length, core_size, created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (hid, pid, body.name.strip(), body.x, body.y, body.z, body.azimuth % 360, body.dip,
                   body.length, _check_core_size(body.core_size), db.now()))
        return dict(_get(c, "hole", hid)) | {"surveys": [], "images": []}


@app.patch("/api/holes/{hid}")
def patch_hole(hid: str, body: HolePatch):
    with db.tx() as c:
        _get(c, "hole", hid)
        for k, v in body.model_dump(exclude_none=True).items():
            if k == "core_size":
                v = _check_core_size(v)
            c.execute(f"UPDATE hole SET {k}=? WHERE id=?", (v % 360 if k == "azimuth" else v, hid))
        return dict(_get(c, "hole", hid))


@app.delete("/api/holes/{hid}", status_code=204)
def delete_hole(hid: str):
    with db.tx() as c:
        keys = [r["storage_key"] for r in c.execute("SELECT storage_key FROM core_image WHERE hole_id=?", (hid,))]
        c.execute("DELETE FROM hole WHERE id=?", (hid,))
    for k in keys:
        store().delete(k)


@app.put("/api/holes/{hid}/surveys")
def put_surveys(hid: str, body: list[SurveyIn]):
    with db.tx() as c:
        _get(c, "hole", hid)
        c.execute("DELETE FROM survey WHERE hole_id=?", (hid,))
        c.executemany("INSERT INTO survey (hole_id, depth, azimuth, dip) VALUES (?,?,?,?)",
                      [(hid, s.depth, s.azimuth % 360, s.dip) for s in sorted(body, key=lambda s: s.depth)])
        return [dict(s) for s in c.execute(
            "SELECT depth, azimuth, dip FROM survey WHERE hole_id=? ORDER BY depth", (hid,))]


def _read_csv(data: bytes) -> list[dict]:
    text = data.decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()} for r in rows]


def _pick(r: dict, *names, default=None):
    for n in names:
        if r.get(n) not in (None, ""):
            return r[n]
    return default


@app.post("/api/projects/{pid}/import/collars")
async def import_collars(pid: str, file: UploadFile = File(...)):
    """CSV columns: hole, easting, northing, rl, azimuth, dip, length (common aliases accepted).
    Existing holes with the same name are updated."""
    rows = _read_csv(await file.read())
    created = updated = 0
    errors = []
    with db.tx() as c:
        _get(c, "project", pid)
        for i, r in enumerate(rows, start=2):
            name = _pick(r, "hole", "hole_id", "holeid", "name")
            try:
                vals = dict(
                    x=float(_pick(r, "easting", "east", "x", default=0)),
                    y=float(_pick(r, "northing", "north", "y", default=0)),
                    z=float(_pick(r, "rl", "elevation", "z", default=0)),
                    azimuth=float(_pick(r, "azimuth", "azi", "az", default=0)) % 360,
                    dip=float(_pick(r, "dip", default=90)),
                    length=float(_pick(r, "length", "depth", "eoh", "max_depth", default=100)),
                )
            except ValueError:
                errors.append(f"row {i}: non-numeric value")
                continue
            if not name:
                errors.append(f"row {i}: missing hole name")
                continue
            size = (_pick(r, "core_size", "size", "core", default="NQ") or "NQ").upper()
            vals["core_size"] = size if size in CORE_DIAMETERS else "NQ"
            ex = c.execute("SELECT id FROM hole WHERE project_id=? AND name=?", (pid, name)).fetchone()
            if ex:
                c.execute("UPDATE hole SET x=?, y=?, z=?, azimuth=?, dip=?, length=?, core_size=? WHERE id=?",
                          (*vals.values(), ex["id"]))
                updated += 1
            else:
                c.execute("INSERT INTO hole (id, project_id, name, x, y, z, azimuth, dip, length, core_size, created_at) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?,?)", (db.new_id(), pid, name, *vals.values(), db.now()))
                created += 1
    return {"created": created, "updated": updated, "errors": errors}


@app.post("/api/projects/{pid}/import/surveys")
async def import_surveys(pid: str, file: UploadFile = File(...)):
    """CSV columns: hole, depth, azimuth, dip. Replaces the survey of every hole listed."""
    rows = _read_csv(await file.read())
    by_hole: dict[str, list] = {}
    errors = []
    for i, r in enumerate(rows, start=2):
        name = _pick(r, "hole", "hole_id", "holeid", "name")
        try:
            by_hole.setdefault(name, []).append((float(_pick(r, "depth", "at", "md")),
                                                 float(_pick(r, "azimuth", "azi", "az")) % 360,
                                                 float(_pick(r, "dip"))))
        except (TypeError, ValueError):
            errors.append(f"row {i}: missing or non-numeric value")
    done = 0
    with db.tx() as c:
        _get(c, "project", pid)
        for name, st in by_hole.items():
            h = c.execute("SELECT id FROM hole WHERE project_id=? AND name=?", (pid, name)).fetchone()
            if not h:
                errors.append(f"hole {name}: not found, import collars first")
                continue
            c.execute("DELETE FROM survey WHERE hole_id=?", (h["id"],))
            c.executemany("INSERT INTO survey (hole_id, depth, azimuth, dip) VALUES (?,?,?,?)",
                          [(h["id"], *s) for s in sorted(st)])
            done += 1
    return {"holes": done, "errors": errors}


# ---------- core images ----------

@app.post("/api/holes/{hid}/images", status_code=201)
async def upload_image(hid: str, background: BackgroundTasks, request: Request, file: UploadFile = File(...),
                       from_m: Optional[float] = Form(None), to_m: Optional[float] = Form(None),
                       direction: str = Form("lr"), analyze: bool = Form(True)):
    if direction not in ("lr", "rl", "tb", "bt"):
        raise HTTPException(422, "direction must be lr, rl, tb or bt")
    if from_m is not None and to_m is not None and to_m <= from_m:
        raise HTTPException(422, "to_m must be greater than from_m")
    raw = await file.read()
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(422, "Not a readable image")
    im.thumbnail((config.MAX_EDGE_PX, config.MAX_EDGE_PX), Image.LANCZOS)
    iid = db.new_id()
    key = f"{iid}.jpg"
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    store().put(key, buf.getvalue(), "image/jpeg")
    with db.tx() as c:
        _get(c, "hole", hid)
        c.execute("INSERT INTO core_image (id, hole_id, name, from_m, to_m, direction, storage_key, width_px, "
                  "height_px, status, status_at, created_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (iid, hid, file.filename or key, from_m, to_m, direction, key, im.width, im.height,
                   "queued" if analyze else "new", db.now(), db.now(), auth.current_user(request)["id"]))
        out = _image_full(c, iid)
    if analyze:
        background.add_task(run_analysis, iid)
    return out


@app.get("/api/images/{iid}")
def get_image(iid: str):
    with db.tx() as c:
        img = _get(c, "core_image", iid)
        if img["status"] in ("queued", "analyzing"):
            db.fail_stale_jobs(c)  # the instance running it may have stopped
        return _image_full(c, iid)


@app.get("/api/images/{iid}/file")
def image_file(iid: str):
    with db.tx() as c:
        img = _get(c, "core_image", iid)
    data = store().get(img["storage_key"])
    if data is None:
        raise HTTPException(404, "file missing")
    # keys are unique per upload, so the bytes never change
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400, immutable"})


@app.patch("/api/images/{iid}")
def patch_image(iid: str, body: ImagePatch):
    if body.direction is not None and body.direction not in ("lr", "rl", "tb", "bt"):
        raise HTTPException(422, "bad direction")
    with db.tx() as c:
        img = _get(c, "core_image", iid)
        for k in ("from_m", "to_m", "direction"):
            v = getattr(body, k)
            if v is not None:
                img[k] = v
        if body.clear_from:
            img["from_m"] = None
        if body.clear_to:
            img["to_m"] = None
        if img["from_m"] is not None and img["to_m"] is not None and img["to_m"] <= img["from_m"]:
            raise HTTPException(422, "to_m must be greater than from_m")
        if body.core_boxes is not None:
            boxes = [[round(min(1000.0, max(0.0, v)), 1) for v in b] for b in body.core_boxes if len(b) == 4]
            img["core_boxes"] = json.dumps(boxes) if boxes else None
        if body.clear_boxes:
            img["core_boxes"] = None
        if body.scale_px_per_mm is not None:
            img["scale_px_per_mm"] = body.scale_px_per_mm
        if body.clear_scale:
            img["scale_px_per_mm"] = None
        c.execute("UPDATE core_image SET from_m=?, to_m=?, direction=?, core_boxes=?, scale_px_per_mm=? WHERE id=?",
                  (img["from_m"], img["to_m"], img["direction"], img["core_boxes"], img["scale_px_per_mm"], iid))
        _recompute_depths(c, img)
        return _image_full(c, iid)


@app.delete("/api/images/{iid}", status_code=204)
def delete_image(iid: str):
    with db.tx() as c:
        img = _get(c, "core_image", iid)
        c.execute("DELETE FROM core_image WHERE id=?", (iid,))
    store().delete(img["storage_key"])


@app.post("/api/images/{iid}/analyze", status_code=202)
def analyze(iid: str, background: BackgroundTasks):
    with db.tx() as c:
        img = _get(c, "core_image", iid)
        if img["status"] in ("queued", "analyzing"):
            return _image_full(c, iid)
        c.execute("UPDATE core_image SET status='queued', status_at=?, error=NULL WHERE id=?", (db.now(), iid))
        out = _image_full(c, iid)
    background.add_task(run_analysis, iid)
    return out


def run_analysis(iid: str) -> None:
    """Background job. Replaces unverified AI features; never touches user-drawn or verified ones."""
    with db.tx() as c:
        img = db.row(c.execute("SELECT * FROM core_image WHERE id=?", (iid,)).fetchone())
        if not img:
            return
        hole = dict(_get(c, "hole", img["hole_id"]))
        project = dict(_get(c, "project", hole["project_id"]))
        codes = [dict(r) for r in c.execute(
            "SELECT field, code, description FROM logging_code WHERE project_id=? ORDER BY field, code", (project["id"],))]
        c.execute("UPDATE core_image SET status='analyzing', status_at=?, error=NULL WHERE id=?", (db.now(), iid))
    if not config.ai_configured():
        with db.tx() as c:
            c.execute("UPDATE core_image SET status='error', error=? WHERE id=?",
                      ("No ANTHROPIC_API_KEY set on the server. Add it to .env and restart.", iid))
        return
    try:
        jpeg = store().get(img["storage_key"])
        if jpeg is None:
            raise OSError("Photo file is missing from storage.")
        log, model = ai.analyze_image(jpeg, ai.build_context(project, hole, img, codes))
    except (ai.AnalysisError, OSError) as e:
        with db.tx() as c:
            c.execute("UPDATE core_image SET status='error', error=? WHERE id=?", (str(e), iid))
        return
    analysis = log.model_dump()
    analysis.pop("annotations", None)
    analysis.pop("breaks", None)
    feats = ai.clean_annotations(log)
    breaks = ai.clean_breaks(log)
    with db.tx() as c:
        img["analysis"] = analysis
        c.execute("UPDATE core_image SET status='done', error=NULL, analysis=?, model=? WHERE id=?",
                  (json.dumps(analysis), model, iid))
        c.execute("DELETE FROM feature WHERE image_id=? AND source='ai' AND verified=0", (iid,))
        boxes = _boxes(img)
        # AI breaks are replaced on re-analysis; breaks the geologist placed are kept.
        c.execute("DELETE FROM core_break WHERE image_id=? AND source='ai'", (iid,))
        for b in breaks:
            c.execute("INSERT INTO core_break (id, image_id, x, y, \"natural\", source) VALUES (?,?,?,?,?,?)",
                      (db.new_id(), iid, b["x"], b["y"], int(b["natural"]), "ai"))
        t = db.now()
        for i, f in enumerate(feats):
            d = feature_depth(img, f["pts"], boxes)
            c.execute("INSERT INTO feature (id, image_id, label, category, confidence, closed, pts, from_m, to_m, "
                      "source, verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (db.new_id(), iid, f["label"], f["category"], f["confidence"], int(f["closed"]),
                       json.dumps(f["pts"]), d[0] if d else None, d[1] if d else None, "ai", 0, t + i * 1e-3, t))
        _recompute_depths(c, img)


# ---------- features (editor sync with audit trail) ----------

@app.put("/api/images/{iid}/features")
def sync_features(iid: str, body: list[FeatureIn], request: Request):
    """Replace the image's feature list with the editor's state. Every change is logged in edit_event."""
    uid = auth.current_user(request)["id"]
    with db.tx() as c:
        img = _get(c, "core_image", iid)
        boxes = _boxes(img)
        existing = {r["id"]: db.feature_out(r) for r in c.execute("SELECT * FROM feature WHERE image_id=?", (iid,))}
        seen = set()
        t = db.now()
        for i, f in enumerate(body):
            if f.category not in CATEGORIES:
                raise HTTPException(422, f"unknown category {f.category}")
            pts = _clean_pts(f.pts)
            if len(pts) < 2:
                continue
            closed = f.closed and f.category not in OPEN_CATEGORIES and len(pts) >= 3
            d = feature_depth(img, pts, boxes)
            new = {"label": f.label[:80], "category": f.category, "confidence": f.confidence, "closed": closed,
                   "pts": pts, "verified": f.verified}
            seen.add(f.id)
            old = existing.get(f.id)
            if old:
                before = {k: old[k] for k in new}
                if before == new:
                    continue
                c.execute("UPDATE feature SET label=?, category=?, confidence=?, closed=?, pts=?, from_m=?, to_m=?, "
                          "verified=?, updated_at=? WHERE id=?",
                          (new["label"], new["category"], new["confidence"], int(closed), json.dumps(pts),
                           d[0] if d else None, d[1] if d else None, int(f.verified), t, f.id))
                c.execute("INSERT INTO edit_event (feature_id, image_id, action, before, after, ts, user_id) "
                          "VALUES (?,?,?,?,?,?,?)", (f.id, iid, "update", json.dumps(before), json.dumps(new), t, uid))
            else:
                if c.execute("SELECT 1 FROM feature WHERE id=?", (f.id,)).fetchone():
                    raise HTTPException(409, "feature id belongs to another image")
                source = f.source if f.source in ("ai", "user", "sam") else "user"
                c.execute("INSERT INTO feature (id, image_id, label, category, confidence, closed, pts, from_m, to_m, "
                          "source, verified, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (f.id, iid, new["label"], f.category, f.confidence, int(closed), json.dumps(pts),
                           d[0] if d else None, d[1] if d else None, source, int(f.verified), t + i * 1e-3, t))
                c.execute("INSERT INTO edit_event (feature_id, image_id, action, before, after, ts, user_id) "
                          "VALUES (?,?,?,?,?,?,?)", (f.id, iid, "create", None, json.dumps(new), t, uid))
        for fid, old in existing.items():
            if fid not in seen:
                c.execute("DELETE FROM feature WHERE id=?", (fid,))
                c.execute("INSERT INTO edit_event (feature_id, image_id, action, before, after, ts, user_id) "
                          "VALUES (?,?,?,?,?,?,?)", (fid, iid, "delete", json.dumps(old), None, t, uid))
        return _image_full(c, iid)["features"]


@app.get("/api/images/{iid}/history")
def feature_history(iid: str, limit: int = 100):
    with db.tx() as c:
        return [dict(r) | {"before": json.loads(r["before"]) if r["before"] else None,
                           "after": json.loads(r["after"]) if r["after"] else None}
                for r in c.execute("SELECT * FROM edit_event WHERE image_id=? ORDER BY ts DESC LIMIT ?", (iid, limit))]


# ---------- 3D model ----------

@app.get("/api/projects/{pid}/model")
def model3d(pid: str):
    """Desurveyed hole paths (minimum curvature) plus every logged interval, for the 3D view."""
    with db.tx() as c:
        tree = _project_tree(c, pid)
        assay_rows: dict[str, list] = {}
        for r in c.execute("SELECT a.hole_id, a.from_m, a.to_m, a.element, a.value, a.unit FROM assay a "
                           "JOIN hole h ON h.id=a.hole_id WHERE h.project_id=? ORDER BY a.from_m", (pid,)):
            assay_rows.setdefault(r["hole_id"], []).append(
                {"from_m": r["from_m"], "to_m": r["to_m"], "element": r["element"], "value": r["value"], "unit": r["unit"]})
    holes = []
    for h in tree["holes"]:
        intervals = []
        for im in h["images"]:
            for f in im["features"]:
                if f["from_m"] is None:
                    continue
                intervals.append({"id": f["id"], "label": f["label"], "category": f["category"],
                                  "confidence": f["confidence"], "from_m": f["from_m"], "to_m": f["to_m"],
                                  "verified": f["verified"], "source": f["source"]})
        holes.append({"id": h["id"], "name": h["name"], "x": h["x"], "y": h["y"], "z": h["z"],
                      "azimuth": h["azimuth"], "dip": h["dip"], "length": h["length"],
                      "surveyed": bool(h["surveys"]), "path": desurvey(h, h["surveys"]), "intervals": intervals,
                      "assays": assay_rows.get(h["id"], [])})
    return {"project": {"id": tree["id"], "name": tree["name"]}, "holes": holes}


# ---------- exports ----------

def _csv(rows: list[list], header: list[str], filename: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _safe(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name) or "project"


@app.get("/api/projects/{pid}/export/intervals.csv")
def export_intervals(pid: str):
    with db.tx() as c:
        p = _project_tree(c, pid)
    rows = []
    for h in p["holes"]:
        for im in h["images"]:
            for f in sorted(im["features"], key=lambda f: (f["from_m"] is None, f["from_m"] or 0)):
                rows.append([p["name"], h["name"], h["x"], h["y"], h["z"], h["azimuth"], h["dip"],
                             f["from_m"] if f["from_m"] is not None else "", f["to_m"] if f["to_m"] is not None else "",
                             f["label"], f["category"], f["confidence"], f["source"], int(f["verified"]), im["name"]])
    return _csv(rows, ["project", "hole", "easting", "northing", "rl", "azimuth", "dip", "from_m", "to_m", "label",
                       "category", "confidence", "source", "verified", "image"], f"{_safe(p['name'])}-intervals.csv")


@app.get("/api/projects/{pid}/export/collars.csv")
def export_collars(pid: str):
    with db.tx() as c:
        p = _project_tree(c, pid)
    rows = [[h["name"], h["x"], h["y"], h["z"], h["azimuth"], h["dip"], h["length"], h.get("core_size") or "NQ"] for h in p["holes"]]
    return _csv(rows, ["hole", "easting", "northing", "rl", "azimuth", "dip", "length", "core_size"],
                f"{_safe(p['name'])}-collars.csv")


@app.get("/api/projects/{pid}/export/surveys.csv")
def export_surveys(pid: str):
    with db.tx() as c:
        p = _project_tree(c, pid)
    rows = [[h["name"], s["depth"], s["azimuth"], s["dip"]] for h in p["holes"] for s in h["surveys"]]
    return _csv(rows, ["hole", "depth", "azimuth", "dip"], f"{_safe(p['name'])}-surveys.csv")


@app.get("/api/projects/{pid}/export/lithlog.csv")
def export_lithlog(pid: str):
    """The interval log in the from/to table format Leapfrog, Micromine and acQuire import."""
    with db.tx() as c:
        p = _get(c, "project", pid)
        rows = intervals.interval_rows_for_export(c, pid)
    return _csv(rows, ["hole", "from_m", "to_m", "lithology", "alteration", "alteration_intensity", "mineralization",
                       "sulphide_pct", "vein_pct", "comments", "source"], f"{_safe(p['name'])}-lithlog.csv")


@app.get("/api/projects/{pid}/export/assays.csv")
def export_assays(pid: str):
    with db.tx() as c:
        p = _get(c, "project", pid)
        rows = assays.assay_rows_for_export(c, pid)
    return _csv(rows, ["hole", "sample_id", "from_m", "to_m", "element", "value", "unit", "below_detection"],
                f"{_safe(p['name'])}-assays.csv")


@app.get("/api/projects/{pid}/export/geotech.csv")
def export_geotech(pid: str):
    with db.tx() as c:
        p = _get(c, "project", pid)
        rows = geotech.geotech_rows_for_export(c, pid)
    return _csv(rows, ["hole", "from_m", "to_m", "core_size", "rqd_pct", "recovery_pct", "ff_per_m", "natural_breaks",
                       "mechanical_breaks", "pieces", "px_per_mm", "scale_source", "warnings"],
                f"{_safe(p['name'])}-geotech.csv")


@app.get("/api/projects/{pid}/export/project.json")
def export_json(pid: str):
    with db.tx() as c:
        p = _project_tree(c, pid)
    return JSONResponse(p, headers={"Content-Disposition": f'attachment; filename="{_safe(p["name"])}.json"'})


# ---------- frontend ----------

if (config.FRONTEND_DIR / "index.html").exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
else:
    @app.get("/", include_in_schema=False)
    def _no_build():
        return Response(
            "<h3>Core Vision API is running.</h3><p>The frontend is not built yet. Run "
            "<code>npm install</code> and <code>npm run build</code> in <code>frontend/</code>, "
            "or use the dev server: <code>npm run dev</code> and open http://localhost:5173.</p>",
            media_type="text/html")
