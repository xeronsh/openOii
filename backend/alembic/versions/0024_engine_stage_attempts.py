"""Add durable per-stage execution attempts.

Execution is intentionally at-least-once. A stage attempt records the stable
input fingerprint and idempotency key before any provider side effect, so a
resume can reuse the same operation identity instead of pretending the process
has exactly-once delivery.

Revision ID: 0024_engine_stage_attempts
Revises: 0023_engine_runtime_tables
"""

from alembic import op
import sqlalchemy as sa

revision = "0024_engine_stage_attempts"
down_revision = "0023_engine_runtime_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "engine_stage_attempts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("stage_attempt_id", sa.String(64), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(64), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("execution_attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("provider_request_id", sa.String(255), nullable=True),
        sa.Column("result_json", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "started_at",
            sa.String(),
            nullable=False,
            server_default=sa.text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
        sa.Column(
            "updated_at",
            sa.String(),
            nullable=False,
            server_default=sa.text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
        sa.UniqueConstraint("stage_attempt_id", name="uq_engine_stage_attempt_id"),
        sa.UniqueConstraint("idempotency_key", name="uq_engine_stage_idempotency_key"),
        sa.UniqueConstraint("run_id", "stage", "attempt", name="uq_engine_stage_attempt_number"),
    )
    op.create_index(
        "idx_engine_stage_attempts_run_stage",
        "engine_stage_attempts",
        ["run_id", "stage", "attempt"],
        unique=False,
    )
    op.create_index(
        "idx_engine_stage_attempts_status",
        "engine_stage_attempts",
        ["status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_engine_stage_attempts_status", table_name="engine_stage_attempts")
    op.drop_index("idx_engine_stage_attempts_run_stage", table_name="engine_stage_attempts")
    op.drop_table("engine_stage_attempts")
