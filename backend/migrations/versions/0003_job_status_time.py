"""Record when an image's analysis status last changed, to detect jobs lost when an instance stops.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("core_image") as b:
        b.add_column(sa.Column("status_at", sa.Float))


def downgrade() -> None:
    with op.batch_alter_table("core_image") as b:
        b.drop_column("status_at")
