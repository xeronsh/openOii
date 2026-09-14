"""Add optimistic-concurrency revision to product entities.

FastAPI (HTTP CRUD) and the engine (generation) both write `project`,
`character` and `shot`. SQLite serialises the transactions but cannot decide
*whose* write wins: a user edit based on revision 17 and a generation write
based on revision 17 could both land, last-writer-wins, silently discarding
one of them. `busy_timeout` only handles lock contention, not this.

A revision column plus a compare-and-set update makes the conflict explicit:
the writer states the revision it read, and a stale write affects zero rows.

Revision ID: 0026_entity_revision
Revises: 0025_stage_attempt_input_snapshot
"""

from alembic import op
import sqlalchemy as sa

revision = "0026_entity_revision"
down_revision = "0025_stage_attempt_input_snapshot"
branch_labels = None
depends_on = None

TABLES = ("project", "character", "shot")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(
            table,
            sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        )


def downgrade() -> None:
    for table in TABLES:
        op.drop_column(table, "revision")
