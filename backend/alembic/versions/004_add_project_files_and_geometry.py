"""Add project files table and geometry columns

Revision ID: 004_project_files_geom
Revises: 003_add_projects_table
Create Date: 2025-02-06 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "004_project_files_geom"
down_revision: Union[str, None] = "003_add_projects_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    project_tables = inspector.get_table_names()

    if "projects" in project_tables:
        project_columns = {column["name"] for column in inspector.get_columns("projects")}
        if "geometry" not in project_columns:
            op.add_column("projects", sa.Column("geometry", sa.JSON(), nullable=True))
        if "centroid" not in project_columns:
            op.add_column("projects", sa.Column("centroid", sa.JSON(), nullable=True))
        if "metadata" not in project_columns:
            op.add_column("projects", sa.Column("metadata", sa.JSON(), nullable=True))

    if "project_files" not in project_tables:
        op.create_table(
            "project_files",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("original_filename", sa.String(), nullable=False),
            sa.Column("stored_filename", sa.String(), nullable=False),
            sa.Column("content_type", sa.String(), nullable=True),
            sa.Column("file_size", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("uploaded_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        )
        op.create_index("ix_project_files_id", "project_files", ["id"], unique=False)
        op.create_index("ix_project_files_project_id", "project_files", ["project_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_project_files_project_id", table_name="project_files")
    op.drop_index("ix_project_files_id", table_name="project_files")
    op.drop_table("project_files")

    op.drop_column("projects", "metadata")
    op.drop_column("projects", "centroid")
    op.drop_column("projects", "geometry")
