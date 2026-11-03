"""User accounts, login sessions and organization settings (one organization per deployment).

Also records who made each edit and who uploaded each photo.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_user",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("email", sa.Text, nullable=False, unique=True),  # stored lower-case
        sa.Column("name", sa.Text, nullable=False, server_default=""),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("role", sa.Text, nullable=False, server_default="geologist"),  # admin | geologist | viewer
        sa.Column("active", sa.Integer, nullable=False, server_default="1"),
        sa.Column("created_at", sa.Float),
        sa.Column("last_login_at", sa.Float),
    )
    op.create_table(
        "user_session",
        sa.Column("token_hash", sa.Text, primary_key=True),  # sha256 of the cookie token; the token itself is never stored
        sa.Column("user_id", sa.Text, sa.ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.Float, nullable=False),
        sa.Column("expires_at", sa.Float, nullable=False),
        sa.Column("last_seen_at", sa.Float),
        sa.Column("user_agent", sa.Text, server_default=""),
    )
    op.create_index("ix_session_user", "user_session", ["user_id"])
    op.create_table(
        "app_setting",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("value", sa.Text, nullable=False, server_default=""),
    )
    with op.batch_alter_table("edit_event") as b:
        b.add_column(sa.Column("user_id", sa.Text))
    with op.batch_alter_table("core_image") as b:
        b.add_column(sa.Column("uploaded_by", sa.Text))


def downgrade() -> None:
    with op.batch_alter_table("core_image") as b:
        b.drop_column("uploaded_by")
    with op.batch_alter_table("edit_event") as b:
        b.drop_column("user_id")
    op.drop_table("app_setting")
    op.drop_index("ix_session_user", "user_session")
    op.drop_table("user_session")
    op.drop_table("app_user")
