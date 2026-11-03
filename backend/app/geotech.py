"""Geotechnical logging from core photos: core breaks, RQD, recovery and fracture frequency."""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import db
from .geo import CORE_DIAMETERS, geotech_for_image, point_depth

router = APIRouter()


class BreakIn(BaseModel):
    id: Optional[str] = None
    x: float = Field(ge=0, le=1000)
    y: float = Field(ge=0, le=1000)
    natural: bool = True
    source: str = "user"


def _breaks(c, iid: str) -> list[dict]:
    return [dict(b) | {"natural": bool(b["natural"])} for b in c.execute(
        "SELECT id, x, y, \"natural\", source, depth_m FROM core_break WHERE image_id=? ORDER BY depth_m", (iid,))]


def _image_geotech(c, img: dict) -> dict:
    hole = db.get_or_404(c, "hole", img["hole_id"])
    return geotech_for_image(img, db.effective_boxes(img), _breaks(c, img["id"]), hole.get("core_size") or "NQ")


@router.get("/api/core-sizes")
def core_sizes():
    return [{"size": k, "diameter_mm": v} for k, v in CORE_DIAMETERS.items()]


@router.put("/api/images/{iid}/breaks")
def put_breaks(iid: str, body: list[BreakIn]):
    """Replace an image's breaks with the editor's list. Depths are computed from the core rows."""
    with db.tx() as c:
        img = db.get_or_404(c, "core_image", iid)
        boxes = db.effective_boxes(img)
        c.execute("DELETE FROM core_break WHERE image_id=?", (iid,))
        for b in body:
            d = point_depth(img, (b.x, b.y), boxes)
            c.execute("INSERT INTO core_break (id, image_id, x, y, \"natural\", source, depth_m) VALUES (?,?,?,?,?,?,?)",
                      (b.id or db.new_id(), iid, round(b.x, 1), round(b.y, 1), int(b.natural),
                       b.source if b.source in ("ai", "user") else "user", round(d, 3) if d is not None else None))
        return {"breaks": _breaks(c, iid), "geotech": _image_geotech(c, img)}


@router.get("/api/images/{iid}/geotech")
def image_geotech(iid: str):
    with db.tx() as c:
        return _image_geotech(c, db.get_or_404(c, "core_image", iid))


def hole_geotech_data(c, hid: str) -> dict:
    hole = db.get_or_404(c, "hole", hid)
    runs = []
    for r in c.execute("SELECT * FROM core_image WHERE hole_id=? AND from_m IS NOT NULL AND to_m IS NOT NULL "
                       "ORDER BY from_m", (hid,)).fetchall():
        img = dict(r)
        g = _image_geotech(c, img)
        runs.append({"image_id": img["id"], "name": img["name"], "from_m": img["from_m"], "to_m": img["to_m"], **g})
    ok = [r for r in runs if r["rqd"] is not None]
    tot = sum(r["run_m"] for r in ok)
    summary = None
    if tot > 0:
        rec_m = sum(r["recovered_m"] for r in ok)
        summary = {"logged_m": round(tot, 2),
                   "rqd": round(sum(r["rqd"] * r["run_m"] for r in ok) / tot, 1),
                   "recovery": round(min(100.0, rec_m / tot * 100), 1),
                   "ff": round(sum(r["natural"] for r in ok) / max(1e-6, rec_m), 2),
                   "rock_quality": rock_quality(sum(r["rqd"] * r["run_m"] for r in ok) / tot)}
    return {"hole_id": hid, "core_size": hole.get("core_size") or "NQ", "runs": runs, "summary": summary}


def rock_quality(rqd: float) -> str:
    """Deere (1964) RQD classes."""
    return ("very poor" if rqd < 25 else "poor" if rqd < 50 else "fair" if rqd < 75
            else "good" if rqd < 90 else "excellent")


@router.get("/api/holes/{hid}/geotech")
def hole_geotech(hid: str):
    with db.tx() as c:
        return hole_geotech_data(c, hid)


def geotech_rows_for_export(c, pid: str) -> list[list]:
    out = []
    for h in c.execute("SELECT id, name, core_size FROM hole WHERE project_id=? ORDER BY created_at", (pid,)).fetchall():
        for r in hole_geotech_data(c, h["id"])["runs"]:
            out.append([h["name"], r["from_m"], r["to_m"], h["core_size"] or "NQ",
                        "" if r["rqd"] is None else r["rqd"], "" if r["recovery"] is None else r["recovery"],
                        "" if r["ff"] is None else r["ff"], r["natural"], r["mechanical"], r["pieces"],
                        r["px_per_mm"] or "", r["scale_source"] or "", "; ".join(r["warnings"])])
    return out
