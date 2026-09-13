from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.agents.orchestrator import (
    GenerationOrchestrator,
    _next_phase2_stage,
    _resume_agent_for_stage,
    _video_generation_skipped_in_result,
    clear_awaiting_payload,
    get_awaiting_payload,
    store_awaiting_payload,
)
from app.config import Settings


class MockWsManager:
    def __init__(self):
        self.events = []

    async def send_event(self, project_id: int, event: dict):
        self.events.append((project_id, event))


class FakeResult:
    def __init__(self, rows=None, scalar=None):
        self._rows = rows or []
        self._scalar = scalar

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None

    def scalar_one_or_none(self):
        return self._scalar


class FakeSession:
    def __init__(self, project=None, run=None, rows=None, scalars_result=None):
        self.project = project
        self.run = run
        self.rows = rows or []
        self.scalars_result = scalars_result
        self.executed = []
        self.added = []
        self.commits = 0
        self.refreshed = []
        self.rollbacks = 0

    async def execute(self, statement):
        self.executed.append(statement)
        return FakeResult(rows=self.scalars_result or self.rows, scalar=None)

    async def get(self, model, ident):
        if model.__name__ == "Project":
            return self.project
        if model.__name__ == "AgentRun":
            return self.run
        return None

    async def commit(self):
        self.commits += 1

    async def refresh(self, obj):
        self.refreshed.append(obj)

    async def rollback(self):
        self.rollbacks += 1

    def add(self, obj):
        self.added.append(obj)


class FakeRecovery:
    def __init__(self, next_stage: str | None = None, current_stage: str = "script"):
        self.next_stage = next_stage
        self.current_stage = current_stage
        self.preserved_stages = [current_stage]

    def model_dump(self, mode="json"):
        return {
            "next_stage": self.next_stage,
            "current_stage": self.current_stage,
            "preserved_stages": self.preserved_stages,
        }


class FakeCheckpointerCtx:
    def __init__(self, compiled_graph):
        self.compiled_graph = compiled_graph

    async def __aenter__(self):
        return self.compiled_graph

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeCompiledGraph:
    def __init__(self, results):
        self.results = list(results)

    async def ainvoke(self, payload, graph_config, context=None):
        if not self.results:
            return {}
        result = self.results.pop(0)
        return result


class TestAgentIndex:
    @pytest.fixture
    def orchestrator(self):
        settings = Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        )
        ws = MockWsManager()
        return GenerationOrchestrator(settings=settings, ws=ws, session=None)

    def test_valid_agent_indices(self, orchestrator):
        assert orchestrator._agent_index("outline") == 0
        assert orchestrator._agent_index("plan") == 1
        assert orchestrator._agent_index("render") == 2
        assert orchestrator._agent_index("compose") == 3
        assert orchestrator._agent_index("review") == 4
        # CriticAgent is invoked via LangGraph nodes, not via orchestrator.agents list

    def test_invalid_agent_raises(self, orchestrator):
        with pytest.raises(ValueError, match="Unknown agent"):
            orchestrator._agent_index("invalid")


def test_stage_helpers_and_state_building():
    assert _next_phase2_stage(None) is None
    assert _next_phase2_stage("plan_characters") == "characters_approval"
    assert _resume_agent_for_stage(None) == "plan"
    assert _resume_agent_for_stage("compose_videos") == "compose"
    assert _video_generation_skipped_in_result({"video_generation_skipped": 1}) is True
    assert _video_generation_skipped_in_result([1, 2]) is False
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=None,
    )
    state = orchestrator._build_phase2_state(
        project_id=1, run_id=2, thread_id="t1", start_stage="plan"
    )
    assert state["current_stage"] == "plan"
    assert state["route_stage"] == "plan"


@pytest.mark.asyncio
async def test_cleanup_for_rerun_full_branch(monkeypatch):
    project = SimpleNamespace(id=1)
    session = FakeSession(project=project)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    called = []

    async def delete_shots(project_id):
        called.append(("shots", project_id))

    async def delete_chars(project_id):
        called.append(("chars", project_id))

    async def clear_chars(project_id):
        called.append(("clear_chars", project_id))

    async def clear_shots(project_id):
        called.append(("clear_shots", project_id))

    async def clear_videos(project_id):
        called.append(("clear_videos", project_id))

    monkeypatch.setattr(orchestrator, "_delete_project_shots", delete_shots)
    monkeypatch.setattr(orchestrator, "_delete_project_characters", delete_chars)
    monkeypatch.setattr(orchestrator, "_clear_character_images", clear_chars)
    monkeypatch.setattr(orchestrator, "_clear_shot_images", clear_shots)
    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "plan", mode="full")

    assert ("shots", 1) in called
    assert ("chars", 1) in called
    assert session.commits == 1


@pytest.mark.asyncio
async def test_cleanup_for_rerun_incremental_branch(monkeypatch):
    project = SimpleNamespace(id=1)
    session = FakeSession(project=project)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    called = []

    async def clear_chars(project_id):
        called.append(("clear_chars", project_id))

    async def clear_shots(project_id):
        called.append(("clear_shots", project_id))

    async def clear_videos(project_id):
        called.append(("clear_videos", project_id))

    monkeypatch.setattr(orchestrator, "_clear_character_images", clear_chars)
    monkeypatch.setattr(orchestrator, "_clear_shot_images", clear_shots)
    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "render", mode="incremental")

    assert called == [("clear_chars", 1), ("clear_shots", 1), ("clear_videos", 1)]
    assert session.commits == 1


@pytest.mark.asyncio
async def test_cleanup_for_rerun_unsupported_start_agent_raises():
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=FakeSession(project=SimpleNamespace(id=1)),
    )

    with pytest.raises(ValueError, match="Unsupported start_agent"):
        await orchestrator._cleanup_for_rerun(1, "unknown", mode="full")


@pytest.mark.asyncio
async def test_set_run_updates_and_commits():
    run = SimpleNamespace(id=1, updated_at=None, thread_id=None)
    session = FakeSession()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    updated = await orchestrator._set_run(run, status="running", progress=0.5)

    assert updated.status == "running"
    assert updated.progress == 0.5
    assert session.commits == 1
    assert session.refreshed == [run]


@pytest.mark.asyncio
async def test_log_persists_agent_message():
    session = FakeSession()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    await orchestrator._log(1, agent="orchestrator", role="system", content="hello")

    assert session.commits == 1
    assert session.added[0].content == "hello"
    assert session.added[0].agent == "orchestrator"


@pytest.mark.asyncio
async def test_build_agent_context_uses_provider_snapshot(monkeypatch):
    project = SimpleNamespace(id=1)
    run = SimpleNamespace(id=2, provider_snapshot={"provider": "openai"}, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    ctx = orchestrator._build_agent_context(
        project=project, run=run, request=SimpleNamespace(notes="")
    )

    assert ctx.project is project
    assert ctx.run is run


@pytest.mark.asyncio
async def test_invoke_phase2_graph_handles_interrupt_and_completion(monkeypatch):
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_wait_for_confirm(project_id, run_obj, agent_name, agent_ctx=None):
        return "好的"

    monkeypatch.setattr(orchestrator, "_wait_for_confirm", fake_wait_for_confirm)

    compiled_graph = FakeCompiledGraph(
        [
            {
                "__interrupt__": [SimpleNamespace(value={"gate": "director"})],
                "video_generation_skipped": True,
            },
            {},
        ]
    )

    result = await orchestrator._invoke_phase2_graph(
        project=project,
        run=run,
        ctx=SimpleNamespace(project=project),
        compiled_graph=compiled_graph,
        graph_config={"configurable": {"thread_id": "t1"}},
        runtime_context=SimpleNamespace(),
        initial_payload={"x": 1},
        auto_mode=False,
    )

    assert result == (True, "compose")
    assert project.status == "ready"


@pytest.mark.asyncio
async def test_run_from_agent_returns_early_when_project_missing():
    session = FakeSession(project=None, run=None)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    await orchestrator.run_from_agent(
        project_id=1, run_id=2, request=SimpleNamespace(notes=""), agent_name="scriptwriter"
    )

    assert session.commits == 0


@pytest.mark.asyncio
async def test_run_from_agent_handles_failure_and_sends_failed(monkeypatch):
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, provider_snapshot={}, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def boom(*args, **kwargs):
        raise RuntimeError("boom")

    async def noop_async(*args, **kwargs):
        return None

    monkeypatch.setattr(orchestrator, "_cleanup_for_rerun", boom)
    monkeypatch.setattr(orchestrator, "_agent_index", lambda name: 0)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop_async)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop_async)

    await orchestrator.run_from_agent(
        project_id=1, run_id=2, request=SimpleNamespace(notes=""), agent_name="scriptwriter"
    )

    assert session.rollbacks == 1
    assert ws.events[-1][1]["type"] == "run_failed"


@pytest.mark.asyncio
async def test_resume_from_recovery_happy_path(monkeypatch):
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, provider_snapshot={}, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_recovery(**kwargs):
        return FakeRecovery(next_stage="script", current_stage="script")

    class FakeGraph:
        def compile(self, checkpointer=None):
            return FakeCompiledGraph([{}])

    async def fake_checkpointer(_db):
        return FakeCheckpointerCtx(FakeCompiledGraph([{}]))

    async def fake_build_stage_recovery_config(*args, **kwargs):
        return {"configurable": {"thread_id": "t1"}}

    async def fake_invoke(**kwargs):
        return False, "compose"

    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", fake_recovery)
    monkeypatch.setattr(
        "app.agents.orchestrator.build_postgres_checkpointer",
        lambda db: FakeCheckpointerCtx(FakeCompiledGraph([{}])),
    )
    monkeypatch.setattr("app.agents.orchestrator.build_phase2_graph", lambda: FakeGraph())
    monkeypatch.setattr(
        "app.agents.orchestrator.build_stage_recovery_config", fake_build_stage_recovery_config
    )
    monkeypatch.setattr(orchestrator, "_invoke_phase2_graph", fake_invoke)
    monkeypatch.setattr(
        orchestrator,
        "_build_agent_context",
        lambda **kwargs: SimpleNamespace(
            project=project, run=run, session=session, user_feedback=None
        ),
    )

    async def fake_set_run(run, **fields):
        for key, value in fields.items():
            setattr(run, key, value)
        return run

    async def fake_log(*args, **kwargs):
        return None

    monkeypatch.setattr(orchestrator, "_set_run", fake_set_run)
    monkeypatch.setattr(orchestrator, "_log", fake_log)
    monkeypatch.setattr(orchestrator, "_agent_index", lambda name: 0)
    monkeypatch.setattr(
        "app.agents.orchestrator.clear_confirm_signal", lambda run_id: fake_log()
    )
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", lambda run_id: fake_log())

    await orchestrator.resume_from_recovery(project_id=1, run_id=2)

    assert ws.events[0][1]["type"] == "run_started"
    assert ws.events[0][1]["data"]["current_agent"] == "plan"
    assert ws.events[-1][1]["type"] == "run_completed"
    assert ws.events[-1][1]["data"]["current_agent"] == "plan"


@pytest.mark.asyncio
async def test_run_from_agent_happy_path(monkeypatch):
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, provider_snapshot={}, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    ctx = SimpleNamespace(
        project=project,
        run=run,
        session=session,
        user_feedback=None,
        rerun_mode=None,
        target_ids=None,
        entity_type=None,
        entity_id=None,
        entity_ids=None,
    )
    monkeypatch.setattr(orchestrator, "_build_agent_context", lambda **kwargs: ctx)

    async def noop_async(*args, **kwargs):
        return None

    async def run_phase2_graph(**kwargs):
        return False, "compose"

    async def set_run(run, **fields):
        for key, value in fields.items():
            setattr(run, key, value)
        return run

    monkeypatch.setattr(orchestrator, "_cleanup_for_rerun", noop_async)
    monkeypatch.setattr(orchestrator, "_run_phase2_graph", run_phase2_graph)
    monkeypatch.setattr(orchestrator, "_set_run", set_run)
    monkeypatch.setattr(orchestrator, "_log", noop_async)
    monkeypatch.setattr(orchestrator, "_agent_index", lambda name: 0)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop_async)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop_async)

    await orchestrator.run_from_agent(
        project_id=1,
        run_id=2,
        request=SimpleNamespace(notes="", entity_type=None, entity_id=None),
        agent_name="plan",
    )

    assert ws.events[0][1]["type"] == "run_started"
    assert ws.events[0][1]["data"]["current_agent"] == "plan"
    assert ws.events[-1][1]["type"] == "run_completed"
    assert ws.events[-1][1]["data"]["current_agent"] == "plan"


@pytest.mark.asyncio
async def test_run_from_agent_review_branch(monkeypatch):
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, provider_snapshot={}, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    ctx = SimpleNamespace(
        project=project,
        run=run,
        session=session,
        user_feedback=None,
        rerun_mode=None,
        target_ids=None,
        entity_type=None,
        entity_id=None,
        entity_ids=None,
    )

    async def fake_review_run(_ctx):
        _ctx.rerun_mode = "incremental"
        _ctx.user_feedback = "notes"
        return {"start_agent": "plan", "mode": "incremental"}

    monkeypatch.setattr(orchestrator, "_build_agent_context", lambda **kwargs: ctx)

    async def noop_async(*args, **kwargs):
        return None

    async def run_phase2_graph(**kwargs):
        return False, "compose"

    async def set_run(run, **fields):
        return run

    monkeypatch.setattr(orchestrator, "_cleanup_for_rerun", noop_async)
    monkeypatch.setattr(orchestrator, "_run_phase2_graph", run_phase2_graph)
    monkeypatch.setattr(orchestrator, "_set_run", set_run)
    monkeypatch.setattr(orchestrator, "_log", noop_async)
    monkeypatch.setattr(orchestrator, "_agent_index", lambda name: 0)
    # _agent_index is mocked to 0, so review_agent resolves to agents[0]
    monkeypatch.setattr(orchestrator.agents[0], "run", fake_review_run)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop_async)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop_async)

    await orchestrator.run_from_agent(
        project_id=1,
        run_id=2,
        request=SimpleNamespace(notes="notes", entity_type=None, entity_id=None),
        agent_name="review",
    )

    assert ctx.user_feedback == "notes"
    assert ctx.rerun_mode == "incremental"


@pytest.mark.asyncio
async def test_cleanup_for_rerun_incremental_render(monkeypatch):
    """Incremental mode: render clears character+shot images/videos."""
    cleared = []
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    async def clear_chars(pid, ids=None):
        cleared.append("chars")

    async def clear_shots(pid, ids=None):
        cleared.append("shots")

    async def clear_videos(pid, ids=None):
        cleared.append("videos")

    monkeypatch.setattr(orchestrator, "_clear_character_images", clear_chars)
    monkeypatch.setattr(orchestrator, "_clear_shot_images", clear_shots)
    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "render", mode="incremental")

    assert cleared == ["chars", "shots", "videos"]


@pytest.mark.asyncio
async def test_cleanup_for_rerun_incremental_compose(monkeypatch):
    """Incremental mode: compose only clears shot videos."""
    cleared = []
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    async def clear_videos(pid, ids=None):
        cleared.append(("videos", ids))

    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "compose", mode="incremental")

    assert cleared == [("videos", None)]


@pytest.mark.asyncio
async def test_cleanup_for_rerun_scoped_plan_only_selected(monkeypatch):
    """Scoped plan cleanup must not clear unselected character media."""
    from app.agents.base import TargetIds

    calls = []
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    async def clear_chars(pid, ids=None):
        calls.append(("chars", ids))

    async def clear_shots(pid, ids=None):
        calls.append(("shots", ids))

    async def clear_videos(pid, ids=None):
        calls.append(("videos", ids))

    monkeypatch.setattr(orchestrator, "_clear_character_images", clear_chars)
    monkeypatch.setattr(orchestrator, "_clear_shot_images", clear_shots)
    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(
        1,
        "plan",
        mode="incremental",
        target_ids=TargetIds(character_ids=[], shot_ids=[9, 10]),
    )

    assert calls == [("shots", [9, 10]), ("videos", [9, 10])]


@pytest.mark.asyncio
async def test_cleanup_for_rerun_incremental_unknown_raises():
    """Incremental mode: unknown agent raises ValueError."""
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    with pytest.raises(ValueError, match="Unsupported start_agent"):
        await orchestrator._cleanup_for_rerun(1, "unknown", mode="incremental")


@pytest.mark.asyncio
async def test_cleanup_for_rerun_full_render(monkeypatch):
    """Full mode: render clears character+shot images/videos."""
    cleared = []
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    async def clear_chars(pid, ids=None):
        cleared.append("chars")

    async def clear_shots(pid, ids=None):
        cleared.append("shots")

    async def clear_videos(pid, ids=None):
        cleared.append("videos")

    monkeypatch.setattr(orchestrator, "_clear_character_images", clear_chars)
    monkeypatch.setattr(orchestrator, "_clear_shot_images", clear_shots)
    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "render", mode="full")

    assert cleared == ["chars", "shots", "videos"]


@pytest.mark.asyncio
async def test_cleanup_for_rerun_full_compose(monkeypatch):
    """Full mode: compose only clears shot videos."""
    cleared = []
    session = FakeSession(project=SimpleNamespace(id=1), run=SimpleNamespace(id=2))
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    async def clear_videos(pid, ids=None):
        cleared.append("videos")

    monkeypatch.setattr(orchestrator, "_clear_shot_videos", clear_videos)

    await orchestrator._cleanup_for_rerun(1, "compose", mode="full")

    assert cleared == ["videos"]


@pytest.mark.asyncio
async def test_invoke_phase2_graph_auto_mode_skips_confirm(monkeypatch):
    """Auto mode: _wait_for_confirm is never called; _send_auto_approval_events fires instead."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    confirm_called = False

    async def fake_wait_for_confirm(*args):
        nonlocal confirm_called
        confirm_called = True
        return "ok"

    monkeypatch.setattr(orchestrator, "_wait_for_confirm", fake_wait_for_confirm)

    auto_approval_called = False

    async def fake_send_auto_approval(*args, **kwargs):
        nonlocal auto_approval_called
        auto_approval_called = True

    monkeypatch.setattr(orchestrator, "_send_auto_approval_events", fake_send_auto_approval)

    compiled_graph = FakeCompiledGraph(
        [
            {"__interrupt__": [SimpleNamespace(value={"gate": "director"})]},
            {},
        ]
    )

    result = await orchestrator._invoke_phase2_graph(
        project=project,
        run=run,
        ctx=SimpleNamespace(project=project),
        compiled_graph=compiled_graph,
        graph_config={"configurable": {"thread_id": "t1"}},
        runtime_context=SimpleNamespace(),
        initial_payload={"x": 1},
        auto_mode=True,
    )

    assert not confirm_called
    assert auto_approval_called
    assert result == (False, "compose")


@pytest.mark.asyncio
async def test_send_auto_approval_events_emits_awaiting_and_confirmed(monkeypatch):
    """_send_auto_approval_events sends run_awaiting_confirm + run_confirmed with auto_mode=True."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    fake_summary = SimpleNamespace(
        model_dump=lambda *, mode=None: {
            "current_stage": "plan_characters",
            "preserved_stages": [],
        },
        preserved_stages=[],
    )
    monkeypatch.setattr(
        "app.agents.orchestrator.build_recovery_summary", lambda **kw: _async_return(fake_summary)
    )

    agent_ctx = SimpleNamespace(
        completion_info=SimpleNamespace(
            completed="plan done", details=None, next="next step", question="ok?"
        ),
    )

    await orchestrator._send_auto_approval_events(1, run, "plan", agent_ctx)

    events = ws.events
    awaiting_evt = [e for e in events if e[1].get("type") == "run_awaiting_confirm"]
    confirmed_evt = [e for e in events if e[1].get("type") == "run_confirmed"]
    assert len(awaiting_evt) == 1
    assert len(confirmed_evt) == 1
    assert awaiting_evt[0][1]["data"]["auto_mode"] is True
    assert awaiting_evt[0][1]["data"]["current_stage"] == "plan_characters"
    assert confirmed_evt[0][1]["data"]["auto_mode"] is True
    assert confirmed_evt[0][1]["data"]["stage"] == "plan_shots"


def _async_return(val):
    import asyncio

    f = asyncio.Future()
    f.set_result(val)
    return f


@pytest.mark.asyncio
async def test_invoke_phase2_graph_invalid_gate_raises(monkeypatch):
    """Invalid gate name in interrupt value raises RuntimeError."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    compiled_graph = FakeCompiledGraph(
        [
            {"__interrupt__": [SimpleNamespace(value={"gate": ""})]},
        ]
    )

    with pytest.raises(RuntimeError, match="did not include a valid gate name"):
        await orchestrator._invoke_phase2_graph(
            project=project,
            run=run,
            ctx=SimpleNamespace(project=project),
            compiled_graph=compiled_graph,
            graph_config={"configurable": {"thread_id": "t1"}},
            runtime_context=SimpleNamespace(),
            initial_payload={"x": 1},
            auto_mode=False,
        )


@pytest.mark.asyncio
async def test_invoke_phase2_graph_no_gate_key_raises(monkeypatch):
    """Interrupt value without 'gate' key raises RuntimeError."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    compiled_graph = FakeCompiledGraph(
        [
            {"__interrupt__": [SimpleNamespace(value={})]},
        ]
    )

    with pytest.raises(RuntimeError, match="did not include a valid gate name"):
        await orchestrator._invoke_phase2_graph(
            project=project,
            run=run,
            ctx=SimpleNamespace(project=project),
            compiled_graph=compiled_graph,
            graph_config={"configurable": {"thread_id": "t1"}},
            runtime_context=SimpleNamespace(),
            initial_payload={"x": 1},
            auto_mode=False,
        )


@pytest.mark.asyncio
async def test_invoke_phase2_graph_non_dict_result_breaks(monkeypatch):
    """Non-dict result from ainvoke causes immediate break."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    compiled_graph = FakeCompiledGraph(["not-a-dict"])

    result = await orchestrator._invoke_phase2_graph(
        project=project,
        run=run,
        ctx=SimpleNamespace(project=project),
        compiled_graph=compiled_graph,
        graph_config={"configurable": {"thread_id": "t1"}},
        runtime_context=SimpleNamespace(),
        initial_payload={"x": 1},
        auto_mode=False,
    )

    assert result == (False, "compose")


@pytest.mark.asyncio
async def test_run_phase2_graph_unsupported_agent_raises():
    """_run_phase2_graph raises ValueError for agent not in GRAPH_STAGE_FOR_AGENT."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )
    ctx = SimpleNamespace(project=project, run=run, session=session, user_feedback=None)

    with pytest.raises(ValueError, match="Unsupported agent"):
        await orchestrator._run_phase2_graph(
            project=project,
            run=run,
            request=SimpleNamespace(notes=""),
            ctx=ctx,
            agent_name="unknown_agent",
            auto_mode=False,
        )


@pytest.mark.asyncio
async def test_run_phase2_graph_review_agent_sets_feedback(monkeypatch):
    """_run_phase2_graph: review agent sets ctx.user_feedback from request.notes."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )
    ctx = SimpleNamespace(
        project=project,
        run=run,
        session=session,
        user_feedback=None,
        entity_type=None,
        entity_id=None,
        rerun_mode="full",
    )

    async def fake_invoke(**kwargs):
        return False, "compose"

    monkeypatch.setattr(
        "app.agents.orchestrator.build_postgres_checkpointer",
        lambda db: FakeCheckpointerCtx(FakeCompiledGraph([{}])),
    )
    monkeypatch.setattr(
        "app.agents.orchestrator.build_phase2_graph",
        lambda: SimpleNamespace(compile=lambda checkpointer=None: FakeCompiledGraph([{}])),
    )
    monkeypatch.setattr(orchestrator, "_invoke_phase2_graph", fake_invoke)

    await orchestrator._run_phase2_graph(
        project=project,
        run=run,
        request=SimpleNamespace(
            notes="user feedback text",
            skill_id=None,
            entity_type=None,
            entity_id=None,
        ),
        ctx=ctx,
        agent_name="review",
        auto_mode=False,
    )

    assert ctx.user_feedback == "user feedback text"


@pytest.mark.asyncio
async def test_resume_from_recovery_missing_project_returns():
    """resume_from_recovery returns early when project or run not found."""
    session = FakeSession(project=None, run=None)
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=MockWsManager(),
        session=session,
    )

    await orchestrator.resume_from_recovery(project_id=1, run_id=2)
    assert session.commits == 0


@pytest.mark.asyncio
async def test_wait_for_confirm_timeout(monkeypatch):
    """_wait_for_confirm raises RuntimeError on timeout."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_recovery(**kwargs):
        return SimpleNamespace(model_dump=lambda mode=None: {}, preserved_stages=[])

    async def noop(*args, **kwargs):
        pass

    async def fake_wait_confirm(run_id, timeout=1800):
        return False

    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", fake_recovery)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop)
    monkeypatch.setattr("app.agents.orchestrator.store_awaiting_payload", noop)
    monkeypatch.setattr("app.agents.orchestrator.wait_for_confirm_signal", fake_wait_confirm)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop)

    with pytest.raises(RuntimeError, match="等待确认超时"):
        await orchestrator._wait_for_confirm(1, run, "director")


@pytest.mark.asyncio
async def test_wait_for_confirm_with_user_feedback(monkeypatch):
    """_wait_for_confirm returns user feedback from AgentMessage when present."""
    from app.models.agent_run import AgentMessage

    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    msg = AgentMessage(id=10, run_id=2, role="user", content="  user feedback  ", agent="user")
    session = FakeSession(project=project, run=run, scalars_result=[msg])
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_recovery(**kwargs):
        return SimpleNamespace(model_dump=lambda mode=None: {}, preserved_stages=[])

    async def noop(*args, **kwargs):
        pass

    async def fake_wait_confirm(run_id, timeout=1800):
        return True

    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", fake_recovery)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop)
    monkeypatch.setattr("app.agents.orchestrator.store_awaiting_payload", noop)
    monkeypatch.setattr("app.agents.orchestrator.wait_for_confirm_signal", fake_wait_confirm)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop)

    result = await orchestrator._wait_for_confirm(1, run, "director")

    assert result == "user feedback"


@pytest.mark.asyncio
async def test_wait_for_confirm_no_feedback_returns_none(monkeypatch):
    """_wait_for_confirm returns None when no new user feedback found."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run, scalars_result=[])
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_recovery(**kwargs):
        return SimpleNamespace(model_dump=lambda mode=None: {}, preserved_stages=[])

    async def noop(*args, **kwargs):
        pass

    async def fake_wait_confirm(run_id, timeout=1800):
        return True

    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", fake_recovery)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop)
    monkeypatch.setattr("app.agents.orchestrator.store_awaiting_payload", noop)
    monkeypatch.setattr("app.agents.orchestrator.wait_for_confirm_signal", fake_wait_confirm)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop)

    result = await orchestrator._wait_for_confirm(1, run, "director")

    assert result is None


@pytest.mark.asyncio
async def test_wait_for_confirm_confirmed_uses_refreshed_recovery(monkeypatch):
    """run_confirmed event contains rebuilt recovery_summary and next_stage as current_stage."""
    project = SimpleNamespace(id=1, status="draft")
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run, scalars_result=[])
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    call_count = 0

    async def fake_recovery(**kwargs):
        nonlocal call_count
        call_count += 1
        return SimpleNamespace(
            model_dump=lambda *, mode=None: {"call": call_count},
            preserved_stages=[],
        )

    async def noop(*args, **kwargs):
        pass

    async def fake_wait_confirm(run_id, timeout=1800):
        return True

    monkeypatch.setattr("app.agents.orchestrator.build_recovery_summary", fake_recovery)
    monkeypatch.setattr("app.agents.orchestrator.clear_confirm_signal", noop)
    monkeypatch.setattr("app.agents.orchestrator.store_awaiting_payload", noop)
    monkeypatch.setattr("app.agents.orchestrator.wait_for_confirm_signal", fake_wait_confirm)
    monkeypatch.setattr("app.agents.orchestrator.clear_awaiting_payload", noop)

    await orchestrator._wait_for_confirm(
        1,
        run,
        "plan",
        agent_ctx=SimpleNamespace(
            completion_info=SimpleNamespace(
                completed="done", details=None, next="next", question="?"
            ),
        ),
    )

    events = ws.events
    awaiting_evt = [e for e in events if e[1].get("type") == "run_awaiting_confirm"]
    confirmed_evt = [e for e in events if e[1].get("type") == "run_confirmed"]
    assert len(awaiting_evt) == 1
    assert len(confirmed_evt) == 1
    assert awaiting_evt[0][1]["data"]["recovery_summary"]["call"] == 1
    assert confirmed_evt[0][1]["data"]["recovery_summary"]["call"] == 2
    assert confirmed_evt[0][1]["data"]["current_stage"] == "plan_shots"
    assert confirmed_evt[0][1]["data"]["stage"] == "plan_shots"


@pytest.mark.asyncio
async def test_invoke_phase2_graph_raises_when_compose_finishes_without_video(monkeypatch):
    project = SimpleNamespace(id=1, status="planning", video_url=None)
    run = SimpleNamespace(id=2, thread_id=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    compiled_graph = FakeCompiledGraph(
        [
            {"current_stage": "compose_merge"},
            {},
        ]
    )

    async def fake_blocking_clips(_session, _project):
        return [{"shot_id": 99, "status": "failed"}]

    monkeypatch.setattr(
        "app.agents.orchestrator.collect_project_blocking_clips",
        fake_blocking_clips,
    )

    with pytest.raises(RuntimeError, match="Compose finished without a usable final video"):
        await orchestrator._invoke_phase2_graph(
            project=project,
            run=run,
            ctx=SimpleNamespace(project=project),
            compiled_graph=compiled_graph,
            graph_config={"configurable": {"thread_id": "t1"}},
            runtime_context=SimpleNamespace(),
            initial_payload={"current_stage": "compose_videos"},
            auto_mode=False,
        )


@pytest.mark.asyncio
async def test_handle_run_failure_marks_project_failed_and_emits_project_updated(monkeypatch):
    project = SimpleNamespace(id=1, status="planning", video_url=None)
    run = SimpleNamespace(id=2, status="running", error=None)
    session = FakeSession(project=project, run=run)
    ws = MockWsManager()
    orchestrator = GenerationOrchestrator(
        settings=Settings(
            database_url="sqlite+aiosqlite:///:memory:",
            anthropic_api_key="test",
            image_api_key="test",
            video_api_key="test",
        ),
        ws=ws,
        session=session,
    )

    async def fake_blocking_clips(_session, _project):
        return [{"shot_id": 7, "status": "failed"}]

    monkeypatch.setattr(
        "app.agents.orchestrator.collect_project_blocking_clips",
        fake_blocking_clips,
    )

    await orchestrator._handle_run_failure(1, run, 2, RuntimeError("boom"), context="Run")

    assert run.status == "failed"
    assert run.error == "boom"
    assert project.status == "failed"
    event_types = [event[1]["type"] for event in ws.events]
    assert "project_updated" in event_types
    assert event_types[-1] == "run_failed"
