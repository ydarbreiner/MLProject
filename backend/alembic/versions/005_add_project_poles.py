"""Add poles column to projects

Revision ID: 005_add_project_poles
Revises: 004_project_files_geom
Create Date: 2025-02-06 00:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "005_add_project_poles"
down_revision: Union[str, None] = "004_project_files_geom"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "projects" in inspector.get_table_names():
        column_names = {column["name"] for column in inspector.get_columns("projects")}
        if "poles" not in column_names:
            op.add_column("projects", sa.Column("poles", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "poles")
