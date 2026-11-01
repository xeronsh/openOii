"""Drop the retired FAKE_TEXT_RESPONSE setting and rows left by deleted projects.

Project deletion now also removes engine and chat rows; this clears what older
deletions left behind. Data-only, so there is nothing to downgrade.

Revision ID: 0034_cleanup_orphans
Revises: 0033_chat_message
"""
import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "0034_cleanup_orphans"
down_revision = "0033_chat_message"
branch_labels = None
depends_on = None

_DELETES = {
    "configitem": "DELETE FROM configitem WHERE key = 'FAKE_TEXT_RESPONSE'",
    "engine_run_events": "DELETE FROM engine_run_events WHERE project_id NOT IN (SELECT id FROM project)",
    "engine_checkpoints": "DELETE FROM engine_checkpoints WHERE run_id NOT IN (SELECT id FROM agentrun)",
    "engine_stage_attempts": "DELETE FROM engine_stage_attempts WHERE run_id NOT IN (SELECT id FROM agentrun)",
    "chat_message": "DELETE FROM chat_message WHERE project_id NOT IN (SELECT id FROM project)",
}


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(inspect(bind).get_table_names())
    for table, sql in _DELETES.items():
        if table in tables:
            bind.execute(sa.text(sql))


def downgrade() -> None:
    pass
