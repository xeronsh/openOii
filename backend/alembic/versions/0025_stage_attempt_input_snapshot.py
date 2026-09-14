"""Add frozen stage input snapshot to durable stage attempts.

Crash/replay identity previously keyed on `input_hash` recomputed from the
live database. A stage mutates `character`/`shot`/`project` before it commits
its checkpoint, so after a crash the recomputed hash no longer matched the
interrupted row: the engine created a brand-new attempt with a new
idempotency key and could call the provider twice for one operation.

The snapshot freezes the authoritative stage input *before* any side effect,
so resume reuses the original attempt identity instead of re-deriving it.

Revision ID: 0025_stage_attempt_input_snapshot
Revises: 0024_engine_stage_attempts
"""

from alembic import op
import sqlalchemy as sa

revision = "0025_stage_attempt_input_snapshot"
down_revision = "0024_engine_stage_attempts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "engine_stage_attempts",
        sa.Column("input_snapshot", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("engine_stage_attempts", "input_snapshot")
