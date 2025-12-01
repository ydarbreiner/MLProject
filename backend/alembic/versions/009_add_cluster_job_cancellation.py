"""Add cancellation status and worker task tracking

Revision ID: 009_add_cluster_job_cancellation
Revises: 008_add_cluster_generation_jobs
Create Date: 2025-11-21 07:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "009_add_cluster_job_cancellation"
down_revision: Union[str, None] = "008_add_cluster_generation_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cluster_generation_jobs",
        sa.Column("worker_task_id", sa.String(), nullable=True),
    )

    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE clusterjobstatus ADD VALUE IF NOT EXISTS 'cancelled';")


def downgrade() -> None:
    op.drop_column("cluster_generation_jobs", "worker_task_id")

    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE clusterjobstatus RENAME TO clusterjobstatus_old;")
        op.execute(
            """
            CREATE TYPE clusterjobstatus AS ENUM (
                'queued',
                'training',
                'extracting',
                'clustering',
                'building_overlay',
                'completed',
                'failed'
            );
            """
        )
        op.execute(
            "ALTER TABLE cluster_generation_jobs ALTER COLUMN status TYPE clusterjobstatus USING status::text::clusterjobstatus;"
        )
        op.execute("DROP TYPE clusterjobstatus_old;")
