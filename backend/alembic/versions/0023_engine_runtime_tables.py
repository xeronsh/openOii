"""Create durable workflow engine event/checkpoint tables.

The Node executor must not run its own schema migration path. Alembic is the
single schema authority for the shared SQLite database.

Revision ID: 0023_engine_runtime_tables
Revises: 0022_run_execution_lease
"""

from alembic import op
import sqlalchemy as sa

revision = "0023_engine_runtime_tables"
down_revision = "0022_run_execution_lease"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "engine_run_events",
        sa.Column("seq", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.String(),
            nullable=False,
            server_default=sa.text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
    )
    op.create_index(
        "idx_engine_run_events_run",
        "engine_run_events",
        ["run_id", "seq"],
        unique=False,
    )
    op.create_index(
        "idx_engine_run_events_project",
        "engine_run_events",
        ["project_id", "seq"],
        unique=False,
    )

    op.create_table(
        "engine_checkpoints",
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("stage", sa.String(), nullable=False),
        sa.Column("state_json", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.String(),
            nullable=False,
            server_default=sa.text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
        sa.PrimaryKeyConstraint("run_id", "stage"),
    )


def downgrade() -> None:
    op.drop_table("engine_checkpoints")
    op.drop_index("idx_engine_run_events_project", table_name="engine_run_events")
    op.drop_index("idx_engine_run_events_run", table_name="engine_run_events")
    op.drop_table("engine_run_events")
