"""Tests for multi-row depth mapping, geotech, intercepts, assays, interval log and migrations."""
import io
import math
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("CV_DATA_DIR", tempfile.mkdtemp(prefix="cv-test-"))
os.environ["CV_NO_DOTENV"] = "1"
os.environ.pop("ANTHROPIC_API_KEY", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import assays, geo, intervals  # noqa: E402
from app.main import app  # noqa: E402

# A tray photo with 3 horizontal core rows, each spanning x 100..900.
ROWS = [[100, 100, 900, 200], [100, 400, 900, 500], [100, 700, 900, 800]]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------- depth along a multi-row tray ----------

def test_depth_walks_rows_in_order():
    img = {"from_m": 30.0, "to_m": 33.0, "direction": "lr"}
    # start of row 1 → 30 m, end of row 1 → 31 m, middle of row 2 → 31.5 m, end of row 3 → 33 m
    assert math.isclose(geo.point_depth(img, (100, 150), ROWS), 30.0)
    assert math.isclose(geo.point_depth(img, (900, 150), ROWS), 31.0)
    assert math.isclose(geo.point_depth(img, (500, 450), ROWS), 31.5)
    assert math.isclose(geo.point_depth(img, (900, 750), ROWS), 33.0)
    # rows given out of order are still read top to bottom
    assert math.isclose(geo.point_depth(img, (500, 450), list(reversed(ROWS))), 31.5)


def test_depth_right_to_left_and_vertical():
    img = {"from_m": 0.0, "to_m": 2.0, "direction": "rl"}
    assert math.isclose(geo.point_depth(img, (900, 150), ROWS[:2]), 0.0)
    assert math.isclose(geo.point_depth(img, (100, 450), ROWS[:2]), 2.0)
    cols = [[100, 0, 200, 1000], [500, 0, 600, 1000]]
    img = {"from_m": 0.0, "to_m": 2.0, "direction": "tb"}
    assert math.isclose(geo.point_depth(img, (150, 500), cols), 0.5)
    assert math.isclose(geo.point_depth(img, (550, 500), cols), 1.5)


# ---------- geotech ----------

def _img(**kw):
    # 1600 x 1000 px photo. Row height 100/1000 * 1000 px = 100 px; NQ 47.6 mm → 2.1 px/mm.
    # Row length 800/1000 * 1600 px = 1280 px = 609.5 mm; 3 rows ≈ 1.83 m of core.
    return {"id": "i", "from_m": 10.0, "to_m": 11.83, "direction": "lr", "width_px": 1600, "height_px": 1000, **kw}


def test_geotech_rqd_recovery_ff():
    # Natural breaks every 50 mm along row 1 (pieces < 100 mm don't count), none in rows 2-3.
    ppm = 100 / 47.6
    step = 50 * ppm / 1600 * 1000  # 50 mm in 0-1000 image units along x
    breaks = [{"x": 100 + step * k, "y": 150, "natural": True} for k in range(1, 12)]
    breaks.append({"x": 500, "y": 450, "natural": False})  # mechanical: ignored for RQD
    g = geo.geotech_for_image(_img(), ROWS, breaks, "NQ")
    assert g["natural"] == 11 and g["mechanical"] == 1
    assert 99 <= g["recovery"] <= 100
    # Row 1 is rubble except its last piece; rows 2-3 plus row-1 tail form one long piece.
    # Pieces ≥100 mm ≈ 1828 - 550 = ~1278 mm of a 1830 mm run → RQD ≈ 70%.
    assert 65 <= g["rqd"] <= 72, g
    assert math.isclose(g["ff"], 11 / 1.828, rel_tol=0.02)
    assert g["scale_source"].startswith("core diameter NQ")


def test_geotech_needs_rows_and_depths():
    assert geo.geotech_for_image(_img(), [], [], "NQ")["rqd"] is None
    assert geo.geotech_for_image(_img(from_m=None), ROWS, [], "NQ")["warnings"]
    over = geo.geotech_for_image(_img(to_m=10.5), ROWS, [], "NQ")  # 1.83 m of core in a 0.5 m run
    assert any("over 105" in w for w in over["warnings"])


# ---------- intercepts ----------

def test_intercepts_with_internal_dilution():
    s = [(0, 1, 0.1), (1, 2, 2.0), (2, 3, 0.2), (3, 4, 3.0), (4, 5, 0.1), (5, 6, 0.1), (6, 7, 0.1), (7, 8, 1.5)]
    # 0.5 cut-off, 1 m dilution: 1-4 m joins (one 1 m dilution sample); 4-7 m is 3 m of waste → stops.
    out = geo.intercepts(s, 0.5, max_dilution=1, min_length=0)
    assert [(o["from_m"], o["to_m"]) for o in out] == [(1, 4), (7, 8)]
    assert math.isclose(out[0]["grade"], (2.0 + 0.2 + 3.0) / 3)
    # No dilution allowed: every above-cut-off sample stands alone.
    assert len(geo.intercepts(s, 0.5, 0, 0)) == 3
    # Min length drops the 1 m hit at the bottom.
    assert len(geo.intercepts(s, 0.5, 1, 2)) == 1


def test_intercepts_gap_counts_as_zero():
    s = [(0, 1, 1.0), (3, 4, 1.0)]  # 2 m unsampled between
    assert len(geo.intercepts(s, 0.5, max_dilution=2)) == 1
    assert math.isclose(geo.intercepts(s, 0.5, max_dilution=2)[0]["grade"], 0.5)
    assert len(geo.intercepts(s, 0.6, max_dilution=2)) == 2  # composite 0.5 < 0.6, so not joined


# ---------- assay parsing ----------

def test_assay_header_and_values():
    assert assays.parse_header("Au_ppm") == ("Au", "ppm")
    assert assays.parse_header("Cu (%)") == ("Cu", "%")
    assert assays.parse_header("cu_pct") == ("Cu", "%")
    assert assays.parse_header("Au gpt") == ("Au", "g/t")
    assert assays.parse_header("Zn") == ("Zn", "")
    assert assays.parse_header("comments") is None and assays.parse_header("To") is None
    assert assays.parse_value("<0.01") == (0.005, True)
    assert assays.parse_value("-0.02") == (0.01, True)
    assert assays.parse_value("1,250") == (1250.0, False)
    assert assays.parse_value("NS") is None


# ---------- interval log ----------

def test_qa_checks():
    rows = [{"from_m": 0, "to_m": 5}, {"from_m": 6, "to_m": 10}]
    qa = intervals.qa_checks(rows, [(0, 12)], 11)
    types = [q["type"] for q in qa]
    assert types == ["gap", "unlogged", "unlogged"]  # 5-6 gap, 5-6 photographed+unlogged, 10-12 unlogged
    assert intervals.qa_checks([{"from_m": 0, "to_m": 12}], [], 10)[0]["type"] == "eoh"


def test_draft_fills_lithology_and_absorbs_slivers():
    def f(cat, label, a, b, conf=80):
        return {"category": cat, "label": label, "from_m": a, "to_m": b, "confidence": conf}
    im = {"from_m": 0.0, "to_m": 4.0, "analysis": None, "features": [
        f("lithology", "basalt", 0.0, 2.0),
        f("mineralization", "pyrite", 2.5, 2.6),   # 0.1 m sliver → folded into a neighbour
        f("alteration", "chlorite", 3.0, 4.0),
    ]}
    rows = intervals.build_draft({"length": 10}, [im], [])
    assert all(r["to_m"] - r["from_m"] >= intervals.MIN_INTERVAL for r in rows)
    assert all(r["lithology"] == "basalt" for r in rows)  # carried down past the drawn polygon
    assert rows[0]["from_m"] == 0.0 and rows[-1]["to_m"] == 4.0
    assert all(a["to_m"] == b["from_m"] for a, b in zip(rows, rows[1:]))  # no gaps


def test_map_label_to_codes():
    codes = [{"code": "CPY", "description": "chalcopyrite"}, {"code": "PY", "description": "pyrite"}]
    assert intervals.map_label("CPY disseminated", codes) == "CPY"
    assert intervals.map_label("Chalcopyrite stringers", codes) == "CPY"
    assert intervals.map_label("bornite", codes) == "bornite"


# ---------- API ----------

def _jpeg(w=1600, h=1000) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (w, h), (120, 110, 100)).save(b, "JPEG")
    return b.getvalue()


def test_api_logging_assays_geotech(client):
    p = client.post("/api/projects", json={"name": "Geo"}).json()
    h = client.post(f"/api/projects/{p['id']}/holes", json={"name": "G-1", "length": 50, "core_size": "hq"}).json()
    assert h["core_size"] == "HQ"
    assert client.post(f"/api/projects/{p['id']}/holes", json={"name": "bad", "core_size": "XX"}).status_code == 422

    im = client.post(f"/api/holes/{h['id']}/images", files={"file": ("t.jpg", _jpeg(), "image/jpeg")},
                     data={"from_m": "10", "to_m": "13", "analyze": "false"}).json()
    # manual core rows → feature depth follows rows
    im = client.patch(f"/api/images/{im['id']}", json={"core_boxes": ROWS}).json()
    assert im["core_boxes"] == ROWS
    feats = [{"id": "lith1", "label": "PORP porphyry", "category": "lithology", "confidence": 90, "closed": True,
              "pts": [[100, 100], [900, 100], [900, 800], [100, 800]]},
             {"id": "min1", "label": "chalcopyrite", "category": "mineralization", "confidence": 70, "closed": True,
              "pts": [[100, 420], [500, 420], [500, 480]]}]
    out = client.put(f"/api/images/{im['id']}/features", json=feats).json()
    m = next(f for f in out if f["id"] == "min1")
    assert (m["from_m"], m["to_m"]) == (11.0, 11.5)  # row 2 start → middle

    # breaks + geotech
    r = client.put(f"/api/images/{im['id']}/breaks", json=[{"x": 500, "y": 150}, {"x": 300, "y": 450, "natural": False}]).json()
    assert [b["depth_m"] for b in r["breaks"]] == [10.5, 11.25]
    assert r["geotech"]["natural"] == 1 and r["geotech"]["rqd"] is not None
    hg = client.get(f"/api/holes/{h['id']}/geotech").json()
    assert hg["summary"]["rock_quality"] in ("very poor", "poor", "fair", "good", "excellent")

    # logging codes + draft interval log
    client.put(f"/api/projects/{p['id']}/codes", json=[{"field": "mineralization", "code": "cpy", "description": "chalcopyrite"},
                                                        {"field": "lithology", "code": "PORP", "description": "porphyry"}])
    assert len(client.get(f"/api/projects/{p['id']}/codes").json()) == 2
    d = client.post(f"/api/holes/{h['id']}/intervals/draft").json()
    assert d["rows"][0]["lithology"] == "PORP"
    assert any(r["mineralization"] == "CPY" for r in d["rows"])
    assert d["rows"][0]["from_m"] == 10.0 and d["rows"][-1]["to_m"] == 13.0
    saved = client.put(f"/api/holes/{h['id']}/intervals", json=d["rows"]).json()
    assert saved["qa"] == [] and len(saved["rows"]) == len(d["rows"])
    bad = [{"from_m": 0, "to_m": 5}, {"from_m": 4, "to_m": 6}]
    assert client.put(f"/api/holes/{h['id']}/intervals", json=bad).status_code == 422

    # assays + intercepts + calibration
    csv = "HoleID,From,To,SampleID,Au_ppm,Cu_pct,Notes\n" + "\n".join(
        f"G-1,{10 + i},{11 + i},S{i},{v},{c},x" for i, (v, c) in enumerate([(0.1, 0.05), (2.0, 0.8), ("<0.01", 0.6)]))
    csv += "\nNOPE,0,1,S9,1,1,x\n"
    r = client.post(f"/api/projects/{p['id']}/import/assays", files={"file": ("a.csv", csv, "text/csv")}).json()
    assert r["elements"] == ["Au", "Cu"] and r["holes"] == 1 and r["values"] == 6 and len(r["errors"]) == 1
    els = client.get(f"/api/projects/{p['id']}/assays/elements").json()
    assert {e["element"] for e in els} == {"Au", "Cu"}
    ic = client.get(f"/api/projects/{p['id']}/intercepts", params={"element": "Cu", "cutoff": 0.3, "max_dilution": 1,
                                                                    "min_length": 0, "incl_cutoff": 0.7}).json()
    assert ic["intercepts"][0]["text"] == "2.0 m @ 0.70 % Cu from 11.0 m, incl. 1.0 m @ 0.80 % Cu from 11.0 m"
    cal = client.get(f"/api/projects/{p['id']}/calibration", params={"element": "Cu"}).json()
    assert cal["n"] == 3 and all(pt["source"] == "log" for pt in cal["points"])

    model = client.get(f"/api/projects/{p['id']}/model").json()
    assert len(model["holes"][0]["assays"]) == 6
    for k in ("lithlog.csv", "assays.csv", "geotech.csv"):
        res = client.get(f"/api/projects/{p['id']}/export/{k}")
        assert res.status_code == 200 and "G-1" in res.text, k


def test_migrations_downgrade_and_upgrade(tmp_path):
    from alembic import command
    from alembic.config import Config

    from app import db
    cfg = Config(str(db.ALEMBIC_INI))
    cfg.set_main_option("script_location", str(db.ALEMBIC_INI.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{tmp_path / 'm.db'}")
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0001")
    command.upgrade(cfg, "head")
