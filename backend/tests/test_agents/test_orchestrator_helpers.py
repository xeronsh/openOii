"""Run confirm signal / awaiting payload 与 stage 映射的单元测试。

（原 GenerationOrchestrator 的图执行体已移除：编排在 pi 引擎，
阶段推进与闸门状态由 engine/src/pipeline/runner.ts 承担并落 engine_checkpoints。）
"""

from __future__ import annotations

import pytest

from app.orchestration import PHASE2_STAGE_ORDER, next_production_stage
from app.services.run_signals import (
    GRAPH_STAGE_FOR_AGENT,
    STAGE_AGENT_MAP,
    clear_awaiting_payload,
    clear_confirm_signal,
    get_awaiting_payload,
    resume_agent_for_stage,
    store_awaiting_payload,
    trigger_confirm_signal,
    wait_for_confirm_signal,
)
from tests.factories import create_project, create_run


class TestStageContract:
    def test_stage_order_is_gate_inclusive_and_ordered(self):
        # add_audio (stub, no AudioService caller) and the review terminal stage
        # were removed from the contract; compose_approval is now the last stage.
        assert len(PHASE2_STAGE_ORDER) == 15
        assert PHASE2_STAGE_ORDER[0] == "plan_outline"
        assert PHASE2_STAGE_ORDER[-1] == "compose_approval"
        assert "add_audio" not in PHASE2_STAGE_ORDER
        assert "review" not in PHASE2_STAGE_ORDER

    def test_every_stage_has_an_agent(self):
        for stage in PHASE2_STAGE_ORDER:
            assert stage in STAGE_AGENT_MAP, f"{stage} missing from STAGE_AGENT_MAP"

    def test_graph_stage_for_agent_points_at_real_stages(self):
        for agent, stage in GRAPH_STAGE_FOR_AGENT.items():
            assert stage in PHASE2_STAGE_ORDER, f"{agent} → {stage} 不在阶段表内"

    def test_resume_agent_for_stage_falls_back_to_plan(self):
        assert resume_agent_for_stage(None) == "plan"
        assert resume_agent_for_stage("not-a-stage") == "plan"
        assert resume_agent_for_stage("render_shots") == "render"

    def test_recovery_agent_map_matches_signal_map(self):
        for agent, stage in GRAPH_STAGE_FOR_AGENT.items():
            assert GRAPH_STAGE_FOR_AGENT[agent] == stage

    def test_next_production_stage_skips_gates(self):
        assert next_production_stage("plan_outline") == "plan_characters"
        assert next_production_stage("add_audio") is None
        assert next_production_stage(None) is None



# ---------------------------------------------------------------------------
# Run confirm signal / awaiting payload（agentrun 列，跨进程可见）
# ---------------------------------------------------------------------------


@pytest.fixture
async def signal_db(test_db_engine_sessionmaker, monkeypatch):
    """把 app.db.session.async_session_maker 指到测试 sessionmaker。"""
    _, session_maker = test_db_engine_sessionmaker
    monkeypatch.setattr("app.db.session.async_session_maker", session_maker)
    return session_maker


async def test_trigger_confirm_signal_sets_flag(signal_db, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    assert await trigger_confirm_signal(run.id) is True
    await test_session.refresh(run)
    assert run.confirm_requested is True


async def test_trigger_confirm_signal_missing_run_is_noop(signal_db):
    assert await trigger_confirm_signal(424242) is True


async def test_wait_for_confirm_signal_consumes_flag(signal_db, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    await trigger_confirm_signal(run.id)
    assert await wait_for_confirm_signal(run.id, timeout=2) is True
    await test_session.refresh(run)
    assert run.confirm_requested is False


async def test_wait_for_confirm_signal_times_out(signal_db, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    assert await wait_for_confirm_signal(run.id, timeout=1) is False


async def test_clear_confirm_signal_missing_run_is_noop(signal_db):
    await clear_confirm_signal(424242)


async def test_awaiting_payload_roundtrip(signal_db, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    assert await get_awaiting_payload(run.id) is None
    payload = {"gate": "outline", "run_id": run.id, "message": "确认大纲"}
    await store_awaiting_payload(run.id, payload)
    assert await get_awaiting_payload(run.id) == payload
    await clear_awaiting_payload(run.id)
    assert await get_awaiting_payload(run.id) is None


async def test_get_awaiting_payload_missing_run_returns_none(signal_db):
    assert await get_awaiting_payload(404) is None
