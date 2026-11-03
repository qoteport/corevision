"""Shared test setup: an isolated data dir, no real API key, and a signed-in admin client."""
import os
import sys
import tempfile
from pathlib import Path

os.environ["CV_DATA_DIR"] = tempfile.mkdtemp(prefix="cv-test-")
os.environ["CV_NO_DOTENV"] = "1"  # never read the developer's real API key in tests
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
os.environ.pop("CV_SETUP_TOKEN", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

CSRF = {"X-Requested-With": "corevision"}
ADMIN = {"email": "admin@example.com", "password": "correct horse battery 9"}


def signed_in_client(email: str, password: str) -> TestClient:
    c = TestClient(app, headers=CSRF)
    c.__enter__()
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture(scope="session")
def client():
    with TestClient(app, headers=CSRF) as c:
        st = c.get("/api/auth/status").json()
        if st["setup_required"]:
            r = c.post("/api/auth/setup", json={"org_name": "Test Org", "name": "Ada Admin", **ADMIN})
            assert r.status_code == 200, r.text
        else:
            assert c.post("/api/auth/login", json=ADMIN).status_code == 200
        yield c
