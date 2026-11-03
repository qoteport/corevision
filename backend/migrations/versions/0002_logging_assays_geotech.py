"""Interval log, logging codes, assays, core breaks (geotech), core size and manual core rows.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("hole") as b:
        b.add_column(sa.Column("core_size", sa.Text, server_default="NQ"))
    with op.batch_alter_table("core_image") as b:
        # Manual core-row boxes (JSON); when set they override the AI-detected rows.
        b.add_column(sa.Column("core_boxes", sa.Text))
        # Manual image scale; when null it is derived from core diameter in the photo.
        b.add_column(sa.Column("scale_px_per_mm", sa.Float))

    op.create_table(
        "logging_code",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.Text, sa.ForeignKey("project.id", ondelete="CASCADE"), nullable=False),
        sa.Column("field", sa.Text, nullable=False),  # lithology | alteration | mineralization
        sa.Column("code", sa.Text, nullable=False),
        sa.Column("description", sa.Text, server_default=""),
        sa.UniqueConstraint("project_id", "field", "code", name="uq_code"),
    )
    op.create_table(
        "interval_log",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("hole_id", sa.Text, sa.ForeignKey("hole.id", ondelete="CASCADE"), nullable=False),
        sa.Column("from_m", sa.Float, nullable=False),
        sa.Column("to_m", sa.Float, nullable=False),
        sa.Column("lithology", sa.Text, server_default=""),
        sa.Column("alteration", sa.Text, server_default=""),
        sa.Column("alteration_intensity", sa.Integer, server_default="0"),  # 0 none .. 3 strong
        sa.Column("mineralization", sa.Text, server_default=""),
        sa.Column("sulphide_pct", sa.Float, server_default="0"),
        sa.Column("vein_pct", sa.Float, server_default="0"),
        sa.Column("comments", sa.Text, server_default=""),
        sa.Column("source", sa.Text, server_default="user"),  # auto | user
        sa.Column("updated_at", sa.Float),
    )
    op.create_index("ix_interval_hole", "interval_log", ["hole_id", "from_m"])
    op.create_table(
        "assay",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("hole_id", sa.Text, sa.ForeignKey("hole.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sample_id", sa.Text, server_default=""),
        sa.Column("from_m", sa.Float, nullable=False),
        sa.Column("to_m", sa.Float, nullable=False),
        sa.Column("element", sa.Text, nullable=False),
        sa.Column("value", sa.Float, nullable=False),
        sa.Column("unit", sa.Text, server_default=""),
        sa.Column("below_detection", sa.Integer, server_default="0"),
    )
    op.create_index("ix_assay_hole", "assay", ["hole_id", "element", "from_m"])
    op.create_table(
        "core_break",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("image_id", sa.Text, sa.ForeignKey("core_image.id", ondelete="CASCADE"), nullable=False),
        sa.Column("x", sa.Float, nullable=False),
        sa.Column("y", sa.Float, nullable=False),
        sa.Column("natural", sa.Integer, server_default="1"),  # 1 natural fracture, 0 drilling/handling break
        sa.Column("source", sa.Text, server_default="user"),
        sa.Column("depth_m", sa.Float),
    )
    op.create_index("ix_break_img", "core_break", ["image_id"])


def downgrade() -> None:
    for t in ("core_break", "assay", "interval_log", "logging_code"):
        op.drop_table(t)
    with op.batch_alter_table("core_image") as b:
        b.drop_column("scale_px_per_mm")
        b.drop_column("core_boxes")
    with op.batch_alter_table("hole") as b:
        b.drop_column("core_size")
