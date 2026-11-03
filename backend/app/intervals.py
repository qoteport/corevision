"""Interval log (the from-to downhole log geologists export) and per-project logging codes."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db

router = APIRouter()
FIELDS = ("lithology", "alteration", "mineralization")

DEFAULT_CODES: dict[str, list[tuple[str, str]]] = {
    "lithology": [("GRAN", "granite"), ("GDI", "granodiorite"), ("DIOR", "diorite"), ("PORP", "porphyry"),
                  ("AND", "andesite"), ("BAS", "basalt"), ("DOL", "dolerite"), ("UM", "ultramafic"),
                  ("SST", "sandstone"), ("SLT", "siltstone"), ("SH", "shale"), ("QTZT", "quartzite"),
                  ("LST", "limestone"), ("SCH", "schist"), ("GN", "gneiss"), ("PEG", "pegmatite"),
                  ("BIF", "banded iron formation"), ("BX", "breccia"), ("MSU", "massive sulphide"),
                  ("FLT", "fault rock"), ("QV", "quartz vein")],
    "alteration": [("POT", "potassic"), ("PHY", "phyllic"), ("SER", "sericite"), ("PRO", "propylitic"),
                   ("CHL", "chlorite"), ("EP", "epidote"), ("ARG", "argillic"), ("AARG", "advanced argillic"),
                   ("SIL", "silicification"), ("CARB", "carbonate"), ("ALB", "albite"), ("HEM", "hematite"),
                   ("SERP", "serpentinite"), ("TALC", "talc"), ("FRSH", "fresh")],
    "mineralization": [("PY", "pyrite"), ("CPY", "chalcopyrite"), ("BN", "bornite"), ("CC", "chalcocite"),
                       ("MO", "molybdenite"), ("SPH", "sphalerite"), ("GAL", "galena"), ("ASP", "arsenopyrite"),
                       ("PO", "pyrrhotite"), ("PN", "pentlandite"), ("VG", "visible gold"),
                       ("MAG", "magnetite"), ("HEM", "hematite"), ("SPOD", "spodumene"), ("LEP", "lepidolite")],
}


class CodeIn(BaseModel):
    field: str
    code: str = Field(min_length=1, max_length=16)
    description: str = ""


class IntervalIn(BaseModel):
    id: Optional[str] = None
    from_m: float = Field(ge=0)
    to_m: float = Field(gt=0)
    lithology: str = ""
    alteration: str = ""
    alteration_intensity: int = Field(0, ge=0, le=3)
    mineralization: str = ""
    sulphide_pct: float = Field(0, ge=0, le=100)
    vein_pct: float = Field(0, ge=0, le=100)
    comments: str = ""
    source: str = "user"


# ---------- codes ----------

@router.get("/api/codes/defaults")
def default_codes():
    return [{"field": f, "code": c, "description": d} for f, items in DEFAULT_CODES.items() for c, d in items]


@router.get("/api/projects/{pid}/codes")
def get_codes(pid: str):
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        return _codes(c, pid)


@router.put("/api/projects/{pid}/codes")
def put_codes(pid: str, body: list[CodeIn]):
    seen = set()
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        c.execute("DELETE FROM logging_code WHERE project_id=?", (pid,))
        for x in body:
            if x.field not in FIELDS:
                raise HTTPException(422, f"field must be one of {', '.join(FIELDS)}")
            key = (x.field, x.code.strip().upper())
            if key in seen:
                continue
            seen.add(key)
            c.execute("INSERT INTO logging_code (project_id, field, code, description) VALUES (?,?,?,?)",
                      (pid, x.field, key[1], x.description.strip()))
        return _codes(c, pid)


def _codes(c, pid: str) -> list[dict]:
    return [dict(r) for r in c.execute(
        "SELECT field, code, description FROM logging_code WHERE project_id=? ORDER BY field, code", (pid,))]


def map_label(label: str, codes: list[dict]) -> str:
    """Normalise a free-text label to a project code when one clearly matches."""
    s = (label or "").strip()
    if not s or not codes:
        return s
    low = s.lower()
    first = low.split()[0].strip(",;:")
    for cd in codes:
        if cd["code"].lower() == first:
            return cd["code"]
    for cd in codes:
        d = (cd.get("description") or "").lower()
        if d and (d in low or low in d):
            return cd["code"]
    return s


# ---------- interval log ----------

def _hole_data(c, hid: str):
    hole = db.get_or_404(c, "hole", hid)
    images = [db.image_out(r) for r in c.execute(
        "SELECT * FROM core_image WHERE hole_id=? AND from_m IS NOT NULL AND to_m IS NOT NULL ORDER BY from_m", (hid,))]
    for im in images:
        im["features"] = [db.feature_out(f) for f in c.execute(
            "SELECT * FROM feature WHERE image_id=? AND from_m IS NOT NULL", (im["id"],))]
    return hole, images


def _rows(c, hid: str) -> list[dict]:
    return [dict(r) for r in c.execute("SELECT * FROM interval_log WHERE hole_id=? ORDER BY from_m", (hid,))]


def merge_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for f, t in sorted(ranges):
        if out and f <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], t)
        else:
            out.append([f, t])
    return [(a, b) for a, b in out]


def qa_checks(rows: list[dict], photographed: list[tuple[float, float]], length: float) -> list[dict]:
    """Gaps between logged intervals, photographed core left unlogged, and intervals past end of hole."""
    issues = []
    rows = sorted(rows, key=lambda r: r["from_m"])
    for a, b in zip(rows, rows[1:]):
        if b["from_m"] > a["to_m"] + 1e-3:
            issues.append({"type": "gap", "from_m": a["to_m"], "to_m": b["from_m"],
                           "message": f"Gap in log {a['to_m']:.2f}–{b['from_m']:.2f} m"})
    logged = merge_ranges([(r["from_m"], r["to_m"]) for r in rows])
    for pf, pt in merge_ranges(photographed):
        cur = pf
        for lf, lt in logged:
            if lt <= cur or lf >= pt:
                continue
            if lf > cur + 1e-3:
                issues.append({"type": "unlogged", "from_m": cur, "to_m": min(lf, pt),
                               "message": f"Photographed but not logged {cur:.2f}–{min(lf, pt):.2f} m"})
            cur = max(cur, lt)
        if cur < pt - 1e-3:
            issues.append({"type": "unlogged", "from_m": cur, "to_m": pt,
                           "message": f"Photographed but not logged {cur:.2f}–{pt:.2f} m"})
    if rows and rows[-1]["to_m"] > length + 1e-3:
        issues.append({"type": "eoh", "from_m": length, "to_m": rows[-1]["to_m"],
                       "message": f"Log runs past end of hole ({length} m)"})
    return sorted(issues, key=lambda i: i["from_m"])


def _with_qa(c, hid: str, rows: list[dict] | None = None) -> dict:
    hole, images = _hole_data(c, hid)
    rows = _rows(c, hid) if rows is None else rows
    return {"rows": rows, "qa": qa_checks(rows, [(i["from_m"], i["to_m"]) for i in images], hole["length"])}


@router.get("/api/holes/{hid}/intervals")
def get_intervals(hid: str):
    with db.tx() as c:
        return _with_qa(c, hid)


@router.put("/api/holes/{hid}/intervals")
def put_intervals(hid: str, body: list[IntervalIn]):
    rows = sorted(body, key=lambda r: r.from_m)
    for r in rows:
        if r.to_m <= r.from_m:
            raise HTTPException(422, f"Interval {r.from_m}–{r.to_m} m: 'to' must be greater than 'from'")
    for a, b in zip(rows, rows[1:]):
        if b.from_m < a.to_m - 1e-6:
            raise HTTPException(422, f"Intervals overlap at {b.from_m}–{a.to_m} m")
    with db.tx() as c:
        db.get_or_404(c, "hole", hid)
        c.execute("DELETE FROM interval_log WHERE hole_id=?", (hid,))
        t = db.now()
        for r in rows:
            c.execute("INSERT INTO interval_log (id, hole_id, from_m, to_m, lithology, alteration, alteration_intensity, "
                      "mineralization, sulphide_pct, vein_pct, comments, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (r.id or db.new_id(), hid, round(r.from_m, 3), round(r.to_m, 3), r.lithology.strip(),
                       r.alteration.strip(), r.alteration_intensity, r.mineralization.strip(), r.sulphide_pct,
                       r.vein_pct, r.comments.strip(), r.source if r.source in ("auto", "user") else "user", t))
        return _with_qa(c, hid)


@router.post("/api/holes/{hid}/intervals/draft")
def draft_intervals(hid: str):
    """Build an unsaved interval log from the photo annotations and AI summaries, for the geologist to edit."""
    with db.tx() as c:
        hole, images = _hole_data(c, hid)
        codes = _codes(c, hole["project_id"])
    rows = build_draft(hole, images, codes)
    return {"rows": rows, "qa": qa_checks(rows, [(i["from_m"], i["to_m"]) for i in images], hole["length"])}


def build_draft(hole: dict, images: list[dict], codes: list[dict]) -> list[dict]:
    by_field = {f: [c for c in codes if c["field"] == f] for f in FIELDS}
    L = float(hole["length"])
    cuts = set()
    for im in images:
        cuts.update((max(0.0, im["from_m"]), min(L, im["to_m"])))
        for f in im["features"]:
            if f["category"] in ("lithology", "alteration", "mineralization"):
                cuts.update((max(0.0, f["from_m"]), min(L, f["to_m"])))
    cuts = sorted(c for c in cuts if 0 <= c <= L)
    segs = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 0.01:
            continue
        m = (a + b) / 2
        im = next((i for i in images if i["from_m"] <= m < i["to_m"]), None)
        if not im:
            continue  # not photographed
        cover = [f for f in im["features"] if f["from_m"] <= m <= f["to_m"]]
        an = im.get("analysis") or {}
        kpi = an.get("kpi") or {}

        def labels(cat):
            fs = sorted((f for f in cover if f["category"] == cat), key=lambda f: -f["confidence"])
            out = []
            for f in fs:
                v = map_label(f["label"], by_field.get(cat, []))
                if v and v not in out:
                    out.append(v)
            return out

        lith = labels("lithology")
        if not lith and an.get("lithology"):
            top = max(an["lithology"], key=lambda u: u.get("pct", 0))
            lith = [map_label(top.get("unit", ""), by_field["lithology"])]
        alt = labels("alteration")
        mins = labels("mineralization")
        score = float(kpi.get("alteration_score") or 0)
        segs.append({
            "from_m": round(a, 3), "to_m": round(b, 3),
            "lithology": lith[0] if lith else "",
            "alteration": ", ".join(alt[:2]),
            "alteration_intensity": min(3, max(1, round(score * 3 / 5))) if alt else 0,
            "mineralization": ", ".join(mins[:3]),
            "sulphide_pct": float(kpi.get("sulphide_pct") or 0) if mins else 0.0,
            "vein_pct": float(kpi.get("vein_pct") or 0),
            "comments": "", "source": "auto",
        })
    # Lithology is continuous downhole: carry the unit into contiguous segments that have none.
    for seq in (segs, list(reversed(segs))):
        for p, s in zip(seq, seq[1:]):
            touching = abs(p["to_m"] - s["from_m"]) < 1e-6 or abs(s["to_m"] - p["from_m"]) < 1e-6
            if touching and not s["lithology"] and p["lithology"]:
                s["lithology"] = p["lithology"]
    out = _merge_same(segs)
    # Absorb slivers (< MIN_INTERVAL) into the longer touching neighbour, then merge again.
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, s in enumerate(out):
            if s["to_m"] - s["from_m"] >= MIN_INTERVAL:
                continue
            prev = out[i - 1] if i > 0 and abs(out[i - 1]["to_m"] - s["from_m"]) < 1e-6 else None
            nxt = out[i + 1] if i + 1 < len(out) and abs(out[i + 1]["from_m"] - s["to_m"]) < 1e-6 else None
            tgt = max((n for n in (prev, nxt) if n), key=lambda n: n["to_m"] - n["from_m"], default=None)
            if not tgt:
                continue
            tgt["from_m"], tgt["to_m"] = min(tgt["from_m"], s["from_m"]), max(tgt["to_m"], s["to_m"])
            out.pop(i)
            out = _merge_same(out)
            changed = True
            break
    for r in out:
        r["sulphide_pct"] = round(r["sulphide_pct"], 2)
        r["vein_pct"] = round(r["vein_pct"], 2)
    return out


MIN_INTERVAL = 0.2  # m; shorter draft intervals are folded into a neighbour
_KEY = ("lithology", "alteration", "alteration_intensity", "mineralization")


def _merge_same(segs: list[dict]) -> list[dict]:
    """Merge touching segments that log the same thing (length-weighted sulphide and vein %)."""
    out: list[dict] = []
    for s in segs:
        p = out[-1] if out else None
        if p and abs(p["to_m"] - s["from_m"]) < 1e-6 and all(p[k] == s[k] for k in _KEY):
            la, lb = p["to_m"] - p["from_m"], s["to_m"] - s["from_m"]
            for k in ("sulphide_pct", "vein_pct"):
                p[k] = (p[k] * la + s[k] * lb) / (la + lb)
            p["to_m"] = s["to_m"]
        else:
            out.append(dict(s))
    return out


def interval_rows_for_export(c, pid: str) -> list[list]:
    out = []
    for h in c.execute("SELECT id, name FROM hole WHERE project_id=? ORDER BY created_at", (pid,)):
        for r in _rows(c, h["id"]):
            out.append([h["name"], r["from_m"], r["to_m"], r["lithology"], r["alteration"], r["alteration_intensity"],
                        r["mineralization"], r["sulphide_pct"], r["vein_pct"], r["comments"], r["source"]])
    return out
