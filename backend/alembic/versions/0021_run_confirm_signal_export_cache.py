"""Run confirm signal + awaiting payload columns, export cache table.

Phase 1 of the pi-core/SQLite migration: replace the Redis confirm key and
awaiting-payload cache with agentrun columns, and the Redis export cache with
a TTL table.

Revision ID: 0021_run_confirm_signal
Revises: 0020_project_skill_reimagine
"""

from alembic import op
import sqlalchemy as sa

revision = "0021_run_confirm_signal"
down_revision = "0020_project_skill_reimagine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agentrun",
        sa.Column("confirm_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("agentrun", sa.Column("awaiting_payload", sa.JSON(), nullable=True))
    op.create_table(
        "exportcache",
        sa.Column("export_id", sa.String(length=64), primary_key=True),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("exportcache")
    op.drop_column("agentrun", "awaiting_payload")
    op.drop_column("agentrun", "confirm_requested")
