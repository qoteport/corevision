"""Alembic environment. Uses the app's database: SQLite locally, Postgres when DATABASE_URL is set."""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

config = context.config
# Only configure logging when run from the CLI, so the server's logging is left alone.
if config.config_file_name and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

def _default_url() -> str:
    from app import db
    return db.alembic_url()


URL = config.get_main_option("sqlalchemy.url") or _default_url()
target_metadata = None  # migrations are written by hand; the app uses plain SQL
MIGRATION_LOCK = 7720261103  # Postgres advisory lock id: one instance migrates at a time


def run_migrations_offline() -> None:
    context.configure(url=URL, literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(URL, poolclass=pool.NullPool)
    with engine.connect() as connection:
        # render_as_batch lets ALTER TABLE operations work on SQLite.
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            if connection.dialect.name == "postgresql":
                # Several Cloud Run instances may start at once; the others wait here, then find nothing to do.
                connection.exec_driver_sql(f"SELECT pg_advisory_xact_lock({MIGRATION_LOCK})")
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
