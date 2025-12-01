"""Create classification color schemes table

Revision ID: 010_class_colors
Revises: 009_add_cluster_job_cancellation
Create Date: 2025-11-26 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "010_class_colors"
down_revision: Union[str, None] = "009_add_cluster_job_cancellation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if "classification_color_schemes" not in inspector.get_table_names():
        op.create_table(
            'classification_color_schemes',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('classification_value', sa.Integer(), nullable=False),
            sa.Column('name', sa.String(), nullable=False),
            sa.Column('color', sa.String(), nullable=False),
            sa.Column('auto_generated', sa.Boolean(), server_default='false', nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('classification_value')
        )
        op.create_index('ix_classification_color_schemes_id', 'classification_color_schemes', ['id'], unique=False)
        op.create_index('ix_classification_color_schemes_classification_value', 'classification_color_schemes', ['classification_value'], unique=True)

        # Seed with defaults from baseClassificationDefinitions
        default_colors = [
            (1, 'Unclassified', '#9CA3AF'),
            (2, 'Ground', '#8B4513'),
            (3, 'Low Veg', '#4CAF50'),
            (4, 'Medium Veg', '#22C55E'),
            (5, 'High Veg', '#16A34A'),
            (6, 'Building', '#F97316'),
            (7, 'Noise', '#F59E0B'),
            (8, 'Model Key-Point', '#A855F7'),
            (9, 'Water', '#2563EB'),
            (12, 'Overlap', '#C084FC'),
            (13, 'Wire Guard', '#FACC15'),
            (14, 'Wire - Conductor', '#FDE68A'),
            (15, 'Utility Structure', '#FBBF24'),
            (16, 'Wire - Guy Wire', '#FACC15'),
            (17, 'Wire - Secondary', '#EAB308'),
        ]

        for value, name, color in default_colors:
            op.execute(f"""
                INSERT INTO classification_color_schemes (classification_value, name, color, auto_generated)
                VALUES ({value}, '{name}', '{color}', false)
            """)


def downgrade() -> None:
    op.drop_index('ix_classification_color_schemes_classification_value', table_name='classification_color_schemes')
    op.drop_index('ix_classification_color_schemes_id', table_name='classification_color_schemes')
    op.drop_table('classification_color_schemes')
