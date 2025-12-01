"""Add measurements table

Revision ID: 007_add_measurements_table
Revises: 006_add_pointcloud_footprint
Create Date: 2025-02-06 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "007_add_measurements_table"
down_revision: Union[str, None] = "006_add_pointcloud_footprint"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "measurements" not in inspector.get_table_names():
        op.create_table(
            "measurements",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("pointcloud_id", sa.Integer(), nullable=False),
            sa.Column("point1_x", sa.Float(), nullable=False),
            sa.Column("point1_y", sa.Float(), nullable=False),
            sa.Column("point1_z", sa.Float(), nullable=False),
            sa.Column("point2_x", sa.Float(), nullable=False),
            sa.Column("point2_y", sa.Float(), nullable=False),
            sa.Column("point2_z", sa.Float(), nullable=False),
            sa.Column("distance", sa.Float(), nullable=False),
            sa.Column("label", sa.String(), nullable=True),
            sa.Column("metadata_json", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(["pointcloud_id"], ["pointclouds.id"], ondelete="CASCADE"),
        )
        op.create_index(op.f("ix_measurements_id"), "measurements", ["id"], unique=False)
        op.create_index(op.f("ix_measurements_pointcloud_id"), "measurements", ["pointcloud_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_measurements_pointcloud_id"), table_name="measurements")
    op.drop_index(op.f("ix_measurements_id"), table_name="measurements")
    op.drop_table("measurements")
