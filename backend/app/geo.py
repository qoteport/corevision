"""Geometry: image-space depth interpolation and minimum-curvature desurvey."""
import math

OPEN_CATEGORIES = {"vein", "structure"}
CATEGORIES = ["mineralization", "alteration", "vein", "structure", "lithology"]


# ---------- depth of a feature along the core run in one photo ----------

def core_rows(boxes: list | None, direction: str) -> list[list[float]]:
    """Core rows in depth order. A tray is read row by row: rows top to bottom when depth runs
    along x (lr/rl), columns left to right when it runs along y (tb/bt). No boxes = whole image."""
    rows = [list(map(float, b)) for b in (boxes or []) if isinstance(b, (list, tuple)) and len(b) == 4]
    rows = [[min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])] for b in rows]
    if not rows:
        return [[0.0, 0.0, 1000.0, 1000.0]]
    cross = 1 if direction in ("lr", "rl") else 0
    return sorted(rows, key=lambda b: b[cross])


def depth_fraction(p, rows: list, direction: str) -> float:
    """Fraction (0-1) of the way along the core run for an image point, walking rows in order."""
    horizontal = direction in ("lr", "rl")
    a, cr = (0, 1) if horizontal else (1, 0)  # along-axis index, cross-axis index
    lens = [max(1.0, r[a + 2] - r[a]) for r in rows]
    total = sum(lens)

    def dist(r):  # cross-axis distance from the point to the row (0 when inside)
        return max(r[cr] - p[cr], 0.0, p[cr] - r[cr + 2])

    i = min(range(len(rows)), key=lambda k: (dist(rows[k]), abs((rows[k][cr] + rows[k][cr + 2]) / 2 - p[cr])))
    r = rows[i]
    u = min(1.0, max(0.0, (p[a] - r[a]) / lens[i]))
    if direction in ("rl", "bt"):
        u = 1 - u
    return (sum(lens[:i]) + u * lens[i]) / total


def point_depth(image: dict, p, core_boxes: list | None) -> float | None:
    f, t = image.get("from_m"), image.get("to_m")
    if f is None or t is None:
        return None
    direction = image.get("direction") or "lr"
    return f + depth_fraction(p, core_rows(core_boxes, direction), direction) * (t - f)


def feature_depth(image: dict, pts: list, core_boxes: list | None) -> tuple[float, float] | None:
    """Map a feature's image points (0-1000) to a from/to depth range along the core run.

    Depth runs through the core rows in order (row 1 start → end, then row 2 ...), from the
    image's from_m to to_m, in `image.direction` within each row.
    """
    if image.get("from_m") is None or image.get("to_m") is None or not pts:
        return None
    ds = [point_depth(image, p, core_boxes) for p in pts]
    return round(min(ds), 3), round(max(ds), 3)


# ---------- geotechnical logging ----------

# Core diameters (mm) for standard wireline sizes.
CORE_DIAMETERS = {"BQ": 36.5, "NQ": 47.6, "NQ2": 50.6, "NQ3": 45.0, "HQ": 63.5, "HQ3": 61.1, "PQ": 85.0, "PQ3": 83.0}


def geotech_for_image(image: dict, boxes: list | None, breaks: list[dict], core_size: str) -> dict:
    """RQD, recovery and fracture frequency for one photographed core run.

    Scale comes from the core diameter: the cross-axis size of a core row in pixels divided by
    the nominal diameter, unless the image has a manual px/mm scale. Core rows are treated as one
    continuous string (row ends are tray ends, not fractures). Only natural breaks bound pieces
    for RQD; drilling/handling breaks are ignored, as in standard RQD practice.
    """
    out = {"rqd": None, "recovery": None, "ff": None, "pieces": 0, "natural": 0, "mechanical": 0,
           "recovered_m": None, "run_m": None, "px_per_mm": None, "scale_source": None, "warnings": []}
    f, t = image.get("from_m"), image.get("to_m")
    if f is None or t is None or t <= f:
        out["warnings"].append("Set the core run from/to depths.")
        return out
    real = [b for b in (boxes or []) if isinstance(b, (list, tuple)) and len(b) == 4]
    if not real:
        out["warnings"].append("No core rows: run the AI or draw the core rows.")
        return out
    direction = image.get("direction") or "lr"
    rows = core_rows(real, direction)
    W, H = float(image.get("width_px") or 1000), float(image.get("height_px") or 1000)
    horizontal = direction in ("lr", "rl")
    along_px = W if horizontal else H
    cross_px = H if horizontal else W
    a = 0 if horizontal else 1
    if image.get("scale_px_per_mm"):
        ppm = float(image["scale_px_per_mm"])
        out["scale_source"] = "manual"
    else:
        dia = CORE_DIAMETERS.get((core_size or "NQ").upper(), CORE_DIAMETERS["NQ"])
        widths = sorted((r[3 - a] - r[1 - a]) / 1000 * cross_px for r in rows)
        ppm = widths[len(widths) // 2] / dia
        out["scale_source"] = f"core diameter {core_size or 'NQ'} {dia} mm"
    if ppm <= 0:
        out["warnings"].append("Could not derive an image scale.")
        return out
    out["px_per_mm"] = round(ppm, 3)

    row_mm = [(r[a + 2] - r[a]) / 1000 * along_px / ppm for r in rows]
    total_mm = sum(row_mm)
    run_mm = (t - f) * 1000
    # positions of natural breaks along the continuous core string, in mm
    pos = []
    for b in breaks:
        frac = depth_fraction((b["x"], b["y"]), rows, direction)
        if b.get("natural", True):
            pos.append(frac * total_mm)
            out["natural"] += 1
        else:
            out["mechanical"] += 1
    cuts = [0.0] + sorted(pos) + [total_mm]
    pieces = [cuts[i + 1] - cuts[i] for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] > 1]
    out["pieces"] = len(pieces)
    out["rqd"] = round(min(100.0, sum(p for p in pieces if p >= 100) / run_mm * 100), 1)
    out["recovery"] = round(total_mm / run_mm * 100, 1)
    out["recovered_m"] = round(total_mm / 1000, 3)
    out["run_m"] = round(t - f, 3)
    out["ff"] = round(out["natural"] / max(1e-6, total_mm / 1000), 2)
    if out["recovery"] > 105:
        out["warnings"].append("Recovery over 105%: check the core size, run depths or scale.")
    if out["recovery"] < 60:
        out["warnings"].append("Low recovery: check for core loss, or that all rows are marked.")
    out["recovery"] = min(out["recovery"], 100.0) if out["recovery"] <= 105 else out["recovery"]
    return out


# ---------- significant intercepts ----------

def intercepts(samples: list[tuple[float, float, float]], cutoff: float, max_dilution: float = 0.0,
               min_length: float = 0.0) -> list[dict]:
    """Length-weighted composites above a cut-off grade.

    Greedy downhole compositing: start at a sample at or above cut-off, then keep absorbing the
    next run of below-cut-off samples (internal dilution, at most `max_dilution` metres) plus the
    next above-cut-off sample, as long as the composite stays at or above cut-off. Composites
    begin and end on above-cut-off samples. Unsampled gaps count as zero-grade dilution.
    """
    seq = []
    last = None
    for f, t, v in sorted((float(a), float(b), float(c)) for a, b, c in samples if b > a):
        if last is not None and f > last + 1e-6:
            seq.append((last, f, 0.0))  # gap
        seq.append((f, t, v))
        last = max(last or t, t)
    out, i, n = [], 0, len(seq)
    while i < n:
        if seq[i][2] < cutoff:
            i += 1
            continue
        start = end = i
        acc_len = seq[i][1] - seq[i][0]
        acc_gm = seq[i][2] * acc_len
        j = i + 1
        while j < n:
            k, d_len, d_gm = j, 0.0, 0.0
            while k < n and seq[k][2] < cutoff:
                d_len += seq[k][1] - seq[k][0]
                d_gm += seq[k][2] * (seq[k][1] - seq[k][0])
                k += 1
            if k >= n or d_len > max_dilution + 1e-9:
                break
            ln = seq[k][1] - seq[k][0]
            tl, tg = acc_len + d_len + ln, acc_gm + d_gm + seq[k][2] * ln
            if tg / tl < cutoff:
                break
            acc_len, acc_gm, end, j = tl, tg, k, k + 1
        f, t = seq[start][0], seq[end][1]
        if t - f >= min_length - 1e-9:
            out.append({"from_m": round(f, 3), "to_m": round(t, 3), "length": round(t - f, 3),
                        "grade": acc_gm / acc_len, "metal": acc_gm})
        i = end + 1
    return out


# ---------- minimum curvature desurvey ----------

def _unit(az_deg: float, dip_deg: float) -> tuple[float, float, float]:
    """Direction vector (east, north, down) for azimuth and dip (degrees below horizontal)."""
    a, d = math.radians(az_deg), math.radians(dip_deg)
    return (math.sin(a) * math.cos(d), math.cos(a) * math.cos(d), math.sin(d))


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _slerp(a, b, t):
    cosw = max(-1.0, min(1.0, _dot(a, b)))
    w = math.acos(cosw)
    if w < 1e-9:
        return a
    s = math.sin(w)
    k1, k2 = math.sin((1 - t) * w) / s, math.sin(t * w) / s
    return (a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2)


def _step(t1, t2, md):
    """Minimum-curvature displacement over measured length md between unit tangents t1, t2."""
    beta = math.acos(max(-1.0, min(1.0, _dot(t1, t2))))
    rf = 1.0 if beta < 1e-9 else (2 / beta) * math.tan(beta / 2)
    return tuple(md / 2 * (t1[i] + t2[i]) * rf for i in range(3))


def stations_for(hole: dict, surveys: list[dict]) -> list[tuple[float, tuple]]:
    st = sorted(((float(s["depth"]), _unit(float(s["azimuth"]), float(s["dip"]))) for s in surveys),
                key=lambda s: s[0])
    st = [s for s in st if s[0] >= 0]
    if not st or st[0][0] > 0:
        st.insert(0, (0.0, _unit(float(hole["azimuth"]), float(hole["dip"]))))
    return st


def position_at(hole: dict, stations: list, depth: float) -> tuple[float, float, float]:
    """Easting, northing, RL at a measured depth. Holds the last survey direction below it."""
    e, n, z = float(hole["x"]), float(hole["y"]), float(hole["z"])
    for i, (d1, t1) in enumerate(stations):
        nxt = stations[i + 1] if i + 1 < len(stations) else None
        end = nxt[0] if nxt else math.inf
        if depth <= d1:
            break
        seg_end = min(depth, end)
        md = seg_end - d1
        if nxt:
            t2 = _slerp(t1, nxt[1], md / max(1e-9, end - d1))
        else:
            t2 = t1
        de, dn, dz = _step(t1, t2, md)
        e, n, z = e + de, n + dn, z - dz
        if depth <= end:
            break
    return (e, n, z)


def desurvey(hole: dict, surveys: list[dict], step: float | None = None) -> list[dict]:
    """Sample the hole path from collar to total depth."""
    length = max(0.001, float(hole["length"]))
    st = stations_for(hole, surveys)
    step = step or max(0.5, length / 300)
    depths = {0.0, length}
    d = 0.0
    while d < length:
        depths.add(round(d, 3))
        d += step
    depths.update(s[0] for s in st if s[0] <= length)
    out = []
    for d in sorted(depths):
        e, n, z = position_at(hole, st, d)
        out.append({"depth": d, "x": round(e, 3), "y": round(n, 3), "z": round(z, 3)})
    return out
