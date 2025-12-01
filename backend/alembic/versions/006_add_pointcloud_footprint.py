"""Add footprint column to pointclouds

Revision ID: 006_add_pointcloud_footprint
Revises: 005_add_project_poles
Create Date: 2025-02-06 01:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "006_add_pointcloud_footprint"
down_revision: Union[str, None] = "005_add_project_poles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "pointclouds" in inspector.get_table_names():
        column_names = {column["name"] for column in inspector.get_columns("pointclouds")}
        if "footprint" not in column_names:
            op.add_column("pointclouds", sa.Column("footprint", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("pointclouds", "footprint")
