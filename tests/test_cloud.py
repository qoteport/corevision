"""Cloud-deployment pieces that can be checked without GCP: GCS storage (fake client), SQL translation."""
import os
import sys
import tempfile
import types
from pathlib import Path

os.environ.setdefault("CV_DATA_DIR", tempfile.mkdtemp(prefix="cv-test-"))
os.environ["CV_NO_DOTENV"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app import db, storage  # noqa: E402


class _NotFound(Exception):
    pass


class _Blob:
    def __init__(self, store, name):
        self.store, self.name, self.cache_control = store, name, None

    def upload_from_string(self, data, content_type=None):
        self.store[self.name] = (data, content_type, self.cache_control)

    def download_as_bytes(self):
        if self.name not in self.store:
            raise _NotFound()
        return self.store[self.name][0]

    def delete(self):
        if self.name not in self.store:
            raise _NotFound()
        del self.store[self.name]


def test_gcs_storage_with_fake_client(monkeypatch):
    objects: dict = {}
    bucket = types.SimpleNamespace(blob=lambda name: _Blob(objects, name))
    fake_storage = types.SimpleNamespace(Client=lambda: types.SimpleNamespace(bucket=lambda n: bucket))
    gc = types.ModuleType("google.cloud")
    gc.storage = fake_storage
    exc = types.ModuleType("google.api_core.exceptions")
    exc.NotFound = _NotFound
    monkeypatch.setitem(sys.modules, "google.cloud", gc)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", fake_storage)
    monkeypatch.setitem(sys.modules, "google.api_core.exceptions", exc)

    s = storage.GCSStorage("bucket", "images/")
    s.put("a.jpg", b"jpeg-bytes")
    assert objects["images/a.jpg"] == (b"jpeg-bytes", "image/jpeg", "private, max-age=86400")
    assert s.get("a.jpg") == b"jpeg-bytes"
    assert s.get("missing.jpg") is None
    s.delete("a.jpg")
    s.delete("a.jpg")  # deleting twice is fine
    assert objects == {}


def test_pg_placeholder_translation():
    assert db._pg_sql("SELECT * FROM t WHERE a=? AND b IN ('x?', 'y')") == "SELECT * FROM t WHERE a=%s AND b IN ('x?', 'y')"
    assert db._pg_sql("UPDATE t SET p='50%' WHERE id=?") == "UPDATE t SET p='50%%' WHERE id=%s"


def test_row_positional_and_named():
    r = db.Row([("name", "project"), ("n", 3)])
    assert r[0] == "project" and r["n"] == 3 and dict(r) == {"name": "project", "n": 3}
