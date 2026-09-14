"""Durable execution lease and immutable workflow context for agentrun.

Revision ID: 0022_run_execution_lease
Revises: 0021_run_confirm_signal
"""

from alembic import op
import sqlalchemy as sa

revision = "0022_run_execution_lease"
down_revision = "0021_run_confirm_signal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agentrun",
        sa.Column("workflow_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "agentrun",
        sa.Column("execution_attempt", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("agentrun", sa.Column("lease_owner", sa.String(), nullable=True))
    op.add_column("agentrun", sa.Column("lease_token", sa.String(), nullable=True))
    op.add_column("agentrun", sa.Column("lease_expires_at", sa.DateTime(), nullable=True))
    op.add_column("agentrun", sa.Column("cancel_requested_at", sa.DateTime(), nullable=True))
    op.add_column("agentrun", sa.Column("context_snapshot", sa.JSON(), nullable=True))
    op.create_index("ix_agentrun_lease_token", "agentrun", ["lease_token"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_agentrun_lease_token", table_name="agentrun")
    op.drop_column("agentrun", "context_snapshot")
    op.drop_column("agentrun", "cancel_requested_at")
    op.drop_column("agentrun", "lease_expires_at")
    op.drop_column("agentrun", "lease_token")
    op.drop_column("agentrun", "lease_owner")
    op.drop_column("agentrun", "execution_attempt")
    op.drop_column("agentrun", "workflow_version")
