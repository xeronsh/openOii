"""Targeted unit tests for orchestrator helpers, run confirm signal and cleanup logic."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.agents.orchestrator import (
    GenerationOrchestrator,
    _next_phase2_stage,
    _resume_agent_for_stage,
    _video_generation_skipped_in_result,
    clear_awaiting_payload,
    clear_confirm_signal,
    get_awaiting_payload,
    store_awaiting_payload,
    trigger_confirm_signal,
    wait_for_confirm_signal,
)
from app.config import Settings
from app.models.project import Character, Shot
from tests.factories import create_project, create_run

# ---------------------------------------------------------------------------
# Pure helper unit tests
# ---------------------------------------------------------------------------


class TestPureHelpers:
    def test_next_phase2_stage_known(self):
        assert _next_phase2_stage("plan_characters") == "characters_approval"
        assert _next_phase2_stage("characters_approval") == "plan_shots"
        assert _next_phase2_stage("render_characters") == "character_images_approval"

    def test_next_phase2_stage_unknown_returns_none(self):
        assert _next_phase2_stage("not-a-stage") is None
        assert _next_phase2_stage(None) is None

    def test_resume_agent_for_stage_known(self):
        assert _resume_agent_for_stage("plan_characters") == "plan"
        assert _resume_agent_for_stage("characters_approval") == "plan"
        assert _resume_agent_for_stage("render_characters") == "render"
        assert _resume_agent_for_stage("character_images_approval") == "render"
        assert _resume_agent_for_stage("compose_videos") == "compose"

    def test_resume_agent_for_unknown_stage_falls_back(self):
        assert _resume_agent_for_stage("unknown") == "plan"
        assert _resume_agent_for_stage(None) == "plan"
        assert _resume_agent_for_stage(123) == "plan"

    def test_video_generation_skipped_in_result_dict(self):
        assert _video_generation_skipped_in_result({"video_generation_skipped": True}) is True
        assert _video_generation_skipped_in_result({"video_generation_skipped": False}) is False
        assert _video_generation_skipped_in_result({}) is False

    def test_video_generation_skipped_in_result_non_dict(self):
        assert _video_generation_skipped_in_result(None) is False
        assert _video_generation_skipped_in_result("string") is False
        assert _video_generation_skipped_in_result([1, 2, 3]) is False


# ---------------------------------------------------------------------------
# Confirm signal + awaiting payload（agentrun 列的 DB 实现）
# ---------------------------------------------------------------------------


@pytest.fixture
async def signal_db(test_db_engine_sessionmaker, monkeypatch):
    """Patch app.db.session.async_session_maker to the test sessionmaker."""
    _, session_maker = test_db_engine_sessionmaker
    monkeypatch.setattr("app.db.session.async_session_maker", session_maker)
    return session_maker


@pytest.mark.asyncio
async def test_trigger_confirm_signal_sets_flag(signal_db, test_session):
    from tests.factories import create_project, create_run

    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    ok = await trigger_confirm_signal(run.id)
    assert ok is True
    await test_session.refresh(run)
    assert run.confirm_requested is True


@pytest.mark.asyncio
async def test_trigger_confirm_signal_missing_run_is_noop(signal_db):
    ok = await trigger_confirm_signal(424242)
    assert ok is True


@pytest.mark.asyncio
async def test_wait_for_confirm_signal_consumes_flag(signal_db, test_session):
    from tests.factories import create_project, create_run

    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    await trigger_confirm_signal(run.id)
    ok = await wait_for_confirm_signal(run.id, timeout=2)
    assert ok is True
    await test_session.refresh(run)
    assert run.confirm_requested is False


@pytest.mark.asyncio
async def test_wait_for_confirm_signal_timeout(signal_db, test_session):
    from tests.factories import create_project, create_run

    project = await create_project(test_session)
    run = await create_run(test_session, project.id)
    ok = await wait_for_confirm_signal(run.id, timeout=1)
    assert ok is False


@pytest.mark.asyncio
async def test_awaiting_payload_roundtrip(signal_db, test_session):
    from tests.factories import create_project, create_run

    project = await create_project(test_session)
    run = await create_run(test_session, project.id)

    assert await get_awaiting_payload(run.id) is None
    payload = {"gate": "outline", "run_id": run.id, "message": "确认大纲"}
    await store_awaiting_payload(run.id, payload)
    assert await get_awaiting_payload(run.id) == payload
    await clear_awaiting_payload(run.id)
    assert await get_awaiting_payload(run.id) is None


@pytest.mark.asyncio
async def test_get_awaiting_payload_missing_run_returns_none(signal_db):
    assert await get_awaiting_payload(404) is None


@pytest.mark.asyncio
async def test_clear_confirm_signal_missing_run_is_noop(signal_db):
    await clear_confirm_signal(424242)


# ---------------------------------------------------------------------------
# Cleanup tests
# ---------------------------------------------------------------------------


class _RecordingWs:
    def __init__(self) -> None:
        self.events: list[tuple[int, dict]] = []

    async def send_event(self, project_id: int, event: dict) -> None:
        self.events.append((project_id, event))


@pytest.fixture
def test_settings_minimal():
    return Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        anthropic_api_key="test",
        image_api_key="test",
        video_api_key="test",
    )


@pytest.fixture
async def orch_with_session(test_session, test_settings_minimal, monkeypatch):
    """Build orchestrator instance using a real test_session."""

    # Ensure cleanup operations don't try to delete real disk files.
    monkeypatch.setattr("app.agents.orchestrator.delete_files", lambda _paths: None)

    ws = _RecordingWs()
    orch = GenerationOrchestrator(settings=test_settings_minimal, ws=ws, session=test_session)
    return orch, ws


@pytest.mark.asyncio
async def test_cleanup_full_mode_plan_deletes_all(test_session, orch_with_session):
    orch, ws = orch_with_session
    project = await create_project(test_session)
    test_session.add(Character(project_id=project.id, name="A", description="desc"))
    test_session.add(Shot(project_id=project.id, order=0, description="s0"))
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "plan", mode="full")

    chars = (await test_session.execute(__import__("sqlalchemy").select(Character))).scalars().all()
    shots = (await test_session.execute(__import__("sqlalchemy").select(Shot))).scalars().all()
    assert chars == []
    assert shots == []
    # Should fire data_cleared event
    assert any(evt[1]["type"] == "data_cleared" for evt in ws.events)


@pytest.mark.asyncio
async def test_cleanup_full_mode_render_clears_images(test_session, orch_with_session, monkeypatch):
    orch, ws = orch_with_session
    project = await create_project(test_session)
    char = Character(project_id=project.id, name="A", description="d", image_url="u")
    shot = Shot(project_id=project.id, order=0, description="s", image_url="i", video_url="v")
    test_session.add(char)
    test_session.add(shot)
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "render", mode="full")

    await test_session.refresh(char)
    await test_session.refresh(shot)
    assert char.image_url is None
    assert shot.image_url is None
    assert shot.video_url is None
    # full mode for render does not set cleared_types -> no event
    assert not any(evt[1]["type"] == "data_cleared" for evt in ws.events)


@pytest.mark.asyncio
async def test_cleanup_full_mode_render_clears_assets(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    shot = Shot(project_id=project.id, order=0, description="s", image_url="i", video_url="v")
    test_session.add(shot)
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "render", mode="full")

    await test_session.refresh(shot)
    assert shot.image_url is None
    assert shot.video_url is None


@pytest.mark.asyncio
async def test_cleanup_full_mode_compose_clears_only_video(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    shot = Shot(project_id=project.id, order=0, description="s", image_url="keep", video_url="v")
    test_session.add(shot)
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "compose", mode="full")

    await test_session.refresh(shot)
    assert shot.image_url == "keep"
    assert shot.video_url is None


@pytest.mark.asyncio
async def test_cleanup_unknown_agent_raises(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    with pytest.raises(ValueError, match="Unsupported start_agent"):
        await orch._cleanup_for_rerun(project.id, "bogus", mode="full")


@pytest.mark.asyncio
async def test_cleanup_incremental_mode_unknown_agent_raises(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    with pytest.raises(ValueError, match="Unsupported start_agent"):
        await orch._cleanup_for_rerun(project.id, "bogus", mode="incremental")


@pytest.mark.asyncio
async def test_cleanup_incremental_mode_plan_clears_assets(test_session, orch_with_session):
    orch, ws = orch_with_session
    project = await create_project(test_session)
    char = Character(project_id=project.id, name="A", description="d", image_url="u")
    shot = Shot(project_id=project.id, order=0, description="s", image_url="i", video_url="v")
    test_session.add(char)
    test_session.add(shot)
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "plan", mode="incremental")

    await test_session.refresh(char)
    await test_session.refresh(shot)
    assert char.image_url is None
    assert shot.image_url is None
    assert shot.video_url is None
    # Incremental mode does NOT delete data structure -> char/shot still exist
    chars = (await test_session.execute(__import__("sqlalchemy").select(Character))).scalars().all()
    shots = (await test_session.execute(__import__("sqlalchemy").select(Shot))).scalars().all()
    assert len(chars) == 1
    assert len(shots) == 1
    # Incremental mode never emits data_cleared event
    assert not any(evt[1]["type"] == "data_cleared" for evt in ws.events)


@pytest.mark.asyncio
async def test_cleanup_incremental_mode_compose_clears_only_video(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    shot = Shot(project_id=project.id, order=0, description="s", image_url="i", video_url="v")
    test_session.add(shot)
    await test_session.commit()

    await orch._cleanup_for_rerun(project.id, "compose", mode="incremental")

    await test_session.refresh(shot)
    assert shot.image_url == "i"
    assert shot.video_url is None


# ---------------------------------------------------------------------------
# _set_run / _log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_run_updates_fields_and_persists(test_session, orch_with_session):
    orch, _ws = orch_with_session
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="queued")

    updated = await orch._set_run(run, status="running", progress=0.42, current_agent="x")
    assert updated.status == "running"
    assert updated.progress == 0.42
    assert updated.current_agent == "x"


@pytest.mark.asyncio
async def test_log_persists_agent_message(test_session, orch_with_session):
    from app.models.agent_run import AgentMessage
    from sqlalchemy import select

    orch, _ws = orch_with_session
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="running")

    await orch._log(run.id, agent="orchestrator", role="system", content="hello")

    res = await test_session.execute(select(AgentMessage).where(AgentMessage.run_id == run.id))
    msgs = res.scalars().all()
    assert len(msgs) == 1
    assert msgs[0].content == "hello"
    assert msgs[0].agent == "orchestrator"
    assert msgs[0].role == "system"
