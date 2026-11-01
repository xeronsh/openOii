from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Literal, cast
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.agents.base import AgentContext
from app.agents.review_rules import ReviewAgent
from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404, require_run_id
from app.config import Settings
from app.db.utils import as_naive_utc, utcnow
from app.exceptions import AppException, BusinessError
from app.generated.workflow_contract import GRAPH_STAGE_FOR_AGENT, WORKFLOW_VERSION
from app.models.agent_run import AgentMessage, AgentRun
from app.models.message import Message
from app.models.project import Project, Shot
from app.schemas.project import (
    AgentRunRead,
    CancelRunResponse,
    FeedbackAcceptedResponse,
    FeedbackRequest,
    GateConfirmAcceptedResponse,
    GateFeedbackAcceptedResponse,
    GateFeedbackRequest,
    GenerateRequest,
    PreviousVersionRead,
    ProviderResolution,
    RecoveryControlRead,
    RegenerateEstimateRead,
    RegeneratePlanRead,
    RestoreVersionResponse,
    RunTimingRead,
)
from app.services.run_timing import build_run_timing
from app.services.engine_client import (
    EngineConflictError,
    EngineUnavailableError,
    engine_active_run_ids,
    engine_cancel_run,
    engine_owner_gone,
    engine_resume_run,
    engine_start_run,
    ensure_engine_running,
)
from app.services.generation_entry import decide_generation_entry
from app.services.image_factory import create_image_service
from app.services.project_versions import (
    capture_project_version,
    count_project_entities,
    is_valid_snapshot,
    restore_project_version,
)
from app.services.provider_resolution import (
    resolve_project_provider_settings_async,
    warm_project_text_probe,
)
from app.services.run_context import build_run_context_snapshot
from app.services.run_recovery import build_recovery_control_surface
from app.services.run_intent import build_rerun_intent
from app.services.run_lifecycle import TargetedRunSpec, create_local_run
from app.services.text_factory import create_text_service
from app.services.video_factory import create_video_service
from app.ws.manager import ConnectionManager

router = APIRouter()
logger = logging.getLogger(__name__)

_ACTIVE_RUN_STATUSES = ("queued", "running", "waiting_for_approval", "cancelling")
# Only a run that broke on its own can be continued. A run the user stopped or
# dismissed (cancelled) is over: the project goes back to its last finished state.
_RECOVERABLE_RUN_STATUSES = ("failed",)
_TERMINAL_RUN_STATUSES = {"cancelled", "succeeded", "failed"}
_TERMINAL_RUN_STATUS_TUPLE = ("cancelled", "succeeded", "failed")
EXECUTOR_GONE_ERROR = "Engine restarted; the executor that owned this run is gone; run is safe to resume"
LEASE_EXPIRED_ERROR = (
    "执行中断（引擎租约过期），已完成的步骤都保留着，可以点继续"
    "（Execution lease missing or expired; run is safe to resume）"
)

# A suspended box (or VM pause) freezes the engine's heartbeat while the wall clock
# keeps going, so every lease looks expired on wake. Monotonic time does not count
# the pause; when the two disagree, give the engine a few heartbeats to renew or
# reclaim its lease before calling the run dead.
CLOCK_JUMP_THRESHOLD_SECONDS = 30.0
CLOCK_JUMP_GRACE_SECONDS = 120.0


class _ClockJumpGuard:
    def __init__(self) -> None:
        self._wall = time.time()
        self._mono = time.monotonic()
        self._grace_until = 0.0

    def in_grace(self) -> bool:
        wall, mono = time.time(), time.monotonic()
        jump = (wall - self._wall) - (mono - self._mono)
        self._wall, self._mono = wall, mono
        if jump > CLOCK_JUMP_THRESHOLD_SECONDS:
            self._grace_until = mono + CLOCK_JUMP_GRACE_SECONDS
            logger.warning(
                "wall clock jumped %.0fs past monotonic time (suspend?); lease expiry waits %.0fs",
                jump,
                CLOCK_JUMP_GRACE_SECONDS,
            )
        return mono < self._grace_until


_clock_jump = _ClockJumpGuard()

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
    target_character_ids: list[int] | None = None,
    target_shot_ids: list[int] | None = None,
    force_regenerate: bool = False,
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
                target_character_ids=target_character_ids,
                target_shot_ids=target_shot_ids,
                force_regenerate=force_regenerate,
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
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "ENGINE_UNAVAILABLE",
                "message": str(exc),
                "retryable": True,
                "details": {"run_id": run_id},
            },
        ) from exc


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
) -> tuple[str, dict[str, list[int]], bool]:
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
    routing = await ReviewAgent().run(ctx)

    start_agent = routing.get("start_agent") if isinstance(routing, dict) else None
    if not isinstance(start_agent, str) or start_agent not in GRAPH_STAGE_FOR_AGENT:
        raise ValueError("ReviewAgent returned no valid feedback stage")
    targets = routing.get("target_ids")
    return (
        GRAPH_STAGE_FOR_AGENT[start_agent],
        {
            "character_ids": list(targets.character_ids) if targets else [],
            "shot_ids": list(targets.shot_ids) if targets else [],
        },
        bool(routing.get("target_error")),
    )


async def _classify_pending_feedback(
    *,
    session: AsyncSession,
    settings: Settings,
    ws: ConnectionManager,
    run: AgentRun,
    project: Project,
) -> tuple[dict[str, object], dict[str, object]]:
    run_id = require_run_id(run)
    snapshot = run.context_snapshot if isinstance(run.context_snapshot, dict) else {}
    pending = snapshot.get("pending_feedback")
    required = {"content", "feedback_type", "entity_type", "entity_id", "entity_ids"}
    if not isinstance(pending, dict) or not required.issubset(pending):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "RUN_FEEDBACK_UNRECOVERABLE",
                "message": "Feedback classification input is missing; submit feedback again",
                "details": {"run_id": run_id},
            },
        )
    if pending.get("state") == "needs_target":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=pending.get("error", "请明确选择反馈目标后重新提交。"),
        )
    if pending.get("state") != "pending":
        command = snapshot.get("execution_command")
        if isinstance(command, dict):
            intent = json.loads(run.patch_plan) if run.patch_plan else {}
            return command, intent
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Feedback command is incomplete")

    token = str(uuid4())
    now = utcnow()
    claimed = await session.execute(
        update(AgentRun)
        .where(AgentRun.id == run_id)
        .where(AgentRun.status.in_(("queued", "failed", "cancelled")))
        .where(AgentRun.patch_plan.is_(None))
        .where(AgentRun.cancel_requested_at.is_(None))
        .where(
            or_(
                AgentRun.lease_token.is_(None),
                AgentRun.lease_expires_at.is_(None),
                AgentRun.lease_expires_at <= now,
            )
        )
        .values(
            lease_owner="feedback-classifier",
            lease_token=token,
            lease_expires_at=now + timedelta(minutes=15),
        )
    )
    await session.commit()
    if claimed.rowcount != 1:
        await session.refresh(run)
        latest = run.context_snapshot if isinstance(run.context_snapshot, dict) else {}
        finalized = latest.get("pending_feedback")
        command = latest.get("execution_command")
        if (
            isinstance(finalized, dict)
            and finalized.get("state") == "classified"
            and isinstance(command, dict)
            and run.patch_plan
        ):
            return command, json.loads(run.patch_plan)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "RUN_ALREADY_ACTIVE", "message": "该 run 已有活跃执行器"},
        )
    await session.refresh(run)

    try:
        content = pending["content"]
        if not isinstance(content, str):
            raise ValueError("pending feedback content is invalid")
        entity_ids = pending["entity_ids"]
        if entity_ids is not None and not isinstance(entity_ids, list):
            raise ValueError("pending feedback entity_ids are invalid")
        classified_stage, inferred_targets, target_error = await _route_feedback_to_stage(
            settings=settings,
            ws=ws,
            session=session,
            project=project,
            run=run,
            content=content,
            feedback_type=pending["feedback_type"] if isinstance(pending["feedback_type"], str) else None,
            entity_type=pending["entity_type"] if isinstance(pending["entity_type"], str) else None,
            entity_id=pending["entity_id"] if isinstance(pending["entity_id"], int) else None,
            entity_ids=entity_ids,
        )
        target_issue = (
            "反馈中提到的目标无法准确匹配到本项目实体；请在界面中明确选择目标后重新提交反馈。"
            if target_error
            else None
        )
        explicit_type = pending["entity_type"] if isinstance(pending["entity_type"], str) else None
        explicit_ids = list(entity_ids or [])
        explicit_id = pending["entity_id"] if isinstance(pending["entity_id"], int) else None
        if explicit_type in {"character", "shot", "video"} and (explicit_ids or explicit_id):
            entity_type = "shot" if explicit_type == "video" else explicit_type
            target_ids = explicit_ids + ([explicit_id] if explicit_id is not None else [])
        elif inferred_targets["character_ids"] and inferred_targets["shot_ids"]:
            target_issue = "反馈同时指向角色和分镜，无法用单一目标范围安全重绘；请分开选择目标后重新提交反馈。"
            entity_type, target_ids = None, []
        elif inferred_targets["character_ids"]:
            entity_type, target_ids = "character", inferred_targets["character_ids"]
        elif inferred_targets["shot_ids"]:
            entity_type, target_ids = "shot", inferred_targets["shot_ids"]
        else:
            entity_type, target_ids = explicit_type, explicit_ids
        has_targets = bool(target_ids)
        if entity_type == "shot" and has_targets and classified_stage not in {"render_shots", "compose_videos"}:
            # 选中分镜时的剧情类意见只作用于这几格：带着意见重画它们，不改动其他分镜。
            classified_stage = "render_shots"
        compatible_stage = (
            classified_stage == "render_characters"
            if entity_type == "character" and has_targets
            else classified_stage in {"render_shots", "compose_videos"}
            if entity_type == "shot" and has_targets
            else True
        )
        if not target_issue and not compatible_stage:
            target_issue = (
                "这条意见需要改剧本或分镜脚本，不能只重画选中的内容。"
                "可以取消选中后再发送，或改成画面类意见（例如：重画首帧，改成夜景）。"
            )
        if target_issue:
            rejected_snapshot = {
                **snapshot,
                "pending_feedback": {**pending, "state": "needs_target", "error": target_issue},
            }
            rejected = await session.execute(
                update(AgentRun)
                .where(AgentRun.id == run_id)
                .where(AgentRun.lease_owner == "feedback-classifier")
                .where(AgentRun.lease_token == token)
                .where(AgentRun.lease_expires_at > utcnow())
                .values(
                    status="failed",
                    context_snapshot=rejected_snapshot,
                    lease_owner=None,
                    lease_token=None,
                    lease_expires_at=None,
                )
            )
            await session.commit()
            if rejected.rowcount != 1:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail={"code": "RUN_CANCELLED_OR_CLAIM_LOST", "message": "反馈分类已取消或执行权已过期"},
                )
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=target_issue)
        intent = build_rerun_intent(
            start_stage=classified_stage,
            entity_type=entity_type,
            entity_id=explicit_id if explicit_type and (explicit_ids or explicit_id) else None,
            entity_ids=target_ids,
        )
        scope = intent["scope"]
        command: dict[str, object] = {
            "version": 1,
            "stage": intent["start_stage"],
            "auto_mode": False,
            "user_feedback": content,
            "target_character_ids": scope["entity_ids"] if scope["entity_type"] == "character" else [],
            "target_shot_ids": scope["entity_ids"] if scope["entity_type"] == "shot" else [],
            "force_regenerate": bool(scope["entity_ids"]),
        }
        new_snapshot = {
            **snapshot,
            "pending_feedback": {**pending, "state": "classified"},
            "execution_command": command,
        }
        await session.rollback()
        finalized = await session.execute(
            update(AgentRun)
            .where(AgentRun.id == run_id)
            .where(AgentRun.lease_owner == "feedback-classifier")
            .where(AgentRun.lease_token == token)
            .where(AgentRun.lease_expires_at > utcnow())
            .where(AgentRun.cancel_requested_at.is_(None))
            .where(AgentRun.status != "cancelling")
            .values(
                patch_plan=json.dumps(intent, ensure_ascii=False, sort_keys=True),
                context_snapshot=new_snapshot,
                lease_owner=None,
                lease_token=None,
                lease_expires_at=None,
            )
        )
        await session.commit()
        if finalized.rowcount != 1:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"code": "RUN_CANCELLED_OR_CLAIM_LOST", "message": "反馈分类已取消或执行权已过期"},
            )
        await session.refresh(run)
        return command, intent
    except BaseException:
        await session.rollback()
        await session.execute(
            update(AgentRun)
            .where(AgentRun.id == run_id)
            .where(AgentRun.lease_owner == "feedback-classifier")
            .where(AgentRun.lease_token == token)
            .values(lease_owner=None, lease_token=None, lease_expires_at=None)
        )
        await session.commit()
        raise


def _rejected_feedback(run: AgentRun | None) -> bool:
    """反馈在分类时就被拒绝（目标不明确/不兼容）：没有产物，不该作为可恢复运行出现。"""
    snapshot = run.context_snapshot if run is not None and isinstance(run.context_snapshot, dict) else {}
    pending = snapshot.get("pending_feedback")
    return isinstance(pending, dict) and pending.get("state") == "needs_target"


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


async def _latest_recoverable_run(session: AsyncSession, project_id: int) -> AgentRun | None:
    """The latest finished run, but only when it broke on its own.

    Looking at the latest terminal run (not the latest failed one) matters: an
    old failure must not resurface after a later run succeeded or was stopped.
    """
    latest = await _latest_run_for_project(session, project_id, _TERMINAL_RUN_STATUS_TUPLE)
    return _surface_recoverable(latest)


def _surface_recoverable(run: AgentRun | None) -> AgentRun | None:
    if run is None or run.status not in _RECOVERABLE_RUN_STATUSES or _rejected_feedback(run):
        return None
    return run


PROJECT_RESTORED_AGENT = "version"


def project_restored_text(reason: str) -> str:
    if reason == "restored":
        return "已恢复到上一版"
    return "已停止，项目放回了重新生成之前的版本（成片、角色、分镜都还在）"


def _previous_version(run: AgentRun | None) -> dict[str, object] | None:
    snapshot = run.context_snapshot if run is not None and isinstance(run.context_snapshot, dict) else {}
    previous = snapshot.get("previous_version")
    return previous if is_valid_snapshot(previous) else None


async def _restore_previous_version(
    *, session: AsyncSession, ws: ConnectionManager | None, run: AgentRun, reason: str
) -> bool:
    """Put back what the project looked like before this regenerate.

    Marks the capture as used so it is applied once. Returns whether anything
    in the project changed.
    """
    previous = _previous_version(run)
    if previous is None or previous.get("restored_at"):
        return False
    changed = await restore_project_version(session, run.project_id, previous)
    snapshot = dict(run.context_snapshot or {})
    snapshot["previous_version"] = {**previous, "restored_at": utcnow().isoformat(), "restored_by": reason}
    run.context_snapshot = snapshot
    session.add(run)
    if changed:
        # 活动流里留一条：刷新后也看得出这次停止把上一版放回来了
        session.add(
            Message(
                project_id=run.project_id,
                run_id=run.id,
                agent=PROJECT_RESTORED_AGENT,
                role="assistant",
                content=project_restored_text(reason),
            )
        )
    await session.commit()
    await session.refresh(run)
    if changed and ws is not None:
        await ws.send_event(
            run.project_id,
            {
                "type": "project_restored",
                "data": {"project_id": run.project_id, "run_id": run.id, "reason": reason},
            },
        )
    return changed


_UNSET: Any = object()


async def _settle_stopped_run(
    *,
    session: AsyncSession,
    ws: ConnectionManager | None,
    project_id: int,
    latest: AgentRun | None = _UNSET,
) -> None:
    """A stopped regenerate returns the project to its last finished version.

    The engine terminalises a stop on its own schedule, so this runs on the next
    read after the run is cancelled (and right away when the API cancels it).
    Callers that already loaded the latest terminal run pass it as ``latest``.
    """
    if latest is _UNSET:
        latest = await _latest_run_for_project(session, project_id, _TERMINAL_RUN_STATUS_TUPLE)
    if latest is None or latest.status != "cancelled":
        return
    await _restore_previous_version(session=session, ws=ws, run=latest, reason="stopped")


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
    executor_gone = False
    if run.id in engine_ids:
        return run, None
    if _has_live_lease(run):
        # A live lease normally means a live executor. The exception is an
        # engine that was restarted: the new process answers with another owner
        # id and the old one is gone, so do not wait two minutes for expiry.
        if not await engine_owner_gone(settings.engine_url, run.lease_owner):
            return run, None
        executor_gone = True

    # A cancel requested before the executor died ends as cancelled, not failed.
    cancelled = run.cancel_requested_at is not None
    if not cancelled and not executor_gone and run.lease_token and _clock_jump.in_grace():
        return run, None
    run.status = "cancelled" if cancelled else "failed"
    run.error = None if cancelled else EXECUTOR_GONE_ERROR if executor_gone else LEASE_EXPIRED_ERROR
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
    execution_command: dict[str, object] | None,
    commit: bool = True,
    extra_context: dict[str, object] | None = None,
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
        context_snapshot={
            **context_snapshot,
            **(extra_context or {}),
            **({"execution_command": execution_command} if execution_command is not None else {}),
        },
    )
    session.add(run)
    if commit:
        await session.commit()
        await session.refresh(run)
    else:
        await session.flush()
    return run


@router.get("/projects/{project_id}/runs/current", response_model=RecoveryControlRead | None)
async def get_current_run(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
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

    # One read of the latest terminal run serves both the stop settlement and the
    # recoverable surface (this endpoint is polled; it used to load it twice).
    latest_terminal = await _latest_run_for_project(session, project_id, _TERMINAL_RUN_STATUS_TUPLE)
    await _settle_stopped_run(session=session, ws=ws, project_id=project_id, latest=latest_terminal)
    resumable_run = _surface_recoverable(
        newly_recoverable if newly_recoverable is not None else latest_terminal
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
    if active_run is None:
        await _settle_stopped_run(session=session, ws=None, project_id=project_id)
        await session.refresh(project)
    resumable_run = (
        _surface_recoverable(stale_run)
        if stale_run is not None
        else await _latest_recoverable_run(session, project_id)
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

    # A regenerate is a new version: keep what the project is now so stopping
    # it, or "恢复上一版" afterwards, can put it back.
    previous_version = await capture_project_version(session, project_id)
    run = await _new_run(
        session=session,
        settings=settings,
        project=project,
        provider_resolution=provider_resolution,
        current_agent="orchestrator",
        execution_command={
            "version": 1,
            "stage": "full",
            "auto_mode": bool(payload.auto_mode),
            "user_feedback": "",
            "target_character_ids": [],
            "target_shot_ids": [],
        },
        extra_context={"previous_version": previous_version} if previous_version else None,
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
    run = await get_or_404(session, AgentRun, run_id)
    if run.status in ("succeeded", "cancelled"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": "RUN_NOT_RESUMABLE",
                "message": "已完成的 run 不能恢复"
                if run.status == "succeeded"
                else "已停止的 run 不能恢复，请重新生成",
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

    snapshot = run.context_snapshot if isinstance(run.context_snapshot, dict) else {}
    pending = snapshot.get("pending_feedback")
    if isinstance(pending, dict) and pending.get("state") == "pending":
        project = await get_or_404(session, Project, run.project_id)
        await _classify_pending_feedback(
            session=session,
            settings=settings,
            ws=ws,
            run=run,
            project=project,
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
    if run.status == "failed":
        # 取消 on an interrupted run dismisses it: it stops being offered as
        # resumable and a regenerate that broke puts the previous version back.
        dismissed = await session.execute(
            update(AgentRun)
            .where(AgentRun.id == run_id)
            .where(AgentRun.status == "failed")
            .values(
                status="cancelled",
                cancel_requested_at=utcnow(),
                awaiting_payload=None,
                lease_owner=None,
                lease_token=None,
                lease_expires_at=None,
            )
        )
        await session.commit()
        if dismissed.rowcount != 1:
            return CancelRunResponse(status="no_active_run")
        await session.refresh(run)
        await _restore_previous_version(session=session, ws=ws, run=run, reason="dismissed")
        await ws.send_event(
            run.project_id,
            {
                "type": "run_cancelled",
                "data": {
                    "run_id": run_id,
                    "project_id": run.project_id,
                    "cancelled_count": 1,
                    "run_ids": [run_id],
                },
            },
        )
        return CancelRunResponse(status="cancelled", cancelled=1, run_ids=[run_id])
    if run.status in _TERMINAL_RUN_STATUSES:
        return CancelRunResponse(status="no_active_run")

    project_id = run.project_id
    if run.lease_owner == "feedback-classifier":
        cancelled = await session.execute(
            update(AgentRun)
            .where(AgentRun.id == run_id)
            .where(AgentRun.lease_owner == "feedback-classifier")
            .values(
                status="cancelled",
                cancel_requested_at=utcnow(),
                lease_owner=None,
                lease_token=None,
                lease_expires_at=None,
            )
        )
        await session.commit()
        if cancelled.rowcount == 1:
            await ws.send_event(
                project_id,
                {"type": "run_cancelled", "data": {
                    "run_id": run_id, "project_id": project_id,
                    "cancelled_count": 1, "run_ids": [run_id],
                }},
            )
            return CancelRunResponse(status="cancelled", cancelled=1, run_ids=[run_id])
        await session.refresh(run)
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
        await _restore_previous_version(session=session, ws=ws, run=run, reason="stopped")
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
    "/runs/{run_id}/confirm",
    response_model=GateConfirmAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def confirm_gate(
    run_id: int,
    session: AsyncSession = SessionDep,
):
    """Approve the gate a run is waiting at.

    Same signal as the WS ``confirm`` message, but with an answer: 409 when
    the run is not at a gate or a change request is still being redone.
    """
    from app.services.run_signals import GateFeedbackRejected, approve_gate

    run = await get_or_404(session, AgentRun, run_id)
    try:
        await approve_gate(run_id, project_id=run.project_id)
    except GateFeedbackRejected as exc:
        raise AppException(message=str(exc), code=exc.code, status_code=status.HTTP_409_CONFLICT) from exc
    return GateConfirmAcceptedResponse(run_id=run_id)


@router.post(
    "/runs/{run_id}/gate-feedback",
    response_model=GateFeedbackAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def gate_feedback(
    run_id: int,
    payload: GateFeedbackRequest,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Request changes at the gate a run is waiting at.

    Records the decision only. The engine redoes the gate's stage with this
    feedback and returns to the same gate; it never counts as an approval.
    """
    from app.services.run_signals import GateFeedbackRejected, submit_gate_feedback

    run = await get_or_404(session, AgentRun, run_id)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Feedback content cannot be blank")
    if payload.entity_ids and payload.entity_type is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Selected feedback targets require entity_type"
        )
    try:
        feedback = await submit_gate_feedback(
            run_id,
            project_id=run.project_id,
            content=content,
            entity_type=payload.entity_type,
            entity_ids=payload.entity_ids,
        )
    except GateFeedbackRejected as exc:
        raise AppException(message=str(exc), code=exc.code, status_code=status.HTTP_409_CONFLICT) from exc

    await session.refresh(run)
    awaiting = run.awaiting_payload if isinstance(run.awaiting_payload, dict) else {}
    await ws.send_event(
        run.project_id,
        {
            "type": "run_feedback",
            "data": {
                "run_id": run_id,
                "project_id": run.project_id,
                "gate": awaiting.get("gate") or run.current_agent,
                "stage": awaiting.get("current_stage"),
                "feedback_id": feedback["id"],
                "round": feedback["round"],
                "state": "received",
                "content": content,
                "entity_type": feedback.get("entity_type"),
                "entity_ids": feedback.get("entity_ids"),
            },
        },
    )
    return GateFeedbackAcceptedResponse(
        run_id=run_id, feedback_id=str(feedback["id"]), round=feedback.get("round")
    )


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
    if not payload.content.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Feedback content cannot be blank")
    if (payload.entity_id is not None or payload.entity_ids) and payload.entity_type not in {"character", "shot", "video"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Selected feedback targets require a valid entity_type")

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
    newly_recoverable = _surface_recoverable(newly_recoverable)
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

    source_run = await session.get(AgentRun, payload.run_id) if payload.run_id is not None else None
    if payload.run_id is not None and (source_run is None or source_run.project_id != project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Source run not found in project")
    content = payload.content
    unique_entity_ids = list(dict.fromkeys(payload.entity_ids)) if payload.entity_ids else None
    run = await _new_run(
        session=session,
        settings=settings,
        project=project,
        provider_resolution=provider_resolution,
        current_agent="review",
        execution_command=None,
        commit=False,
    )
    run.context_snapshot = {
        **(run.context_snapshot or {}),
        "pending_feedback": {
            "version": 1,
            "state": "pending",
            "content": content,
            "run_id": payload.run_id,
            "feedback_type": payload.feedback_type,
            "entity_type": payload.entity_type,
            "entity_id": payload.entity_id,
            "entity_ids": unique_entity_ids,
        },
    }
    run_id = require_run_id(run)
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
    command, intent = await _classify_pending_feedback(
        session=session,
        settings=settings,
        ws=ws,
        run=run,
        project=project,
    )
    scope = intent["scope"]
    await _dispatch_to_engine(
        settings=settings,
        project_id=project_id,
        run_id=run_id,
        stage=str(command["stage"]),
        auto_mode=False,
        user_feedback=content,
        target_character_ids=scope["entity_ids"] if scope["entity_type"] == "character" else None,
        target_shot_ids=scope["entity_ids"] if scope["entity_type"] == "shot" else None,
        force_regenerate=bool(scope["entity_ids"]),
    )
    return FeedbackAcceptedResponse(run_id=run_id)


# Rough per-call durations for the 重新生成 estimate when there is no history.
_EST_TEXT_STAGE_S = 50
_EST_IMAGE_S = 35
_EST_VIDEO_S = 110
_EST_MERGE_S = 20
_REGENERATE_STAGES = ["故事大纲", "角色设定", "分镜脚本", "角色形象图", "分镜画面", "视频片段", "成片"]


def _is_full_run(run: AgentRun) -> bool:
    snapshot = run.context_snapshot if isinstance(run.context_snapshot, dict) else {}
    command = snapshot.get("execution_command")
    return isinstance(command, dict) and command.get("stage") == "full"


async def _latest_full_run(session: AsyncSession, project_id: int) -> AgentRun | None:
    res = await session.execute(
        select(AgentRun)
        .where(AgentRun.project_id == project_id)
        .order_by(cast(InstrumentedAttribute[datetime], cast(object, AgentRun.created_at)).desc())
        .limit(20)
    )
    for run in res.scalars().all():
        if _is_full_run(run):
            return run
    return None


def _previous_version_read(run: AgentRun) -> PreviousVersionRead | None:
    previous = _previous_version(run)
    if previous is None:
        return None
    project = previous.get("project") if isinstance(previous.get("project"), dict) else {}
    characters = previous.get("characters") if isinstance(previous.get("characters"), list) else []
    shots = previous.get("shots") if isinstance(previous.get("shots"), list) else []
    restored_at = previous.get("restored_at")
    return PreviousVersionRead(
        run_id=require_run_id(run),
        run_status=run.status,
        captured_at=str(previous.get("captured_at")) if previous.get("captured_at") else None,
        video_url=project.get("video_url") if isinstance(project.get("video_url"), str) else None,
        character_count=len(characters),
        shot_count=len(shots),
        restorable=run.status in _TERMINAL_RUN_STATUSES and not restored_at,
        restored_at=str(restored_at) if restored_at else None,
    )


@router.get("/runs/{run_id}/timing", response_model=RunTimingRead)
async def get_run_timing(run_id: int, session: AsyncSession = SessionDep) -> RunTimingRead:
    """Elapsed time per stage and overall, plus a rough remaining estimate."""
    run = await get_or_404(session, AgentRun, run_id)
    return await build_run_timing(session, run)


@router.post(
    "/projects/{project_id}/runs/recompose",
    response_model=AgentRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def recompose_project(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
) -> AgentRunRead:
    """重新合成: re-mix and re-concatenate the existing clips only.

    After a single-shot regen the final cut is stale but every clip is
    current, so only compose_merge needs to run, not the whole pipeline.
    """
    await get_or_404(session, Project, project_id)
    shots = (await session.execute(select(Shot).where(Shot.project_id == project_id))).scalars().all()
    if not shots or any(not shot.video_url for shot in shots):
        raise AppException(
            message="还有分镜没有视频，先补齐分镜视频再合成",
            code="CLIPS_MISSING",
            status_code=status.HTTP_409_CONFLICT,
        )
    active = await session.execute(
        select(AgentRun.id)
        .where(AgentRun.project_id == project_id)
        .where(AgentRun.status.in_(("queued", "running")))
        .limit(1)
    )
    if active.first() is not None:
        raise AppException(
            message="项目还有运行在进行，结束后再合成",
            code="RUN_ACTIVE",
            status_code=status.HTTP_409_CONFLICT,
        )
    result = await create_local_run(
        session,
        settings=settings,
        ws=ws,
        spec=TargetedRunSpec(
            project_id=project_id,
            resource_type="project",
            resource_id=project_id,
            stage="compose_merge",
        ),
    )
    return AgentRunRead.model_validate(result.run)


@router.get("/projects/{project_id}/runs/regenerate-plan", response_model=RegeneratePlanRead)
async def regenerate_plan(
    project_id: int,
    warm: bool = False,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
) -> RegeneratePlanRead:
    """What 重新生成 would redo, so the confirm dialog can say it before it runs."""
    project = await get_or_404(session, Project, project_id)
    if warm:
        # The open dialog is the moment before a start: warm the provider probe
        # so the start itself does not wait on it. Plain reads (menus) do not
        # pay for a probe.
        warm_project_text_probe(project, settings)
    character_count, shot_count = await count_project_entities(session, project_id)
    planned_characters = character_count or max(len(project.character_hints or []), 2)
    planned_shots = shot_count or (project.target_shot_count or 4)
    text_calls = 3 + 2  # outline, characters, shots + two critique passes
    image_calls = planned_characters + planned_shots
    video_calls = planned_shots
    seconds = (
        3 * _EST_TEXT_STAGE_S
        + image_calls * _EST_IMAGE_S
        + video_calls * _EST_VIDEO_S
        + _EST_MERGE_S
    )
    basis: Literal["history", "heuristic"] = "heuristic"
    latest_full = await _latest_full_run(session, project_id)
    if latest_full is not None and latest_full.status == "succeeded":
        snapshot = latest_full.context_snapshot if isinstance(latest_full.context_snapshot, dict) else {}
        command = snapshot.get("execution_command")
        auto = isinstance(command, dict) and command.get("auto_mode") is True
        elapsed = (as_naive_utc(latest_full.updated_at) - as_naive_utc(latest_full.created_at)).total_seconds()
        # Only an auto run measures generation alone; a manual run includes the
        # time the user spent at each gate.
        if auto and 60 <= elapsed <= 4 * 3600:
            seconds = int(elapsed)
            basis = "history"
    return RegeneratePlanRead(
        project_id=project_id,
        has_content=bool(character_count or shot_count or project.video_url),
        character_count=character_count,
        shot_count=shot_count,
        has_final_video=bool(project.video_url),
        stages=_REGENERATE_STAGES,
        estimate=RegenerateEstimateRead(
            seconds_low=int(seconds * (0.8 if basis == "history" else 0.6)),
            seconds_high=int(seconds * (1.3 if basis == "history" else 1.6)),
            text_calls=text_calls,
            image_calls=image_calls,
            video_calls=video_calls,
            basis=basis,
        ),
        previous_version=_previous_version_read(latest_full) if latest_full is not None else None,
    )


@router.post("/runs/{run_id}/restore-previous", response_model=RestoreVersionResponse)
async def restore_previous_version(
    run_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
) -> RestoreVersionResponse:
    """恢复上一版: put back the version this regenerate replaced.

    Only for a finished run (stopping an active one already restores) and only
    for the project's latest regenerate, so an older capture never overwrites a
    newer version.
    """
    run = await get_or_404(session, AgentRun, run_id)
    previous = _previous_version(run)
    if previous is None:
        raise AppException(
            message="这次运行没有保存上一版", code="NO_PREVIOUS_VERSION", status_code=status.HTTP_409_CONFLICT
        )
    if previous.get("restored_at"):
        return RestoreVersionResponse(run_id=run_id, restored=False)
    if run.status not in _TERMINAL_RUN_STATUSES:
        raise AppException(
            message="运行还在进行，先停止它（停止会自动回到上一版）",
            code="RUN_STILL_ACTIVE",
            status_code=status.HTTP_409_CONFLICT,
        )
    active = await _latest_run_for_project(session, run.project_id, _ACTIVE_RUN_STATUSES)
    if active is not None:
        raise AppException(
            message="项目有正在进行的运行，先停止它", code="RUN_STILL_ACTIVE", status_code=status.HTTP_409_CONFLICT
        )
    latest_full = await _latest_full_run(session, run.project_id)
    if latest_full is None or latest_full.id != run.id:
        raise AppException(
            message="之后又重新生成过，这一版已经不是上一版",
            code="PREVIOUS_VERSION_STALE",
            status_code=status.HTTP_409_CONFLICT,
        )
    changed = await _restore_previous_version(session=session, ws=ws, run=run, reason="restored")
    return RestoreVersionResponse(run_id=run_id, restored=changed)
