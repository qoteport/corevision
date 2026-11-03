"""Assays: CSV import, significant intercepts, and calibration of visual estimates against assay."""
import csv
import io
import math
import re

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from . import db
from .geo import intercepts

router = APIRouter()

ELEMENTS = set("""H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr
Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os
Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U""".split())
UNIT_ALIASES = {"ppm": "ppm", "ppb": "ppb", "g/t": "g/t", "gt": "g/t", "gpt": "g/t", "pct": "%", "%": "%",
                "percent": "%", "per": "%"}
HEADER = re.compile(r"^([A-Za-z]{1,2})\s*[_\-\s]*\(?\s*(ppm|ppb|g/?t|gpt|pct|%|percent)?\s*\)?$", re.I)
METAL_UNIT = {"g/t": "g·m", "%": "%·m", "ppm": "ppm·m", "ppb": "ppb·m"}


def parse_header(h: str):
    """'Au_ppm' → ('Au', 'ppm'); 'Cu (%)' → ('Cu', '%'); 'Zn' → ('Zn', ''); non-elements → None."""
    m = HEADER.match(h.strip())
    if not m:
        return None
    el = m.group(1).capitalize()
    if el not in ELEMENTS:
        return None
    u = (m.group(2) or "").lower().replace(" ", "")
    return el, UNIT_ALIASES.get(u, u)


def parse_value(s: str):
    """Lab value → (value, below_detection). '<0.01' and negative codes → half the detection limit."""
    s = (s or "").strip().replace(",", "")
    if not s or s.upper() in ("NA", "N/A", "NS", "IS", "LNR", "-", "X"):
        return None
    if s.startswith("<"):
        try:
            return float(s[1:]) / 2, True
        except ValueError:
            return None
    if s.startswith(">"):
        try:
            return float(s[1:]), False
        except ValueError:
            return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v < 0:
        return abs(v) / 2, True
    return v, False


@router.post("/api/projects/{pid}/import/assays")
async def import_assays(pid: str, file: UploadFile = File(...)):
    """Wide CSV: hole, from, to, [sample_id], then one column per element (e.g. Au_ppm, Cu_pct, Zn).
    Replaces existing values of the imported elements in each hole listed."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    try:
        header = [h.strip() for h in next(reader)]
    except StopIteration:
        raise HTTPException(422, "Empty file")
    low = [h.lower() for h in header]

    def col(*names):
        return next((low.index(n) for n in names if n in low), None)

    ih = col("hole", "hole_id", "holeid", "bhid", "name")
    if_ = col("from", "from_m", "depth_from", "mfrom", "from_depth")
    it = col("to", "to_m", "depth_to", "mto", "to_depth")
    isamp = col("sample", "sample_id", "sampleid", "sample_no", "sample_number")
    if None in (ih, if_, it):
        raise HTTPException(422, "CSV needs hole, from and to columns")
    els = {i: parse_header(h) for i, h in enumerate(header) if i not in (ih, if_, it, isamp)}
    els = {i: e for i, e in els.items() if e}
    if not els:
        raise HTTPException(422, "No element columns found (e.g. Au_ppm, Cu_pct, Zn_ppm)")

    errors, rows = [], []
    for n, r in enumerate(reader, start=2):
        if not any(x.strip() for x in r):
            continue
        try:
            f, t = float(r[if_]), float(r[it])
        except (ValueError, IndexError):
            errors.append(f"row {n}: bad from/to")
            continue
        if t <= f:
            errors.append(f"row {n}: 'to' not greater than 'from'")
            continue
        rows.append((r[ih].strip(), f, t, r[isamp].strip() if isamp is not None and isamp < len(r) else "",
                     {e: parse_value(r[i]) if i < len(r) else None for i, e in els.items()}))

    imported, holes_done = 0, set()
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        ids = {r["name"]: r["id"] for r in c.execute("SELECT id, name FROM hole WHERE project_id=?", (pid,))}
        missing = sorted({r[0] for r in rows if r[0] not in ids})
        for name in missing:
            errors.append(f"hole {name}: not found, import collars first")
        for name in {r[0] for r in rows if r[0] in ids}:
            for el, _ in els.values():
                c.execute("DELETE FROM assay WHERE hole_id=? AND element=?", (ids[name], el))
        for name, f, t, samp, vals in rows:
            if name not in ids:
                continue
            holes_done.add(name)
            for (el, unit), v in vals.items():
                if v is None:
                    continue
                c.execute("INSERT INTO assay (hole_id, sample_id, from_m, to_m, element, value, unit, below_detection) "
                          "VALUES (?,?,?,?,?,?,?,?)", (ids[name], samp, f, t, el, v[0], unit, int(v[1])))
                imported += 1
    return {"holes": len(holes_done), "values": imported, "elements": sorted({e for e, _ in els.values()}),
            "errors": errors[:50]}


@router.get("/api/projects/{pid}/assays/elements")
def elements(pid: str):
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        return [dict(r) for r in c.execute(
            "SELECT a.element, MAX(a.unit) AS unit, COUNT(*) AS n, MAX(a.value) AS max FROM assay a "
            "JOIN hole h ON h.id=a.hole_id WHERE h.project_id=? GROUP BY a.element ORDER BY a.element", (pid,))]


@router.get("/api/holes/{hid}/assays")
def hole_assays(hid: str, element: str | None = None):
    with db.tx() as c:
        db.get_or_404(c, "hole", hid)
        q, args = "SELECT * FROM assay WHERE hole_id=?", [hid]
        if element:
            q += " AND element=?"
            args.append(element)
        return [dict(r) for r in c.execute(q + " ORDER BY element, from_m", args)]


def _fmt_grade(v: float) -> str:
    return f"{v:.2f}" if v < 10 else f"{v:.1f}" if v < 100 else f"{v:.0f}"


def describe(ic: dict, el: str, unit: str) -> str:
    return f"{ic['length']:.1f} m @ {_fmt_grade(ic['grade'])} {unit} {el} from {ic['from_m']:.1f} m".replace("  ", " ")


@router.get("/api/projects/{pid}/intercepts")
def project_intercepts(pid: str, element: str = Query(...), cutoff: float = Query(..., gt=0),
                       max_dilution: float = Query(2.0, ge=0), min_length: float = Query(1.0, ge=0),
                       incl_cutoff: float | None = Query(None, gt=0)):
    """Significant intercepts for every hole. Lengths are downhole, not true widths."""
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        holes = [dict(r) for r in c.execute("SELECT id, name FROM hole WHERE project_id=? ORDER BY created_at", (pid,))]
        out = []
        for h in holes:
            rows = c.execute("SELECT from_m, to_m, value, unit FROM assay WHERE hole_id=? AND element=? ORDER BY from_m",
                             (h["id"], element)).fetchall()
            if not rows:
                continue
            unit = rows[0]["unit"]
            samples = [(r["from_m"], r["to_m"], r["value"]) for r in rows]
            for ic in intercepts(samples, cutoff, max_dilution, min_length):
                item = {"hole_id": h["id"], "hole": h["name"], **ic, "grade": round(ic["grade"], 4),
                        "metal": round(ic["metal"], 3), "unit": unit, "metal_unit": METAL_UNIT.get(unit, unit + "·m"),
                        "text": describe(ic, element, unit), "includes": []}
                if incl_cutoff and incl_cutoff > cutoff:
                    inside = [s for s in samples if s[0] >= ic["from_m"] - 1e-6 and s[1] <= ic["to_m"] + 1e-6]
                    for sub in intercepts(inside, incl_cutoff, max_dilution, 0):
                        item["includes"].append({**sub, "grade": round(sub["grade"], 4), "text": describe(sub, element, unit)})
                if item["includes"]:
                    item["text"] += ", incl. " + "; ".join(s["text"] for s in item["includes"])
                out.append(item)
        return {"element": element, "cutoff": cutoff, "max_dilution": max_dilution, "min_length": min_length,
                "intercepts": out}


def _overlap_avg(f: float, t: float, rows: list, key: str) -> float | None:
    tot = val = 0.0
    for r in rows:
        o = min(t, r["to_m"]) - max(f, r["from_m"])
        if o > 0:
            tot += o
            val += o * float(r[key] or 0)
    return val / tot if tot > 0 else None


@router.get("/api/projects/{pid}/calibration")
def calibration(pid: str, element: str = Query(...)):
    """Pair each assay interval with the visual sulphide % logged over it (interval log first, else the
    AI photo estimate), and report the correlation. Use it to check and calibrate the visual estimates."""
    pts = []
    with db.tx() as c:
        db.get_or_404(c, "project", pid)
        for h in c.execute("SELECT id, name FROM hole WHERE project_id=?", (pid,)).fetchall():
            logs = [dict(r) for r in c.execute("SELECT from_m, to_m, sulphide_pct FROM interval_log WHERE hole_id=?", (h["id"],))]
            ims = []
            for r in c.execute("SELECT from_m, to_m, analysis FROM core_image WHERE hole_id=? AND analysis IS NOT NULL "
                               "AND from_m IS NOT NULL AND to_m IS NOT NULL", (h["id"],)):
                kpi = (db.image_out(r)["analysis"] or {}).get("kpi") or {}
                ims.append({"from_m": r["from_m"], "to_m": r["to_m"], "sulphide_pct": kpi.get("sulphide_pct", 0)})
            for a in c.execute("SELECT from_m, to_m, value FROM assay WHERE hole_id=? AND element=?", (h["id"], element)):
                v = _overlap_avg(a["from_m"], a["to_m"], logs, "sulphide_pct")
                src = "log"
                if v is None:
                    v, src = _overlap_avg(a["from_m"], a["to_m"], ims, "sulphide_pct"), "photo"
                if v is not None:
                    pts.append({"hole": h["name"], "from_m": a["from_m"], "to_m": a["to_m"], "assay": a["value"],
                                "visual": round(v, 2), "source": src})
    r = None
    if len(pts) >= 3:
        xs, ys = [p["visual"] for p in pts], [p["assay"] for p in pts]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        sy = math.sqrt(sum((y - my) ** 2 for y in ys))
        if sx > 0 and sy > 0:
            r = round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy), 3)
    return {"element": element, "n": len(pts), "r": r, "points": pts}


def assay_rows_for_export(c, pid: str) -> list[list]:
    return [[r["hole"], r["sample_id"], r["from_m"], r["to_m"], r["element"], r["value"], r["unit"], r["below_detection"]]
            for r in c.execute("SELECT h.name AS hole, a.* FROM assay a JOIN hole h ON h.id=a.hole_id "
                               "WHERE h.project_id=? ORDER BY h.name, a.element, a.from_m", (pid,))]
