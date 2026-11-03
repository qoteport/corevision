"""Baseline schema: projects, holes, surveys, core images, features, edit audit.

Matches the schema the app created before Alembic was added, so existing databases are stamped
at this revision instead of being recreated.

Revision ID: 0001
Revises:
Create Date: 2026-11-02
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("deposit_style", sa.Text, server_default=""),
        sa.Column("crs_epsg", sa.Integer),
        sa.Column("created_at", sa.Float),
    )
    op.create_table(
        "hole",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("project_id", sa.Text, sa.ForeignKey("project.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("x", sa.Float, server_default="0"),
        sa.Column("y", sa.Float, server_default="0"),
        sa.Column("z", sa.Float, server_default="0"),
        sa.Column("azimuth", sa.Float, server_default="0"),
        sa.Column("dip", sa.Float, server_default="90"),
        sa.Column("length", sa.Float, server_default="100"),
        sa.Column("status", sa.Text, server_default="drilled"),
        sa.Column("created_at", sa.Float),
    )
    op.create_table(
        "survey",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("hole_id", sa.Text, sa.ForeignKey("hole.id", ondelete="CASCADE"), nullable=False),
        sa.Column("depth", sa.Float, nullable=False),
        sa.Column("azimuth", sa.Float, nullable=False),
        sa.Column("dip", sa.Float, nullable=False),
    )
    op.create_table(
        "core_image",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("hole_id", sa.Text, sa.ForeignKey("hole.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text),
        sa.Column("from_m", sa.Float),
        sa.Column("to_m", sa.Float),
        sa.Column("direction", sa.Text, server_default="lr"),
        sa.Column("storage_key", sa.Text),
        sa.Column("width_px", sa.Integer),
        sa.Column("height_px", sa.Integer),
        sa.Column("status", sa.Text, server_default="new"),
        sa.Column("error", sa.Text),
        sa.Column("analysis", sa.Text),
        sa.Column("model", sa.Text),
        sa.Column("created_at", sa.Float),
    )
    op.create_table(
        "feature",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("image_id", sa.Text, sa.ForeignKey("core_image.id", ondelete="CASCADE"), nullable=False),
        sa.Column("label", sa.Text),
        sa.Column("category", sa.Text),
        sa.Column("confidence", sa.Integer),
        sa.Column("closed", sa.Integer),
        sa.Column("pts", sa.Text),
        sa.Column("from_m", sa.Float),
        sa.Column("to_m", sa.Float),
        sa.Column("source", sa.Text, server_default="ai"),
        sa.Column("verified", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.Float),
        sa.Column("updated_at", sa.Float),
    )
    op.create_table(
        "edit_event",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("feature_id", sa.Text),
        sa.Column("image_id", sa.Text),
        sa.Column("action", sa.Text),
        sa.Column("before", sa.Text),
        sa.Column("after", sa.Text),
        sa.Column("ts", sa.Float),
    )
    op.create_index("ix_hole_project", "hole", ["project_id"])
    op.create_index("ix_img_hole", "core_image", ["hole_id"])
    op.create_index("ix_feat_img", "feature", ["image_id"])
    op.create_index("ix_survey_hole", "survey", ["hole_id", "depth"])


def downgrade() -> None:
    for t in ("edit_event", "feature", "core_image", "survey", "hole", "project"):
        op.drop_table(t)
