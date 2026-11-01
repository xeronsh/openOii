from typing import Optional

from sqlalchemy import Column, Index, String, text
from sqlmodel import Field, SQLModel


class ChatMessage(SQLModel, table=True):
    """Chat agent conversation row; written by the engine (ADR 0011, migration 0033)."""

    __tablename__ = "chat_message"  # pyright: ignore[reportAssignmentType]
    __table_args__ = (Index("ix_chat_message_project", "project_id", "id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int
    message: str  # pi-agent-core message JSON
    created_at: Optional[str] = Field(
        default=None,
        sa_column=Column(
            String,
            nullable=False,
            server_default=text("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
        ),
    )
