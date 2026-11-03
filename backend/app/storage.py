"""Photo storage: local disk, or Google Cloud Storage when CV_GCS_BUCKET is set.

On Cloud Run the GCS client authenticates as the service's service account (no key files).
"""
import threading

from . import config


class LocalStorage:
    kind = "local"

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> None:
        (config.IMAGE_DIR / key).write_bytes(data)

    def get(self, key: str) -> bytes | None:
        p = config.IMAGE_DIR / key
        return p.read_bytes() if p.exists() else None

    def delete(self, key: str) -> None:
        (config.IMAGE_DIR / key).unlink(missing_ok=True)


class GCSStorage:
    kind = "gcs"

    def __init__(self, bucket: str, prefix: str):
        from google.cloud import storage
        self._bucket = storage.Client().bucket(bucket)
        self._prefix = prefix

    def _blob(self, key: str):
        return self._bucket.blob(self._prefix + key)

    def put(self, key: str, data: bytes, content_type: str = "image/jpeg") -> None:
        b = self._blob(key)
        b.cache_control = "private, max-age=86400"
        b.upload_from_string(data, content_type=content_type)

    def get(self, key: str) -> bytes | None:
        from google.api_core.exceptions import NotFound
        try:
            return self._blob(key).download_as_bytes()
        except NotFound:
            return None

    def delete(self, key: str) -> None:
        from google.api_core.exceptions import NotFound
        try:
            self._blob(key).delete()
        except NotFound:
            pass


_store = None
_lock = threading.Lock()


def store():
    global _store
    with _lock:
        if _store is None:
            _store = GCSStorage(config.GCS_BUCKET, config.GCS_PREFIX) if config.GCS_BUCKET else LocalStorage()
    return _store
