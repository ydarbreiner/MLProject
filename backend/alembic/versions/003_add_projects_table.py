"""Add projects table and project linkage to pointclouds

Revision ID: 003_add_projects_table
Revises: 002_add_classification_batches
Create Date: 2025-02-05 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "003_add_projects_table"
down_revision: Union[str, None] = "002_add_classification_batches"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "projects" not in inspector.get_table_names():
        op.create_table(
            "projects",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("name", sa.String(), nullable=False, unique=True),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        )
        op.create_index(op.f("ix_projects_id"), "projects", ["id"], unique=False)

    pointcloud_columns = {column["name"] for column in inspector.get_columns("pointclouds")}
    if "project_id" not in pointcloud_columns:
        op.add_column("pointclouds", sa.Column("project_id", sa.Integer(), nullable=True))
        op.create_index("ix_pointclouds_project_id", "pointclouds", ["project_id"])
        op.create_foreign_key(
            "fk_pointclouds_project_id_projects",
            "pointclouds",
            "projects",
            ["project_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    op.drop_constraint("fk_pointclouds_project_id_projects", "pointclouds", type_="foreignkey")
    op.drop_index("ix_pointclouds_project_id", table_name="pointclouds")
    op.drop_column("pointclouds", "project_id")

    op.drop_index(op.f("ix_projects_id"), table_name="projects")
    op.drop_table("projects")
