from __future__ import annotations

from types import SimpleNamespace

import pytest
from typing import get_type_hints

from app.agents.orchestrator import GenerationOrchestrator
from app.schemas.project import RecoverySummaryRead
from app.services.run_recovery import build_recovery_summary
from tests.factories import create_project, create_run


def test_phase2_recovery_contract_is_stage_granular_only() -> None:
    from app.orchestration.state import Phase2State

    hints = get_type_hints(Phase2State, include_extras=True)

    assert "thread_id" in hints
    assert "current_stage" in hints
    assert "stage_history" in hints
    assert "shot_id" not in hints
    assert "artifact_id" not in hints
    assert "asset_id" not in hints


def test_phase2_recovery_contract_exposes_resume_from_last_valid_stage() -> None:
    from app.orchestration.graph import build_phase2_graph

    graph = build_phase2_graph()

    assert hasattr(graph, "compile")
    assert callable(graph.compile)


@pytest.mark.asyncio
async def test_resume_from_recovery_uses_run_provider_snapshot(test_session, test_settings, monkeypatch):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="failed")
    run.provider_snapshot = {
        "text": {"selected_key": "openai", "source": "project", "valid": True, "status": "valid"},
        "image": {"selected_key": "openai", "source": "default", "valid": True, "status": "valid"},
        "video": {"selected_key": "openai", "source": "default", "valid": True, "status": "valid"},
    }
    project.text_provider_override = "anthropic"
    await test_session.commit()

    captured = {"text_provider": None, "video_provider": None}

    def _fake_text_service(settings):
        captured["text_provider"] = settings.text_provider
        return SimpleNamespace()

    def _fake_video_service(settings):
        captured["video_provider"] = settings.video_provider
        return SimpleNamespace()

    class _DummyCompiledGraph:
        def get_state_history(self, *_args, **_kwargs):
            return []

        def compile(self, *_args, **_kwargs):
            return self

    class _DummyCheckpointer:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return None

    def _noop_graph_context(_database_url: str):
        return _DummyCheckpointer()

    async def _fake_recovery_summary(*, session, database_url, run):
        return RecoverySummaryRead(
            project_id=run.project_id,
            run_id=run.id or 0,
            thread_id=f"agent-run-{run.id}",
            current_stage="plan_characters",
            next_stage="render_characters",
            preserved_stages=[],
            stage_history=[],
            resumable=True,
        )

    async def _noop_invoke_phase2_graph(self, **_kwargs):
        return False, "compose_videos"

    class _StubWs:
        async def send_event(self, _project_id: int, _event: dict) -> None:
            return None

    monkeypatch.setattr("app.agents.orchestrator.create_text_service", _fake_text_service)
    monkeypatch.setattr("app.agents.orchestrator.create_video_service", _fake_video_service)
    monkeypatch.setattr("app.agents.orchestrator.build_phase2_graph", lambda: _DummyCompiledGraph())
    monkeypatch.setattr("app.agents.orchestrator.build_postgres_checkpointer", _noop_graph_context)
    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", _fake_recovery_summary)
    monkeypatch.setattr(GenerationOrchestrator, "_invoke_phase2_graph", _noop_invoke_phase2_graph)

    async def _noop_clear_confirm_event(_: int) -> None:
        return None

    async def _noop_clear_awaiting(_: int) -> None:
        return None

    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", _noop_clear_confirm_event)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", _noop_clear_awaiting)

    orchestrator = GenerationOrchestrator(settings=test_settings, ws=_StubWs(), session=test_session)
    await orchestrator.resume_from_recovery(project_id=project.id, run_id=run.id)

    assert captured["text_provider"] == "openai"
    assert captured["video_provider"] == "openai"


@pytest.mark.asyncio
async def test_resume_from_recovery_reports_no_video_completion_message(test_session, test_settings, monkeypatch):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="failed")
    run.provider_snapshot = {
        "text": {"selected_key": "openai", "source": "project", "valid": True, "status": "valid"},
        "image": {"selected_key": "openai", "source": "default", "valid": True, "status": "valid"},
        "video": {
            "selected_key": "openai",
            "source": "default",
            "valid": False,
            "status": "invalid",
            "reason_code": "provider_missing_credentials",
            "reason_message": "mock",
        },
    }
    await test_session.commit()

    captured_events: list[dict[str, object]] = []

    def _fake_text_service(settings):
        return SimpleNamespace()

    def _fake_video_service(settings):
        return SimpleNamespace()

    class _DummyCompiledGraph:
        def get_state_history(self, *_args, **_kwargs):
            return []

        def compile(self, *_args, **_kwargs):
            return self

    class _DummyCheckpointer:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return None

    async def _noop_recovery_summary(*, session, database_url, run):
        return RecoverySummaryRead(
            project_id=run.project_id,
            run_id=run.id or 0,
            thread_id=f"agent-run-{run.id}",
            current_stage="render_characters",
            next_stage="compose_videos",
            preserved_stages=[],
            stage_history=[],
            resumable=True,
        )

    async def _fake_invoke_phase2_graph(self, **_kwargs):
        return True, "compose_videos"

    async def _noop_clear_confirm_event(_: int) -> None:
        return None

    class _StubWs:
        async def send_event(self, _project_id: int, event: dict) -> None:
            captured_events.append(event)

    monkeypatch.setattr("app.agents.orchestrator.create_text_service", _fake_text_service)
    monkeypatch.setattr("app.agents.orchestrator.create_video_service", _fake_video_service)
    monkeypatch.setattr("app.agents.orchestrator.build_phase2_graph", lambda: _DummyCompiledGraph())
    monkeypatch.setattr("app.agents.orchestrator.build_postgres_checkpointer", lambda _database_url: _DummyCheckpointer())
    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", _noop_recovery_summary)
    monkeypatch.setattr(GenerationOrchestrator, "_invoke_phase2_graph", _fake_invoke_phase2_graph)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", _noop_clear_confirm_event)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", _noop_clear_confirm_event)

    orchestrator = GenerationOrchestrator(settings=test_settings, ws=_StubWs(), session=test_session)
    await orchestrator.resume_from_recovery(project_id=project.id, run_id=run.id)

    run_completed_events = [event for event in captured_events if event.get("type") == "run_completed"]
    assert run_completed_events, "resume flow should publish run_completed"
    assert run_completed_events[0].get("data", {}).get("message") == "视频未配置，已完成文本和图片生成"


@pytest.mark.asyncio
async def test_build_recovery_summary_keeps_approval_stage_as_resume_target(test_session, monkeypatch):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="failed")
    run.current_agent = "plan"
    await test_session.commit()

    async def _fake_checkpoint_history(_database_url, _run):
        return [
            SimpleNamespace(
                values={
                    "current_stage": "characters_approval",
                    "stage_history": ["plan_characters"],
                }
            )
        ]

    async def _fake_stage_artifact_counts(_session, _run_id):
        return {"plan_characters": 2}

    monkeypatch.setattr("app.services.run_recovery._checkpoint_history", _fake_checkpoint_history)
    monkeypatch.setattr("app.services.run_recovery._stage_artifact_counts", _fake_stage_artifact_counts)

    summary = await build_recovery_summary(
        session=test_session,
        database_url="postgresql://test",
        run=run,
    )

    assert summary.current_stage == "characters_approval"
    assert summary.next_stage == "characters_approval"
    assert summary.preserved_stages == ["plan_characters"]


@pytest.mark.asyncio
async def test_build_recovery_summary_uses_review_route_stage_for_resume_target(test_session, monkeypatch):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="failed")
    run.current_agent = "review"
    await test_session.commit()

    async def _fake_checkpoint_history(_database_url, _run):
        return [
            SimpleNamespace(
                values={
                    "current_stage": "review",
                    "route_stage": "render_characters",
                    "stage_history": ["plan_characters"],
                }
            )
        ]

    async def _fake_stage_artifact_counts(_session, _run_id):
        return {"plan_characters": 2, "render_characters": 0}

    monkeypatch.setattr("app.services.run_recovery._checkpoint_history", _fake_checkpoint_history)
    monkeypatch.setattr("app.services.run_recovery._stage_artifact_counts", _fake_stage_artifact_counts)

    summary = await build_recovery_summary(
        session=test_session,
        database_url="postgresql://test",
        run=run,
    )

    assert summary.current_stage == "review"
    assert summary.next_stage == "render_characters"
    assert summary.preserved_stages == ["plan_characters"]


@pytest.mark.asyncio
async def test_build_recovery_summary_promotes_pending_approval_checkpoint_to_current_stage(test_session, monkeypatch):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="running")
    run.current_agent = "plan"
    await test_session.commit()

    async def _fake_checkpoint_history(_database_url, _run):
        return [
            SimpleNamespace(
                values={
                    "current_stage": "plan_characters",
                    "stage_history": ["plan_characters"],
                },
                next=("characters_approval",),
            )
        ]

    async def _fake_stage_artifact_counts(_session, _run_id):
        return {"plan_characters": 2}

    monkeypatch.setattr("app.services.run_recovery._checkpoint_history", _fake_checkpoint_history)
    monkeypatch.setattr("app.services.run_recovery._stage_artifact_counts", _fake_stage_artifact_counts)

    summary = await build_recovery_summary(
        session=test_session,
        database_url="postgresql://test",
        run=run,
    )

    assert summary.current_stage == "characters_approval"
    assert summary.next_stage == "characters_approval"
    assert summary.preserved_stages == ["plan_characters"]
