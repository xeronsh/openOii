from __future__ import annotations

import json
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
from app.db.utils import utcnow
from app.exceptions import BusinessError
from app.generated.workflow_contract import WORKFLOW_VERSION
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
)
from app.services.engine_client import (
    EngineConflictError,
    EngineUnavailableError,
    engine_active_run_ids,
    engine_cancel_run,
    engine_resume_run,
    engine_start_run,
    ensure_engine_running,
)
from app.services.generation_entry import decide_generation_entry
from app.services.image_factory import create_image_service
from app.services.invalidation import build_invalidation_plan
from app.services.provider_resolution import resolve_project_provider_settings_async
from app.services.run_context import build_run_context_snapshot
from app.services.run_recovery import build_recovery_control_surface
from app.services.text_factory import create_text_service
from app.services.video_factory import create_video_service
from app.ws.manager import ConnectionManager

router = APIRouter()
logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = ("queued", "running", "waiting_for_approval", "cancelling")
_RECOVERABLE_RUN_STATUSES = ("failed", "cancelled")
_TERMINAL_RUN_STATUSES = {"cancelled", "succeeded", "failed"}

# ReviewAgent 的 start_agent → 引擎可从该阶段起跑
_AGENT_TO_START_STAGE: dict[str, str] = {
    "outline": "plan_outline",
    "plan": "plan_characters",
    "render": "render_characters",
    "compose": "compose_videos",
}


def _has_live_lease(run: AgentRun) -> bool:
    return bool(
        run.lease_token
        and run.lease_expires_at is not None
        and run.lease_expires_at > utcnow()
    )


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
    """Ensure a compatible engine owns this run or return a stable API error.

    This is the sanctioned shape for the architecture constraint (ADR 0008):
    FastAPI is only the northbound gateway — it forwards the request to the
    engine and lets the engine decide every orchestration step. New generation
    capabilities must be added the same way, not as in-process agent loops.
    """
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
    except EngineConflictError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": exc.code,
                "message": str(exc),
                "details": {"run_id": run_id},
            },
        ) from exc
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
    """Use ReviewAgent only to classify the deterministic rerun boundary."""
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
    except Exception:  # noqa: BLE001 - routing is best-effort, feedback must not disappear
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


async def _reconcile_active_candidate(
    *,
    session: AsyncSession,
    settings: Settings,
    run: AgentRun | None,
) -> tuple[AgentRun | None, AgentRun | None]:
    """Return (active, recoverable) for an active-status candidate.

    A durable unexpired lease counts as active even if the HTTP health probe is
    momentarily unavailable. Without a live lease or process-local runner, the
    row is converted to failed/recoverable instead of blocking the project
    forever as a zombie queued/running row.
    """
    if run is None:
        return None, None

    engine_ids = await engine_active_run_ids(settings.engine_url)
    if run.id in engine_ids or _has_live_lease(run):
        return run, None

    run.status = "failed"
    run.error = "Execution lease missing or expired; run is safe to resume"
    run.lease_owner = None
    run.lease_token = None
    run.lease_expires_at = None
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return None, run


async def _new_run(
    *,
    session: AsyncSession,
    settings: Settings,
    project: Project,
    provider_resolution: ProviderResolution,
    current_agent: str,
) -> AgentRun:
    provider_snapshot = provider_resolution.as_project_provider_settings().model_dump(mode="json")
    context_snapshot = await build_run_context_snapshot(
        session=session,
        settings=settings,
        project=project,
        provider_resolution=provider_resolution,
    )
    run = AgentRun(
        project_id=project.id or 0,
        status="queued",
        current_agent=current_agent,
        progress=0.0,
        provider_snapshot=provider_snapshot,
        workflow_version=WORKFLOW_VERSION,
        context_snapshot=context_snapshot,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


@router.get("/projects/{project_id}/runs/current", response_model=RecoveryControlRead | None)
async def get_current_run(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
) -> RecoveryControlRead | None:
    await get_or_404(session, Project, project_id)

    candidate = await _latest_run_for_project(session, project_id, _ACTIVE_RUN_STATUSES)
    active_run, newly_recoverable = await _reconcile_active_candidate(
        session=session,
        settings=settings,
        run=candidate,
    )
    if active_run is not None:
        return await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=active_run,
            state="active",
        )

    resumable_run = newly_recoverable or await _latest_run_for_project(
        session, project_id, _RECOVERABLE_RUN_STATUSES
    )
    if resumable_run is not None:
        return await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=resumable_run,
            state="recoverable",
        )
    return None


@router.post(
    "/projects/{project_id}/runs",
    response_model=AgentRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def start_run(
    project_id: int,
    payload: GenerateRequest,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    del ws  # creation is command-only; realtime delivery is event-log driven
    project = await get_or_404(session, Project, project_id)

    candidate = await _latest_run_for_project(session, project_id, _ACTIVE_RUN_STATUSES)
    active_run, stale_run = await _reconcile_active_candidate(
        session=session,
        settings=settings,
        run=candidate,
    )
    resumable_run = stale_run or await _latest_run_for_project(
        session, project_id, _RECOVERABLE_RUN_STATUSES
    )

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
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=control.model_dump(mode="json"))

    if decision.kind == "recoverable_conflict":
        assert decision.run is not None
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=decision.run,
            state="recoverable",
        )
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=control.model_dump(mode="json"))

    if decision.kind == "provider_blocked":
        raise BusinessError(
            message="项目 Provider 配置无效，无法启动生成",
            code="PROVIDER_PRECHECK_FAILED",
            details={"provider_resolution": provider_resolution.as_error_details()},
        )

    run = await _new_run(
        session=session,
        settings=settings,
        project=project,
        provider_resolution=provider_resolution,
        current_agent="orchestrator",
    )
    run_id = require_run_id(run)

    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        stage="full",
        auto_mode=bool(payload.auto_mode),
    )
    # Command acceptance is represented by the durable queued row. Do not
    # refresh here: whether the sidecar has already acquired its lease is a race
    # and must not make this API response nondeterministically queued/running.
    return AgentRunRead.model_validate(run)


@router.post("/runs/{run_id}/resume", response_model=AgentRunRead)
async def resume_run(
    run_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    del ws
    run = await get_or_404(session, AgentRun, run_id)
    if run.status == "succeeded":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "RUN_NOT_RESUMABLE",
                "message": "已完成的 run 不能恢复",
                "details": {"run_id": run_id},
            },
        )
    if _has_live_lease(run):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "RUN_ALREADY_ACTIVE",
                "message": "该 run 已有活跃执行器",
                "details": {"run_id": run_id},
            },
        )

    await _dispatch_to_engine(
        settings=settings,
        project_id=run.project_id,
        run_id=run_id,
        resume=True,
    )
    await session.refresh(run)
    return AgentRunRead.model_validate(run)


@router.post(
    "/runs/{run_id}/cancel",
    response_model=CancelRunResponse,
    status_code=status.HTTP_200_OK,
)
async def cancel_run(
    run_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Persist cancellation intent; terminal state belongs to the executor."""
    run = await get_or_404(session, AgentRun, run_id)
    if run.status in _TERMINAL_RUN_STATUSES:
        return CancelRunResponse(status="no_active_run")

    project_id = run.project_id
    live_lease = _has_live_lease(run)
    run.cancel_requested_at = utcnow()
    run.status = "cancelling"
    session.add(run)
    await session.commit()

    # Every run is engine-owned now (ADR 0008), so a run without a live lease
    # has no executor to signal and can be terminalised synchronously.
    if not live_lease:
        run.status = "cancelled"
        run.awaiting_payload = None
        session.add(run)
        await session.commit()
        await ws.send_event(
            project_id,
            {
                "type": "run_cancelled",
                "data": {
                    "run_id": run_id,
                    "project_id": project_id,
                    "cancelled_count": 1,
                    "run_ids": [run_id],
                },
            },
        )
        return CancelRunResponse(status="cancelled", cancelled=1, run_ids=[run_id])

    # The DB cancellation flag is authoritative, so a transient control-plane
    # HTTP failure does not lose the user's request. The runner will observe the
    # flag after the current provider call/poll boundary.
    try:
        await engine_cancel_run(settings.engine_url, run_id)
    except EngineUnavailableError:
        logger.warning("engine cancel signal failed for run %s; DB intent is durable", run_id)

    return CancelRunResponse(status="cancelling", run_ids=[run_id])


@router.post(
    "/projects/{project_id}/runs/feedback",
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

    candidate = await _latest_run_for_project(session, project_id, _ACTIVE_RUN_STATUSES)
    active_run, newly_recoverable = await _reconcile_active_candidate(
        session=session,
        settings=settings,
        run=candidate,
    )
    if active_run is not None:
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=active_run,
            state="active",
        )
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=control.model_dump(mode="json"))
    if newly_recoverable is not None:
        control = await build_recovery_control_surface(
            session=session,
            database_url=settings.database_url,
            run=newly_recoverable,
            state="recoverable",
        )
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=control.model_dump(mode="json"))

    provider_resolution: ProviderResolution = await resolve_project_provider_settings_async(
        project, settings
    )
    if not provider_resolution.valid:
        raise BusinessError(
            message="项目 Provider 配置无效，无法处理反馈",
            code="PROVIDER_PRECHECK_FAILED",
            details={"provider_resolution": provider_resolution.as_error_details()},
        )

    run = await _new_run(
        session=session,
        settings=settings,
        project=project,
        provider_resolution=provider_resolution,
        current_agent="review",
    )
    run_id = require_run_id(run)

    content = payload.content.strip()
    session.add(AgentMessage(run_id=run_id, agent="user", role="user", content=content))
    session.add(
        Message(
            project_id=project_id,
            run_id=run_id,
            agent="user",
            role="user",
            content=content,
        )
    )
    await session.commit()

    classified_stage = await _route_feedback_to_stage(
        settings=settings,
        ws=ws,
        session=session,
        project=project,
        run=run,
        content=content,
        feedback_type=payload.feedback_type,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        entity_ids=payload.entity_ids,
    )
    invalidation_plan = build_invalidation_plan(
        start_stage=classified_stage,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        entity_ids=payload.entity_ids,
    )
    run.patch_plan = json.dumps(invalidation_plan, ensure_ascii=False, sort_keys=True)
    session.add(run)
    await session.commit()

    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        stage=invalidation_plan["start_stage"],
        auto_mode=False,
        user_feedback=content,
    )
    return FeedbackAcceptedResponse(run_id=run_id)
