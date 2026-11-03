"""Database access. SQLite locally; Postgres (e.g. Cloud SQL) when DATABASE_URL is set.

App code writes plain SQL with `?` placeholders and reads rows by column name. For Postgres the
placeholders are translated and rows come back as dicts, so the same queries run on both.
The schema is managed by Alembic (backend/migrations).
"""
import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from . import config

DB_PATH = config.DB_PATH
IS_PG = config.DATABASE_URL is not None
ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"
# An analysis still 'queued'/'analyzing' after this long was lost (instance stopped) and can be re-run.
STALE_JOB_S = 20 * 60


# ---------- Postgres ----------

class Row(dict):
    """dict row that also allows positional access (r[0]) like sqlite3.Row."""

    def __getitem__(self, k):
        if isinstance(k, int):
            return list(self.values())[k]
        return super().__getitem__(k)


def _row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))


def _pg_sql(sql: str) -> str:
    """'?' placeholders → '%s', and literal '%' → '%%', outside quoted strings."""
    out, quote = [], False
    for ch in sql:
        if ch == "'":
            quote = not quote
        if not quote and ch == "?":
            out.append("%s")
        elif ch == "%":
            out.append("%%")
        else:
            out.append(ch)
    return "".join(out)


class PgConn:
    """Small adapter giving a pooled psycopg connection the sqlite3 connection surface the app uses."""

    def __init__(self, pool):
        self._pool = pool
        self._c = pool.getconn()

    def execute(self, sql: str, params=()):
        return self._c.execute(_pg_sql(sql), tuple(params))

    def executemany(self, sql: str, seq):
        with self._c.cursor() as cur:
            cur.executemany(_pg_sql(sql), [tuple(p) for p in seq])

    def commit(self):
        self._c.commit()

    def rollback(self):
        self._c.rollback()

    def close(self):
        self._pool.putconn(self._c)


_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            from psycopg_pool import ConnectionPool
            _pool = ConnectionPool(config.DATABASE_URL, min_size=1, max_size=config.DB_POOL_SIZE,
                                   kwargs={"row_factory": _row_factory}, open=True, name="corevision")
    return _pool


def close() -> None:
    """Close the Postgres pool on shutdown (no-op for SQLite)."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
            _pool = None


# ---------- connections ----------

def connect():
    if IS_PG:
        return PgConn(_get_pool())
    c = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


@contextmanager
def tx():
    c = connect()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def alembic_url() -> str:
    if IS_PG:
        u = config.DATABASE_URL
        return "postgresql+psycopg://" + u.split("://", 1)[1]
    return f"sqlite:///{DB_PATH}"


def migrate() -> None:
    """Bring the database to the latest Alembic revision.

    A SQLite database created before Alembic was added has the baseline tables but no alembic_version
    table; it is stamped at the baseline (0001) first so its data is kept. On Postgres the migration
    runs under an advisory lock (see migrations/env.py), so instances starting together don't race.
    """
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_INI.parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", alembic_url().replace("%", "%%"))
    cfg.attributes["configure_logger"] = False
    if not IS_PG:
        c = connect()
        try:
            tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            c.close()
        if "project" in tables and "alembic_version" not in tables:
            command.stamp(cfg, "0001")
    command.upgrade(cfg, "head")


def fail_stale_jobs(c) -> None:
    """Mark analyses that have been queued/running too long as failed, so they can be re-run."""
    c.execute("UPDATE core_image SET status='error', error='Analysis was interrupted. Re-analyze to try again.' "
              "WHERE status IN ('queued','analyzing') AND (status_at IS NULL OR status_at < ?)",
              (now() - STALE_JOB_S,))


def init() -> None:
    migrate()
    with tx() as c:
        fail_stale_jobs(c)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


now = time.time


def row(r):
    return dict(r) if r is not None else None


def feature_out(r) -> dict:
    d = dict(r)
    d["pts"] = json.loads(d["pts"] or "[]")
    d["closed"] = bool(d["closed"])
    d["verified"] = bool(d["verified"])
    return d


def image_out(r) -> dict:
    d = dict(r)
    d["analysis"] = json.loads(d["analysis"]) if d.get("analysis") else None
    d["core_boxes"] = json.loads(d["core_boxes"]) if d.get("core_boxes") else None
    return d


def get_or_404(c, table: str, id_: str) -> dict:
    r = c.execute(f"SELECT * FROM {table} WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, f"{table} not found")
    return dict(r)


def effective_boxes(image: dict) -> list:
    """Core-row boxes for an image: manual rows if drawn, else the AI-detected rows."""
    manual = image.get("core_boxes")
    if isinstance(manual, str):
        manual = json.loads(manual)
    if manual:
        return manual
    a = image.get("analysis")
    if isinstance(a, str):
        a = json.loads(a)
    return (a or {}).get("core_boxes") or []
