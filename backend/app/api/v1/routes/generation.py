from __future__ import annotations

import logging
from datetime import datetime
from typing import cast

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.agents.base import AgentContext
from app.agents.review_rules import ReviewAgent
from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404, require_run_id
from app.config import Settings
from app.exceptions import BusinessError
from app.models.agent_run import AgentMessage, AgentRun
from app.models.message import Message
from app.models.project import Project
from app.orchestration import PHASE2_STAGE_ORDER, PRODUCTION_STAGE_SEQUENCE
from app.schemas.project import (
    AgentRunRead,
    CancelRunResponse,
    FeedbackAcceptedResponse,
    FeedbackRequest,
    GenerateRequest,
    ProviderResolution,
    RecoveryControlRead,
    ResumeRequest,
)
from app.services.engine_client import (
    EngineUnavailableError,
    engine_active_run_ids,
    engine_cancel_run,
    engine_resume_run,
    engine_start_run,
    ensure_engine_running,
)
from app.services.generation_entry import decide_generation_entry
from app.services.image_factory import create_image_service
from app.services.provider_resolution import resolve_project_provider_settings_async
from app.services.run_recovery import build_recovery_control_surface
from app.services.task_manager import task_manager
from app.services.text_factory import create_text_service
from app.services.video_factory import create_video_service
from app.ws.manager import ConnectionManager

router = APIRouter(prefix="/projects")
logger = logging.getLogger(__name__)

# ReviewAgent 的 start_agent → 引擎可从该阶段起跑
_AGENT_TO_START_STAGE: dict[str, str] = {
    "outline": "plan_outline",
    "plan": "plan_characters",
    "render": "render_characters",
    "compose": "compose_videos",
}


async def _dispatch_to_engine(
    *,
    settings: Settings,
    project_id: int,
    run_id: int,
    stage: str = "full",
    auto_mode: bool = False,
    user_feedback: str = "",
    resume: bool = False,
) -> None:
    """保证引擎在跑并发起 run；引擎不可用时回 503。"""
    from app.main import STATIC_DIR

    try:
        await ensure_engine_running(settings.engine_url, settings.database_url, STATIC_DIR)
        if resume:
            await engine_resume_run(settings.engine_url, project_id=project_id, run_id=run_id)
        else:
            await engine_start_run(
                settings.engine_url,
                project_id=project_id,
                run_id=run_id,
                stage=stage,
                auto_mode=auto_mode,
                user_feedback=user_feedback,
            )
    except EngineUnavailableError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


async def _route_feedback_to_stage(
    *,
    settings: Settings,
    ws: ConnectionManager,
    session: AsyncSession,
    project: Project,
    run: AgentRun,
    content: str,
    feedback_type: str | None,
    entity_type: str | None,
    entity_id: int | None,
    entity_ids: list[int] | None,
) -> str:
    """用 ReviewAgent 把用户反馈路由到具体重跑阶段（含画布选区优先级）。

    路由失败回退到全量重跑，不让反馈丢失。
    """
    ctx = AgentContext(
        settings=settings,
        session=session,
        ws=ws,
        project=project,
        run=run,
        llm=create_text_service(settings),
        image=create_image_service(settings),
        video=create_video_service(settings),
        user_feedback=content,
        feedback_type=feedback_type,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_ids=list(dict.fromkeys(entity_ids)) if entity_ids else None,
    )
    try:
        routing = await ReviewAgent().run(ctx)
    except Exception:  # noqa: BLE001 - 路由是尽力而为，失败退回全量
        logger.warning("ReviewAgent routing failed; falling back to full re-plan", exc_info=True)
        return PRODUCTION_STAGE_SEQUENCE[0]

    start_agent = routing.get("start_agent") if isinstance(routing, dict) else None
    stage = _AGENT_TO_START_STAGE.get(start_agent or "", PRODUCTION_STAGE_SEQUENCE[0])
    if stage not in PHASE2_STAGE_ORDER:
        return PRODUCTION_STAGE_SEQUENCE[0]
    return stage


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
        running = await engine_active_run_ids(settings.engine_url)
        return await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=active_run,
            state="active" if active_run.id in running else "recoverable",
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
    run_id = require_run_id(run)

    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        stage="full",
        auto_mode=bool(payload.auto_mode),
    )
    run.status = "running"
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return AgentRunRead.model_validate(run)


@router.post("/{project_id}/resume", response_model=AgentRunRead)
async def resume_project_run(
    project_id: int,
    payload: ResumeRequest,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    await get_or_404(session, Project, project_id)

    run = await get_or_404(session, AgentRun, payload.run_id)
    if run.project_id != project_id:
        raise HTTPException(status_code=404, detail="Run not found")

    run_id = payload.run_id

    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        resume=True,
    )
    run.status = "running"
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return AgentRunRead.model_validate(run)


@router.post(
    "/{project_id}/cancel",
    response_model=CancelRunResponse,
    status_code=status.HTTP_200_OK,
)
async def cancel_project_run(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """取消项目的当前运行任务"""
    await get_or_404(session, Project, project_id)

    # 两处都要取消：引擎里的编排 run，以及 Python 内的局部长任务（单体重绘/合成
    # 仍走本地 agent，见 characters/shots/projects 的 regenerate 路由）。
    task_cancelled = task_manager.cancel(project_id)
    active = await _latest_run_for_project(session, project_id, ("queued", "running"))
    if active is not None and active.id is not None:
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
        return CancelRunResponse(status="no_active_run")

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

    return CancelRunResponse(
        status="cancelled",
        cancelled=cancelled_count,
        run_ids=[r.id for r in runs if r.id is not None],
    )


@router.post(
    "/{project_id}/feedback",
    response_model=FeedbackAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def feedback_project(
    project_id: int,
    payload: FeedbackRequest,
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
    run_id = require_run_id(run)

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

    # 反馈语义：先由 ReviewAgent 决定从哪个阶段重跑，再让引擎从该阶段起跑。
    user_feedback = payload.content.strip()
    start_stage = await _route_feedback_to_stage(
        settings=settings,
        ws=ws,
        session=session,
        project=project,
        run=run,
        content=user_feedback,
        feedback_type=payload.feedback_type,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        entity_ids=payload.entity_ids,
    )
    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        stage=start_stage,
        auto_mode=False,
        user_feedback=user_feedback,
    )
    run.status = "running"
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return FeedbackAcceptedResponse(run_id=run_id)
