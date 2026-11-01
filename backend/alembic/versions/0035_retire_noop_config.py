"""Drop settings that never had a runtime effect.

LOG_LEVEL, TEXT_ENABLE_THINKING, CRITIQUE_VISION_PROVIDER, OUTLINE_ENABLED and
DOUBAO_GENERATE_AUDIO were removed from Settings; old .env lines are ignored.
Data-only, so there is nothing to downgrade.

Revision ID: 0035_retire_noop_config
Revises: 0034_cleanup_orphans
"""
import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "0035_retire_noop_config"
down_revision = "0034_cleanup_orphans"
branch_labels = None
depends_on = None

_RETIRED = ("LOG_LEVEL", "TEXT_ENABLE_THINKING", "CRITIQUE_VISION_PROVIDER", "OUTLINE_ENABLED", "DOUBAO_GENERATE_AUDIO")


def upgrade() -> None:
    bind = op.get_bind()
    if "configitem" not in inspect(bind).get_table_names():
        return
    bind.execute(
        sa.text("DELETE FROM configitem WHERE upper(key) IN :keys").bindparams(sa.bindparam("keys", expanding=True)),
        {"keys": list(_RETIRED)},
    )


def downgrade() -> None:
    pass
