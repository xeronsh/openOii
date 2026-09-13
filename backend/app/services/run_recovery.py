"""Run recovery summary.

State source is the engine's own checkpoint table (`engine_checkpoints`, owned by
the pi sidecar) plus the project's persisted artifacts. The former LangGraph
checkpointer path is gone: the sidecar is the only orchestration engine.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, cast

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.models.agent_run import AgentRun
from app.models.project import Character, Shot
from app.orchestration import PHASE2_STAGE_ORDER, PRODUCTION_STAGE_SEQUENCE
from app.services.run_signals import GRAPH_STAGE_FOR_AGENT
from app.schemas.project import (
    AgentRunRead,
    RecoveryControlRead,
    RecoveryStageRead,
    RecoverySummaryRead,
)

def thread_id_for_run(run: AgentRun) -> str:
    """稳定 thread id（run 未落库时用 pending 占位）。"""
    return f"agent-run-{run.id}" if run.id is not None else "agent-run-pending"


def _safe_stage_name(value: Any) -> str | None:
    if isinstance(value, str) and value in PHASE2_STAGE_ORDER:
        return value
    return None


async def _engine_checkpoint_stages(session: AsyncSession, run_id: int | None) -> list[str]:
    """Completed production stages recorded by the pi engine.

    Returns [] when the engine table is absent (e.g. an older DB) so callers
    degrade to the agent-derived stage instead of failing.
    """
    if run_id is None:
        return []
    try:
        result = await session.execute(
            text("SELECT stage FROM engine_checkpoints WHERE run_id = :run_id"),
            {"run_id": run_id},
        )
        rows = {row[0] for row in result.all()}
    except Exception:  # noqa: BLE001 - table missing on un-migrated SQLite
        return []
    return [stage for stage in PRODUCTION_STAGE_SEQUENCE if stage in rows]


def _infer_current_stage(run: AgentRun, completed: Sequence[str]) -> str:
    if completed:
        index = PRODUCTION_STAGE_SEQUENCE.index(completed[-1])
        if index + 1 < len(PRODUCTION_STAGE_SEQUENCE):
            return PRODUCTION_STAGE_SEQUENCE[index + 1]
        return completed[-1]
    mapped_stage = GRAPH_STAGE_FOR_AGENT.get(run.current_agent or "")
    if mapped_stage is not None:
        return mapped_stage
    return "plan_outline"


async def _stage_artifact_counts(session: AsyncSession, project_id: int) -> dict[str, int]:
    """Per-stage entity counts derived from persisted project entities.

    The legacy Stage/Artifact tables have no writer under the pi engine; the
    entities themselves are the durable record, so count those instead.
    """
    project_id_col = cast(InstrumentedAttribute[int], cast(object, Character.project_id))
    shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
    character_count = func.count(cast(Any, Character.id))
    shot_count = func.count(cast(Any, Shot.id))

    chars = await session.execute(
        select(character_count).select_from(Character).where(project_id_col == project_id)
    )
    shots = await session.execute(
        select(shot_count).select_from(Shot).where(shot_project_id_col == project_id)
    )
    character_total = int(chars.scalar() or 0)
    shot_total = int(shots.scalar() or 0)
    if character_total == 0 and shot_total == 0:
        return {}
    return {
        "plan_characters": character_total,
        "plan_shots": shot_total,
    }


async def build_recovery_summary(
    *,
    session: AsyncSession,
    database_url: str = "",
    run: AgentRun,
) -> RecoverySummaryRead:
    _ = database_url  # kept for call-site compatibility; engine state is DB-resident
    run_id = run.id
    run_pk = run_id if run_id is not None else 0
    completed_stages = await _engine_checkpoint_stages(session, run_id)
    current_stage = _infer_current_stage(run, completed_stages)
    artifact_counts = await _stage_artifact_counts(session, run.project_id)

    stage_history = [
        RecoveryStageRead(
            name=stage,
            status="current"
            if stage == current_stage
            else "completed"
            if stage in completed_stages
            else "pending",
            artifact_count=artifact_counts.get(stage, 0),
        )
        for stage in PHASE2_STAGE_ORDER
    ]

    preserved_stages = [stage.name for stage in stage_history if stage.status == "completed"]

    return RecoverySummaryRead(
        project_id=run.project_id,
        run_id=run_pk,
        thread_id=thread_id_for_run(run),
        current_stage=current_stage,
        next_stage=current_stage,
        preserved_stages=preserved_stages,
        stage_history=stage_history,
        resumable=run.status in {"queued", "running", "failed", "cancelled"},
    )


async def build_recovery_control_surface(
    *,
    session: AsyncSession,
    database_url: str = "",
    run: AgentRun,
    state: Literal["active", "recoverable"],
) -> RecoveryControlRead:
    summary = await build_recovery_summary(session=session, database_url=database_url, run=run)
    detail = (
        "Project already has an active run" if state == "active" else "Project has a resumable run"
    )
    return RecoveryControlRead(
        state=state,
        detail=detail,
        thread_id=summary.thread_id,
        active_run=AgentRunRead.model_validate(run),
        recovery_summary=summary,
    )
