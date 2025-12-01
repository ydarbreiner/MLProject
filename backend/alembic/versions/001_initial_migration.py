"""Initial migration - create pointclouds table

Revision ID: 001
Revises:
Create Date: 2025-01-17 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    # Create the pointclouds table
    op.create_table('pointclouds',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('original_filename', sa.String(), nullable=False),
        sa.Column('file_size', sa.BigInteger(), nullable=False),
        sa.Column('url', sa.String(), nullable=True),
        sa.Column('status', sa.Enum('pending', 'processing', 'completed', 'failed', name='processingstatus'), nullable=True),
        sa.Column('point_count', sa.BigInteger(), nullable=True),
        sa.Column('bounds', sa.JSON(), nullable=True),
        sa.Column('classification', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('error_message', sa.String(), nullable=True),
        sa.Column('processing_log', sa.String(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_pointclouds_id'), 'pointclouds', ['id'], unique=False)

def downgrade() -> None:
    op.drop_index(op.f('ix_pointclouds_id'), table_name='pointclouds')
    op.drop_table('pointclouds')
    op.execute('DROP TYPE processingstatus')