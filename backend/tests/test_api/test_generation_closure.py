"""Route-level contract for generation/resume/cancel/feedback.

编排已迁移到 pi engine sidecar：路由不再自己跑后台闭包，而是
`_dispatch_to_engine` → loopback HTTP。测试用 stub 替换 `ensure_engine_running`
与 `engine_*`，验证路由契约（状态码、DB 状态、引擎调用参数）。
"""

from __future__ import annotations

from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.api.deps import get_app_settings, get_db_session, get_ws_manager
from app.api.v1.routes import generation as generation_routes
from app.main import create_app
from app.models.agent_run import AgentRun
from app.schemas.project import ProjectProviderEntry
from tests.factories import create_project, create_run


class _EngineCalls:
    """Record engine HTTP calls in place of the real sidecar."""

    def __init__(self) -> None:
        self.start: list[dict[str, Any]] = []
        self.resume: list[dict[str, Any]] = []
        self.cancel: list[dict[str, Any]] = []
        self.runs: int = 0
        self.unavailable: bool = False

    def install(self, monkeypatch) -> None:
        async def ensure(base_url: str, database_url: str, static_dir: Any) -> None:
            self.runs += 1
            if self.unavailable:
                raise generation_routes.EngineUnavailableError("engine down")

        async def start(base_url: str, **kwargs: Any) -> dict[str, Any]:
            self.start.append(kwargs)
            return {"status": "running"}

        async def resume(base_url: str, **kwargs: Any) -> dict[str, Any]:
            self.resume.append(kwargs)
            return {"status": "running"}

        async def cancel(base_url: str, run_id: int) -> None:
            self.cancel.append({"run_id": run_id})

        monkeypatch.setattr(generation_routes, "ensure_engine_running", ensure)
        monkeypatch.setattr(generation_routes, "engine_start_run", start)
        monkeypatch.setattr(generation_routes, "engine_resume_run", resume)
        monkeypatch.setattr(generation_routes, "engine_cancel_run", cancel)


def _valid_resolution() -> generation_routes.ProviderResolution:
    return generation_routes.ProviderResolution(
        valid=True,
        text=ProjectProviderEntry(
            selected_key="anthropic",
            source="default",
            resolved_key="anthropic",
            valid=True,
            reason_code=None,
            reason_message=None,
        ),
        image=ProjectProviderEntry(
            selected_key="openai",
            source="default",
            resolved_key="openai",
            valid=True,
            reason_code=None,
            reason_message=None,
        ),
        video=ProjectProviderEntry(
            selected_key="openai",
            source="default",
            resolved_key="openai",
            valid=True,
            reason_code=None,
            reason_message=None,
        ),
    )


async def _async_return(value):
    return value


@pytest.fixture()
def engine_calls() -> _EngineCalls:
    return _EngineCalls()


@pytest.fixture()
def closure_app(test_db_engine_sessionmaker, test_settings, ws_manager, monkeypatch):
    _, shared_maker = test_db_engine_sessionmaker

    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _async_return(_valid_resolution()),
    )

    app = create_app()

    async def override_get_session():
        async with shared_maker() as session:
            yield session

    async def override_get_settings():
        return test_settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws

    return {"app": app, "session_maker": shared_maker, "ws": ws_manager}


@pytest_asyncio.fixture()
async def closure_client(closure_app, engine_calls, monkeypatch):
    engine_calls.install(monkeypatch)
    transport = ASGITransport(app=closure_app["app"])
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, closure_app, engine_calls


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_dispatches_full_run_to_engine(closure_client):
    client, ctx, engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)

    res = await client.post(f"/api/v1/projects/{project.id}/generate", json={})
    assert res.status_code == 201

    assert len(engine.start) == 1
    assert engine.start[0]["project_id"] == project.id
    assert engine.start[0]["stage"] == "full"

    async with ctx["session_maker"]() as session:
        run = await session.get(AgentRun, res.json()["id"])
        assert run is not None
        assert run.status == "running"


@pytest.mark.asyncio
async def test_generate_returns_503_when_engine_unavailable(closure_client):
    client, ctx, engine = closure_client
    engine.unavailable = True

    async with ctx["session_maker"]() as session:
        project = await create_project(session)

    res = await client.post(f"/api/v1/projects/{project.id}/generate", json={})
    assert res.status_code == 503


@pytest.mark.asyncio
async def test_generate_returns_409_for_active_conflict(closure_client):
    client, ctx, _engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        await create_run(session, project_id=project.id, status="running")

    res = await client.post(f"/api/v1/projects/{project.id}/generate", json={})
    assert res.status_code == 409
    body = res.json()
    assert "run" in body or "state" in body or "kind" in body


@pytest.mark.asyncio
async def test_generate_returns_409_for_recoverable_conflict(closure_client):
    client, ctx, _engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        await create_run(session, project_id=project.id, status="failed")

    res = await client.post(f"/api/v1/projects/{project.id}/generate", json={})
    assert res.status_code == 409


# ---------------------------------------------------------------------------
# resume
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_returns_404_when_project_missing(closure_client):
    client, _ctx, _engine = closure_client
    res = await client.post("/api/v1/projects/99999/resume", json={"run_id": 1})
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_resume_returns_404_when_run_missing(closure_client):
    client, ctx, _engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)

    res = await client.post(
        f"/api/v1/projects/{project.id}/resume", json={"run_id": 99999}
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_resume_returns_existing_run_when_task_still_running(
    closure_client, monkeypatch
):
    client, ctx, engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        run = await create_run(session, project_id=project.id, status="running")

    monkeypatch.setattr(generation_routes.task_manager, "is_running", lambda pid: True)

    res = await client.post(f"/api/v1/projects/{project.id}/resume", json={"run_id": run.id})
    assert res.status_code == 200
    assert res.json()["id"] == run.id
    assert engine.resume == [], "不应向引擎重复发起 resume"
    assert engine.runs == 0


@pytest.mark.asyncio
async def test_resume_dispatches_to_engine(closure_client):
    client, ctx, engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        run = await create_run(session, project_id=project.id, status="paused")

    res = await client.post(f"/api/v1/projects/{project.id}/resume", json={"run_id": run.id})
    assert res.status_code == 200
    assert len(engine.resume) == 1
    assert engine.resume[0]["run_id"] == run.id


@pytest.mark.asyncio
async def test_resume_returns_503_when_engine_unavailable(closure_client):
    client, ctx, engine = closure_client
    engine.unavailable = True

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        run = await create_run(session, project_id=project.id, status="paused")

    res = await client.post(f"/api/v1/projects/{project.id}/resume", json={"run_id": run.id})
    assert res.status_code == 503


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_returns_404_when_project_missing(closure_client):
    client, _ctx, _engine = closure_client
    res = await client.post("/api/v1/projects/99999/cancel")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_cancel_marks_runs_emits_ws_and_notifies_engine(closure_client, monkeypatch):
    client, ctx, engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        await create_run(session, project_id=project.id, status="running")
        await create_run(session, project_id=project.id, status="queued")

    monkeypatch.setattr(generation_routes.task_manager, "cancel", lambda pid: True)

    res = await client.post(f"/api/v1/projects/{project.id}/cancel")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "cancelled"
    assert body["cancelled"] == 2

    assert len(engine.cancel) == 1
    assert ctx["ws"].events
    last_project_id, last_event = ctx["ws"].events[-1]
    assert last_project_id == project.id
    assert last_event["type"] == "run_cancelled"
    assert last_event["data"]["cancelled_count"] == 2


# ---------------------------------------------------------------------------
# feedback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_feedback_returns_404_when_project_missing(closure_client):
    client, _ctx, _engine = closure_client
    res = await client.post("/api/v1/projects/99999/feedback", json={"content": "fix tone"})
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_feedback_routes_through_review_then_dispatches(closure_client, monkeypatch):
    """反馈必须经 ReviewAgent 决定起点，再由引擎从该阶段起跑。"""
    client, ctx, engine = closure_client

    async def fake_route(**_kwargs) -> str:
        return "render_characters"

    monkeypatch.setattr(generation_routes, "_route_feedback_to_stage", fake_route)

    async with ctx["session_maker"]() as session:
        project = await create_project(session)

    res = await client.post(f"/api/v1/projects/{project.id}/feedback", json={"content": "fix tone"})
    assert res.status_code == 202
    body = res.json()
    assert body["status"] == "accepted"

    assert len(engine.start) == 1
    assert engine.start[0]["stage"] == "render_characters"
    assert engine.start[0]["user_feedback"] == "fix tone"
    assert engine.start[0]["auto_mode"] is False

    async with ctx["session_maker"]() as session:
        run = await session.get(AgentRun, body["run_id"])
        assert run is not None
        assert run.status == "running"


@pytest.mark.asyncio
async def test_feedback_returns_503_when_engine_unavailable(closure_client, monkeypatch):
    client, ctx, engine = closure_client
    engine.unavailable = True
    monkeypatch.setattr(
        generation_routes, "_route_feedback_to_stage", lambda **_kw: _async_return("plan_characters")
    )

    async with ctx["session_maker"]() as session:
        project = await create_project(session)

    res = await client.post(f"/api/v1/projects/{project.id}/feedback", json={"content": "fix tone"})
    assert res.status_code == 503


@pytest.mark.asyncio
async def test_feedback_returns_409_when_run_active(closure_client):
    client, ctx, _engine = closure_client

    async with ctx["session_maker"]() as session:
        project = await create_project(session)
        await create_run(session, project_id=project.id, status="running")

    res = await client.post(f"/api/v1/projects/{project.id}/feedback", json={"content": "fix tone"})
    assert res.status_code == 409


# ---------------------------------------------------------------------------
# route-level helpers
# ---------------------------------------------------------------------------


def test_require_run_id_raises_when_missing():
    run = AgentRun(project_id=1, status="queued")
    with pytest.raises(RuntimeError, match="missing an id"):
        generation_routes._require_run_id(run)


def test_require_run_id_returns_id_when_present():
    run = AgentRun(id=42, project_id=1, status="queued")
    assert generation_routes._require_run_id(run) == 42


def test_agent_run_thread_id_handles_missing_id():
    pending = AgentRun(project_id=1, status="queued")
    assert generation_routes._agent_run_thread_id(pending) == "agent-run-pending"
    persisted = AgentRun(id=99, project_id=1, status="queued")
    assert generation_routes._agent_run_thread_id(persisted) == "agent-run-99"


def test_feedback_agent_to_stage_map_targets_real_stages():
    from app.orchestration import PHASE2_STAGE_ORDER

    for agent, stage in generation_routes._AGENT_TO_START_STAGE.items():
        assert stage in PHASE2_STAGE_ORDER, f"{agent} → {stage} 不在阶段表内"
