"""Chat assistant contract (ADR 0011). The engine owns the conversation."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChatItem(BaseModel):
    """One saved message as the UI shows it."""

    id: int
    role: Literal["user", "assistant", "tool"]
    text: str = ""
    tool: str | None = None
    ok: bool | None = None
    error: str | None = None


class ChatConfirmCard(BaseModel):
    """A write tool waiting for the user's yes/no."""

    tool_call_id: str
    tool: str
    summary: str


class ChatState(BaseModel):
    messages: list[ChatItem] = Field(default_factory=list)
    busy: bool = False
    text: str = ""
    pending: ChatConfirmCard | None = None


class ChatSend(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


class ChatConfirm(BaseModel):
    tool_call_id: str = Field(min_length=1)
    approved: bool


class ChatMessageEventData(BaseModel):
    project_id: int
    message: ChatItem


class ChatStatusEventData(BaseModel):
    project_id: int
    busy: bool
    text: str = ""
    pending: ChatConfirmCard | None = None
