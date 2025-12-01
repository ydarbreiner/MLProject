"""Add classification edit batches table

Revision ID: 002_add_classification_batches
Revises: 001_initial_migration
Create Date: 2024-10-25 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "002_add_classification_batches"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'classificationeditstatus') THEN
                DROP TYPE classificationeditstatus;
            END IF;
            CREATE TYPE classificationeditstatus AS ENUM ('queued', 'processing', 'completed', 'failed');
        END
        $$;
        """
    )

    classification_status_enum = postgresql.ENUM(
        "queued",
        "processing",
        "completed",
        "failed",
        name="classificationeditstatus",
        create_type=False,
    )

    op.create_table(
        "classification_edit_batches",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("pointcloud_id", sa.Integer(), sa.ForeignKey("pointclouds.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", classification_status_enum, nullable=False, server_default="queued"),
        sa.Column("total_points", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("unstable_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("metadata", postgresql.JSONB(), nullable=True),
        sa.Column("operations", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("error_details", postgresql.JSONB(), nullable=True),
        sa.Column("tiles_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tiles_processed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("points_processed", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_classification_edit_batches_pointcloud_id",
        "classification_edit_batches",
        ["pointcloud_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_classification_edit_batches_pointcloud_id", table_name="classification_edit_batches")
    op.drop_table("classification_edit_batches")
    op.execute("DROP TYPE IF EXISTS classificationeditstatus")
