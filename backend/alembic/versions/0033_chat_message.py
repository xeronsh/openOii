"""Chat agent conversation: one saved pi-agent-core message per row.

The engine's chat agent (ADR 0011) keeps one long-lived conversation per
project. `message` is the pi-agent-core message JSON (user / assistant /
toolResult), so a restarted engine resumes the same conversation.

Revision ID: 0033_chat_message
Revises: 0032_media_options
"""
import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "0033_chat_message"
down_revision = "0032_media_options"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "chat_message" in inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "chat_message",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.String(),
            nullable=False,
            server_default=sa.text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
    )
    op.create_index("ix_chat_message_project", "chat_message", ["project_id", "id"])


def downgrade() -> None:
    if "chat_message" in inspect(op.get_bind()).get_table_names():
        op.drop_index("ix_chat_message_project", table_name="chat_message")
        op.drop_table("chat_message")
