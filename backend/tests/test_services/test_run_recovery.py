"""Recovery summary: stage arithmetic + engine-checkpoint-driven resume.

The former LangGraph snapshot readers (``_stage_from_snapshot`` etc.) are gone;
resume state now comes from the pi engine's ``engine_checkpoints`` table.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.orchestration import PHASE2_STAGE_ORDER
from app.services.run_recovery import (
    AGENT_TO_STAGE,
    _engine_checkpoint_stages,
    _infer_current_stage,
    _thread_id_for_run,
    _safe_stage_name,
    build_recovery_summary,
)
from app.orchestration import PRODUCTION_STAGE_SEQUENCE
from tests.factories import create_project, create_run


class FakeRun:
    def __init__(self, id=None, current_agent=None, project_id=1, status="running"):
        self.id = id
        self.current_agent = current_agent
        self.project_id = project_id
        self.status = status


# --- _thread_id_for_run ---


def test_thread_id_with_id():
    assert _thread_id_for_run(FakeRun(id=42)) == "agent-run-42"


def test_thread_id_pending():
    assert _thread_id_for_run(FakeRun(id=None)) == "agent-run-pending"


# --- _safe_stage_name ---


def test_safe_stage_name_valid():
    assert _safe_stage_name("plan_characters") == "plan_characters"
    assert _safe_stage_name("review") == "review"


def test_safe_stage_name_invalid():
    assert _safe_stage_name("not_a_stage") is None
    assert _safe_stage_name(None) is None
    assert _safe_stage_name(123) is None


# --- _infer_current_stage ---


def test_infer_current_stage_prefers_next_after_last_completed():
    run = FakeRun(current_agent="render")
    assert _infer_current_stage(run, ["plan_outline"]) == "plan_characters"


def test_infer_current_stage_at_end_of_sequence_stays_put():
    run = FakeRun(current_agent="compose")
    assert _infer_current_stage(run, ["add_audio"]) == "add_audio"


def test_infer_current_stage_falls_back_to_agent():
    assert _infer_current_stage(FakeRun(current_agent="render"), []) == "render_characters"
    assert _infer_current_stage(FakeRun(current_agent="review"), []) == "review"


def test_infer_current_stage_defaults_to_first_stage():
    assert _infer_current_stage(FakeRun(current_agent=None), []) == "plan_outline"
    assert _infer_current_stage(FakeRun(current_agent="bogus"), []) == "plan_outline"


# --- engine_checkpoint_stages (DB) ---


async def test_engine_checkpoint_stages_empty_for_unknown_run(test_session: AsyncSession):
    assert await _engine_checkpoint_stages(test_session, 999999) == []


async def test_engine_checkpoint_stages_ignores_missing_run_id(test_session: AsyncSession):
    assert await _engine_checkpoint_stages(test_session, None) == []


async def test_engine_checkpoint_stages_returns_production_order(
    test_session: AsyncSession,
):
    """写入乱序 checkpoint，读回来必须是生产阶段顺序。"""
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    from sqlalchemy import text

    await test_session.execute(
        text(
            "CREATE TABLE IF NOT EXISTS engine_checkpoints ("
            "run_id INTEGER NOT NULL, stage TEXT NOT NULL, state_json TEXT NOT NULL, "
            "updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_id, stage))"
        )
    )
    for stage in ("render_characters", "plan_outline", "not_a_stage"):
        await test_session.execute(
            text("INSERT OR REPLACE INTO engine_checkpoints (run_id, stage, state_json) VALUES (:r, :s, '{}')"),
            {"r": run.id, "s": stage},
        )
    await test_session.commit()

    stages = await _engine_checkpoint_stages(test_session, run.id)
    assert stages == ["plan_outline", "render_characters"]


# --- build_recovery_summary ---


async def test_recovery_summary_shape(test_session: AsyncSession):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    summary = await build_recovery_summary(session=test_session, run=run)

    assert summary.project_id == project.id
    assert summary.run_id == run.id
    assert summary.thread_id == f"agent-run-{run.id}"
    assert len(summary.stage_history) == len(PHASE2_STAGE_ORDER)
    assert summary.stage_history[0].name == PRODUCTION_STAGE_SEQUENCE[0]
    assert summary.resumable is True


async def test_recovery_summary_marks_completed_stages(test_session: AsyncSession):
    from sqlalchemy import text

    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    await test_session.execute(
        text(
            "CREATE TABLE IF NOT EXISTS engine_checkpoints ("
            "run_id INTEGER NOT NULL, stage TEXT NOT NULL, state_json TEXT NOT NULL, "
            "updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_id, stage))"
        )
    )
    await test_session.execute(
        text("INSERT OR REPLACE INTO engine_checkpoints (run_id, stage, state_json) VALUES (:r, 'plan_outline', '{}')"),
        {"r": run.id},
    )
    await test_session.commit()

    summary = await build_recovery_summary(session=test_session, run=run)

    completed = [s.name for s in summary.stage_history if s.status == "completed"]
    assert "plan_outline" in completed
    assert summary.current_stage == "plan_characters"
    assert "plan_outline" in summary.preserved_stages


def test_agent_to_stage_map_targets_real_stages():
    for agent, stage in AGENT_TO_STAGE.items():
        assert stage in PHASE2_STAGE_ORDER, f"{agent} → {stage} 不在阶段表内"


@pytest.mark.parametrize("status", ["queued", "running", "failed", "cancelled"])
async def test_recovery_summary_resumable_for_active_statuses(
    test_session: AsyncSession, status: str
):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    run.status = status
    test_session.add(run)
    await test_session.commit()

    summary = await build_recovery_summary(session=test_session, run=run)
    assert summary.resumable is True
