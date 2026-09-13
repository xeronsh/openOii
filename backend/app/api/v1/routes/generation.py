from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from datetime import datetime
from typing import cast

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.agents.orchestrator import GenerationOrchestrator
from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404, require_run_id
from app.config import Settings
from app.db.session import async_session_maker
from app.exceptions import BusinessError
from app.models.agent_run import AgentMessage, AgentRun
from app.models.message import Message
from app.models.project import Project
from app.schemas.project import (
    AgentRunRead,
    FeedbackRequest,
    GenerateRequest,
    ProviderResolution,
    RecoveryControlRead,
    ResumeRequest,
)
from app.services.engine_client import (
    EngineUnavailableError,
    engine_cancel_run,
    engine_resume_run,
    engine_start_run,
    ensure_engine_running,
)
from app.services.generation_entry import decide_generation_entry
from app.services.provider_resolution import resolve_project_provider_settings_async
from app.services.run_recovery import build_recovery_control_surface
from app.services.task_manager import task_manager
from app.ws.manager import ConnectionManager

router = APIRouter(prefix="/projects")
logger = logging.getLogger(__name__)


async def _start_project_task(project_id: int, coro: Coroutine[object, object, None]) -> None:
    task = asyncio.create_task(coro)

    def _log_task_result(done_task: asyncio.Task[None]) -> None:
        try:
            done_task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Background project task failed", extra={"project_id": project_id})

    task.add_done_callback(_log_task_result)
    task_manager.register(project_id, task)


def _agent_run_thread_id(run: AgentRun) -> str:
    return f"agent-run-{run.id}" if run.id is not None else "agent-run-pending"


def _require_run_id(run: AgentRun) -> int:
    return require_run_id(run)


async def _latest_run_for_project(
    session: AsyncSession, project_id: int, statuses: tuple[str, ...]
) -> AgentRun | None:
    project_id_col = cast(InstrumentedAttribute[int], cast(object, AgentRun.project_id))
    status_col = cast(InstrumentedAttribute[str], cast(object, AgentRun.status))
    created_at_col = cast(InstrumentedAttribute[datetime], cast(object, AgentRun.created_at))
    res = await session.execute(
        select(AgentRun)
        .where(project_id_col == project_id)
        .where(status_col.in_(statuses))
        .order_by(created_at_col.desc())
        .limit(1)
    )
    return res.scalars().first()


@router.get("/{project_id}/generation-state", response_model=RecoveryControlRead | None)
async def get_generation_state(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
) -> RecoveryControlRead | None:
    """页面加载时的运行态水合入口。

    与 /generate 的 409 分支返回同一份 RecoveryControlRead，
    让前端不必先撞一次冲突才能发现可恢复的运行。
    """
    await get_or_404(session, Project, project_id)

    active_run = await _latest_run_for_project(session, project_id, ("queued", "running"))
    if active_run is not None:
        return await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=active_run,
            state="active" if task_manager.is_running(project_id) else "recoverable",
        )

    resumable_run = await _latest_run_for_project(session, project_id, ("failed", "cancelled"))
    if resumable_run is not None:
        return await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=resumable_run,
            state="recoverable",
        )

    return None


@router.post(
    "/{project_id}/generate", response_model=AgentRunRead, status_code=status.HTTP_201_CREATED
)
async def generate_project(
    project_id: int,
    payload: GenerateRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    project = await get_or_404(session, Project, project_id)

    active_run = await _latest_run_for_project(session, project_id, ("queued", "running"))
    resumable_run = await _latest_run_for_project(session, project_id, ("failed", "cancelled"))

    provider_resolution: ProviderResolution = await resolve_project_provider_settings_async(
        project, settings
    )
    decision = decide_generation_entry(
        active_run=active_run,
        resumable_run=resumable_run,
        provider_resolution=provider_resolution,
    )

    if decision.kind == "active_conflict":
        assert decision.run is not None
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=decision.run,
            state="active",
        )
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=control.model_dump(mode="json"),
        )

    if decision.kind == "recoverable_conflict":
        assert decision.run is not None
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=decision.run,
            state="recoverable",
        )
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=control.model_dump(mode="json"),
        )
    if decision.kind == "provider_blocked":
        raise BusinessError(
            message="项目 Provider 配置无效，无法启动生成",
            code="PROVIDER_PRECHECK_FAILED",
            details={"provider_resolution": provider_resolution.as_error_details()},
        )

    provider_snapshot = provider_resolution.as_project_provider_settings().model_dump(mode="json")
    run = AgentRun(
        project_id=project_id,
        status="running",
        current_agent="orchestrator",
        progress=0.0,
        provider_snapshot=provider_snapshot,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    run_id = _require_run_id(run)

    async def _task() -> None:
        try:
            async with async_session_maker() as task_session:
                orchestrator = GenerationOrchestrator(
                    settings=settings, ws=ws, session=task_session
                )
                await orchestrator.run(
                    project_id=project_id,
                    run_id=run_id,
                    request=payload,
                    auto_mode=payload.auto_mode,
                )
        except asyncio.CancelledError:
            # 任务被取消，更新数据库状态
            async with async_session_maker() as cancel_session:
                run_obj = await cancel_session.get(AgentRun, run_id)
                if run_obj and run_obj.status not in ("cancelled", "failed", "succeeded"):
                    run_obj.status = "cancelled"
                    await cancel_session.commit()
            raise
        finally:
            task_manager.remove(project_id)

    if settings.agent_engine == "pi" and settings.database_url.startswith("sqlite"):
        from app.main import STATIC_DIR

        try:
            await ensure_engine_running(settings.engine_url, settings.database_url, STATIC_DIR)
            await engine_start_run(
                settings.engine_url,
                project_id=project_id,
                run_id=run_id,
                stage="full",
                auto_mode=bool(payload.auto_mode),
            )
        except EngineUnavailableError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
        run.status = "running"
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return AgentRunRead.model_validate(run)

    background_tasks.add_task(_start_project_task, project_id, _task())
    return AgentRunRead.model_validate(run)


@router.post("/{project_id}/resume", response_model=AgentRunRead)
async def resume_project_run(
    project_id: int,
    payload: ResumeRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    await get_or_404(session, Project, project_id)

    run = await get_or_404(session, AgentRun, payload.run_id)
    if run.project_id != project_id:
        raise HTTPException(status_code=404, detail="Run not found")

    if run.status in ("queued", "running") and task_manager.is_running(project_id):
        return AgentRunRead.model_validate(run)

    run_id = payload.run_id

    async def _task() -> None:
        try:
            async with async_session_maker() as task_session:
                orchestrator = GenerationOrchestrator(
                    settings=settings, ws=ws, session=task_session
                )
                await orchestrator.resume_from_recovery(project_id=project_id, run_id=run_id)
        except asyncio.CancelledError:
            async with async_session_maker() as cancel_session:
                run_obj = await cancel_session.get(AgentRun, run_id)
                if run_obj and run_obj.status not in ("cancelled", "failed", "succeeded"):
                    run_obj.status = "cancelled"
                    await cancel_session.commit()
            raise
        finally:
            task_manager.remove(project_id)

    if settings.agent_engine == "pi" and settings.database_url.startswith("sqlite"):
        from app.main import STATIC_DIR

        try:
            await ensure_engine_running(settings.engine_url, settings.database_url, STATIC_DIR)
            await engine_resume_run(settings.engine_url, project_id=project_id, run_id=run_id)
        except EngineUnavailableError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
        run.status = "running"
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return AgentRunRead.model_validate(run)

    background_tasks.add_task(_start_project_task, project_id, _task())
    return AgentRunRead.model_validate(run)


@router.post("/{project_id}/cancel", status_code=status.HTTP_200_OK)
async def cancel_project_run(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """取消项目的当前运行任务"""
    await get_or_404(session, Project, project_id)

    # 先取消实际的后台任务
    task_cancelled = task_manager.cancel(project_id)
    if settings.agent_engine == "pi" and settings.database_url.startswith("sqlite"):
        active = await _latest_run_for_project(session, project_id, ("queued", "running"))
        if active is not None:
            await engine_cancel_run(settings.engine_url, active.id)

    # 更新数据库状态
    project_id_col = cast(InstrumentedAttribute[int], cast(object, AgentRun.project_id))
    status_col = cast(InstrumentedAttribute[str], cast(object, AgentRun.status))
    res = await session.execute(
        select(AgentRun)
        .where(project_id_col == project_id)
        .where(status_col.in_(("queued", "running")))
    )
    runs = res.scalars().all()

    if not runs and not task_cancelled:
        return {"status": "no_active_run", "cancelled": 0}

    cancelled_count = 0
    for run in runs:
        run.status = "cancelled"
        cancelled_count += 1

    await session.commit()

    # 通知前端任务已取消
    await ws.send_event(
        project_id,
        {
            "type": "run_cancelled",
            "data": {
                "project_id": project_id,
                "cancelled_count": cancelled_count,
                "run_ids": [r.id for r in runs],
            },
        },
    )

    return {"status": "cancelled", "cancelled": cancelled_count}


@router.post("/{project_id}/feedback", status_code=status.HTTP_202_ACCEPTED)
async def feedback_project(
    project_id: int,
    payload: FeedbackRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    project = await get_or_404(session, Project, project_id)

    active_run = await _latest_run_for_project(session, project_id, ("queued", "running"))
    if active_run is not None:
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=active_run,
            state="active",
        )
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=control.model_dump(mode="json"),
        )

    provider_resolution: ProviderResolution = await resolve_project_provider_settings_async(
        project, settings
    )
    provider_snapshot = provider_resolution.as_project_provider_settings().model_dump(mode="json")

    run = AgentRun(
        project_id=project_id,
        status="queued",
        current_agent="review",
        progress=0.0,
        provider_snapshot=provider_snapshot,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    run_id = _require_run_id(run)

    msg = AgentMessage(run_id=run_id, agent="user", role="user", content=payload.content)
    session.add(msg)
    await session.commit()

    # 同步写入聊天消息表，方便前端展示反馈内容
    session.add(
        Message(
            project_id=project_id,
            run_id=run_id,
            agent="user",
            role="user",
            content=payload.content,
        )
    )
    await session.commit()

    async def _task() -> None:
        try:
            async with async_session_maker() as task_session:
                orchestrator = GenerationOrchestrator(
                    settings=settings, ws=ws, session=task_session
                )
                await orchestrator.run_from_agent(
                    project_id=project_id,
                    run_id=run_id,
                    request=GenerateRequest(notes=payload.content),
                    agent_name="review",
                    auto_mode=False,
                    feedback_type=payload.feedback_type,
                    entity_type=payload.entity_type,
                    entity_id=payload.entity_id,
                    entity_ids=payload.entity_ids,
                )
        except asyncio.CancelledError:
            # 任务被取消，更新数据库状态
            async with async_session_maker() as cancel_session:
                run_obj = await cancel_session.get(AgentRun, run_id)
                if run_obj and run_obj.status not in ("cancelled", "failed", "succeeded"):
                    run_obj.status = "cancelled"
                    await cancel_session.commit()
            raise
        finally:
            task_manager.remove(project_id)

    background_tasks.add_task(_start_project_task, project_id, _task())
    return {"status": "accepted", "run_id": run_id}
