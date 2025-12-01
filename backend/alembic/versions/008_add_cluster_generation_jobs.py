"""Add cluster generation jobs table

Revision ID: 008_add_cluster_generation_jobs
Revises: 007_add_measurements_table
Create Date: 2025-01-19 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "008_add_cluster_generation_jobs"
down_revision: Union[str, None] = "2a8bb57d7d91"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'clusterjobstatus') THEN
                DROP TYPE clusterjobstatus;
            END IF;
            CREATE TYPE clusterjobstatus AS ENUM ('queued', 'training', 'extracting', 'clustering', 'building_overlay', 'completed', 'failed');
        END
        $$;
        """
    )

    cluster_status_enum = postgresql.ENUM(
        "queued",
        "training",
        "extracting",
        "clustering",
        "building_overlay",
        "completed",
        "failed",
        name="clusterjobstatus",
        create_type=False,
    )

    op.create_table(
        "cluster_generation_jobs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("pointcloud_id", sa.Integer(), sa.ForeignKey("pointclouds.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", cluster_status_enum, nullable=False, server_default="queued"),
        sa.Column("run_name", sa.String(), nullable=False),
        sa.Column("cluster_job_name", sa.String(), nullable=True),
        sa.Column("num_clusters", sa.Integer(), nullable=False, server_default="12"),
        sa.Column("max_training_steps", sa.Integer(), nullable=False, server_default="2000"),
        sa.Column("patches_per_file", sa.Integer(), nullable=False, server_default="2048"),
        sa.Column("current_step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_steps", sa.Integer(), nullable=True),
        sa.Column("progress_message", sa.String(), nullable=True),
        sa.Column("overlay_path", sa.String(), nullable=True),
        sa.Column("embedding_path", sa.String(), nullable=True),
        sa.Column("checkpoint_path", sa.String(), nullable=True),
        sa.Column("metrics", postgresql.JSONB(), nullable=True),
        sa.Column("error_details", postgresql.JSONB(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_cluster_generation_jobs_pointcloud_id",
        "cluster_generation_jobs",
        ["pointcloud_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_cluster_generation_jobs_pointcloud_id", table_name="cluster_generation_jobs")
    op.drop_table("cluster_generation_jobs")
    op.execute("DROP TYPE IF EXISTS clusterjobstatus")
