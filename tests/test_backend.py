"""Backend tests. Run: .venv/Scripts/python -m pytest -q"""
import io
import math
import os
import sys
import tempfile
from pathlib import Path

os.environ["CV_DATA_DIR"] = tempfile.mkdtemp(prefix="cv-test-")
os.environ["CV_NO_DOTENV"] = "1"  # never read the developer's real API key in tests
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import ai, geo  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------- geometry ----------

def test_straight_hole_matches_trig():
    hole = {"x": 100, "y": 200, "z": 50, "azimuth": 90, "dip": 60, "length": 100}
    end = geo.desurvey(hole, [])[-1]
    assert end["depth"] == 100
    assert math.isclose(end["x"], 100 + 100 * math.cos(math.radians(60)), abs_tol=1e-3)
    assert math.isclose(end["y"], 200, abs_tol=1e-3)
    assert math.isclose(end["z"], 50 - 100 * math.sin(math.radians(60)), abs_tol=1e-3)


def test_vertical_hole():
    hole = {"x": 0, "y": 0, "z": 0, "azimuth": 0, "dip": 90, "length": 80}
    end = geo.desurvey(hole, [])[-1]
    assert math.isclose(end["z"], -80, abs_tol=1e-6) and abs(end["x"]) < 1e-6 and abs(end["y"]) < 1e-6


def test_minimum_curvature_arc_length_and_curvature():
    # A hole that steepens from 45° to 90° over 100 m: path length must equal measured depth,
    # and the end must lie inside the straight-line extremes.
    hole = {"x": 0, "y": 0, "z": 0, "azimuth": 0, "dip": 45, "length": 100}
    path = geo.desurvey(hole, [{"depth": 0, "azimuth": 0, "dip": 45}, {"depth": 100, "azimuth": 0, "dip": 90}], step=0.5)
    L = sum(math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"])) for a, b in zip(path, path[1:]))
    assert math.isclose(L, 100, rel_tol=1e-3)
    end = path[-1]
    # Exact circular arc: radius R = 100 / (pi/4); north = R(1 - sin45), down = R cos45... check against closed form
    R = 100 / (math.pi / 4)
    assert math.isclose(end["y"], R * (1 - math.sin(math.radians(45))), rel_tol=1e-3)
    assert math.isclose(-end["z"], R * math.cos(math.radians(45)), rel_tol=1e-3)


def test_feature_depth_direction_and_boxes():
    img = {"from_m": 10.0, "to_m": 14.0, "direction": "lr"}
    assert geo.feature_depth(img, [[0, 500], [500, 500]], None) == (10.0, 12.0)
    img["direction"] = "rl"
    assert geo.feature_depth(img, [[0, 500], [500, 500]], None) == (12.0, 14.0)
    img["direction"] = "lr"
    # core occupies x 100..900, so x=500 is the middle of the run
    assert geo.feature_depth(img, [[500, 1], [500, 2]], [[100, 0, 900, 1000]]) == (12.0, 12.0)
    assert geo.feature_depth({"from_m": None, "to_m": 2}, [[0, 0]], None) is None


def test_clean_annotations_filters_off_core():
    log = ai.CoreLog.model_validate({
        "core_boxes": [[0, 0, 1000, 300]],
        "annotations": [
            {"label": "py", "category": "mineralization", "conf": 80, "closed": True, "pts": [[10, 10], [50, 10], [50, 50]]},
            {"label": "tray", "category": "lithology", "conf": 80, "closed": True, "pts": [[10, 900], [50, 900], [50, 950]]},
            {"label": "qv", "category": "vein", "conf": 150, "closed": True, "pts": [[10, 100], [900, 120]]},
            {"label": "x", "category": "bogus", "conf": 1, "closed": True, "pts": [[1, 1], [2, 2]]},
        ]})
    out = ai.clean_annotations(log)
    assert [a["label"] for a in out] == ["py", "qv"]
    assert out[1]["closed"] is False and out[1]["confidence"] == 100


# ---------- API ----------

def _jpeg() -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (3000, 800), (120, 110, 100)).save(b, "JPEG")
    return b.getvalue()


def test_full_flow(client):
    assert client.get("/api/health").json()["ai_configured"] is False
    p = client.post("/api/projects", json={"name": "Test Prospect", "deposit_style": "Porphyry Cu-Au"}).json()
    h = client.post(f"/api/projects/{p['id']}/holes",
                    json={"name": "DDH-001", "x": 0, "y": 0, "z": 100, "azimuth": 90, "dip": 60, "length": 150}).json()
    r = client.put(f"/api/holes/{h['id']}/surveys", json=[{"depth": 0, "azimuth": 90, "dip": 60},
                                                          {"depth": 150, "azimuth": 100, "dip": 70}])
    assert len(r.json()) == 2

    up = client.post(f"/api/holes/{h['id']}/images", files={"file": ("tray.jpg", _jpeg(), "image/jpeg")},
                     data={"from_m": "10", "to_m": "14", "direction": "lr", "analyze": "true"})
    assert up.status_code == 201, up.text
    img = up.json()
    assert max(img["width_px"], img["height_px"]) == 1568
    # no key configured → analysis fails cleanly
    assert client.get(f"/api/images/{img['id']}").json()["status"] == "error"

    feats = [{"id": "f1", "label": "chalcopyrite", "category": "mineralization", "confidence": 70, "closed": True,
              "pts": [[0, 100], [500, 100], [500, 300]], "source": "user"}]
    out = client.put(f"/api/images/{img['id']}/features", json=feats).json()
    assert out[0]["from_m"] == 10.0 and out[0]["to_m"] == 12.0
    feats[0]["label"] = "cpy"
    client.put(f"/api/images/{img['id']}/features", json=feats)
    hist = client.get(f"/api/images/{img['id']}/history").json()
    assert [e["action"] for e in hist] == ["update", "create"]

    # changing the core run recomputes depths
    out = client.patch(f"/api/images/{img['id']}", json={"from_m": 20, "to_m": 24}).json()
    assert out["features"][0]["from_m"] == 20.0

    m = client.get(f"/api/projects/{p['id']}/model").json()
    assert m["holes"][0]["surveyed"] and m["holes"][0]["intervals"][0]["label"] == "cpy"
    csv = client.get(f"/api/projects/{p['id']}/export/intervals.csv").text
    assert "cpy" in csv and "DDH-001" in csv

    col = "hole,easting,northing,rl,azimuth,dip,length\nDDH-002,50,0,100,270,55,120\nDDH-001,0,0,101,90,60,150\n"
    r = client.post(f"/api/projects/{p['id']}/import/collars", files={"file": ("c.csv", col, "text/csv")}).json()
    assert r == {"created": 1, "updated": 1, "errors": []}
    sv = "hole,depth,azimuth,dip\nDDH-002,0,270,55\nDDH-002,100,265,60\nNOPE,0,0,90\n"
    r = client.post(f"/api/projects/{p['id']}/import/surveys", files={"file": ("s.csv", sv, "text/csv")}).json()
    assert r["holes"] == 1 and len(r["errors"]) == 1

    client.put(f"/api/images/{img['id']}/features", json=[])
    assert client.get(f"/api/images/{img['id']}").json()["features"] == []
    assert client.delete(f"/api/projects/{p['id']}").status_code == 204
