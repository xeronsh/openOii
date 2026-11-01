"""Chat assistant routes: a thin proxy to the engine's chat agent (ADR 0011).

The engine runs the pi-agent-core agent and saves the conversation; replies
stream to the browser as ``chat_message`` / ``chat_status`` WS events.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SessionDep, SettingsDep, get_or_404
from app.config import Settings
from app.models.project import Project
from app.schemas.chat import ChatConfirm, ChatSend, ChatState
from app.services.engine_client import EngineUnavailableError, engine_chat, ensure_engine_running

router = APIRouter()


async def _engine(
    session: AsyncSession,
    settings: Settings,
    project_id: int,
    action: str = "",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from app.main import STATIC_DIR

    await get_or_404(session, Project, project_id)
    try:
        await ensure_engine_running(settings.engine_url, settings.database_url, STATIC_DIR)
        code, payload = await engine_chat(settings.engine_url, project_id, action, body)
    except EngineUnavailableError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "ENGINE_UNAVAILABLE", "message": str(exc), "retryable": True},
        ) from exc
    if code >= 400:
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        raise HTTPException(
            code if code in (404, 409, 422) else status.HTTP_502_BAD_GATEWAY,
            detail={"code": error.get("code", "CHAT_FAILED"), "message": error.get("message", "chat failed")},
        )
    return payload


@router.get("/projects/{project_id}/chat", response_model=ChatState)
async def get_chat(project_id: int, session: AsyncSession = SessionDep, settings: Settings = SettingsDep) -> dict[str, Any]:
    return await _engine(session, settings, project_id)


@router.post("/projects/{project_id}/chat", status_code=status.HTTP_202_ACCEPTED)
async def send_chat(
    project_id: int, payload: ChatSend, session: AsyncSession = SessionDep, settings: Settings = SettingsDep
) -> dict[str, Any]:
    return await _engine(session, settings, project_id, body=payload.model_dump())


@router.post("/projects/{project_id}/chat/abort")
async def abort_chat(project_id: int, session: AsyncSession = SessionDep, settings: Settings = SettingsDep) -> dict[str, Any]:
    return await _engine(session, settings, project_id, "abort")


@router.post("/projects/{project_id}/chat/confirm")
async def confirm_chat(
    project_id: int, payload: ChatConfirm, session: AsyncSession = SessionDep, settings: Settings = SettingsDep
) -> dict[str, Any]:
    """The user's yes/no on a write tool. Workflow approval gates are not reachable from here."""
    return await _engine(session, settings, project_id, "confirm", payload.model_dump())
