from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import select

from app.api.deps import get_app_settings, get_db_session, get_ws_manager
from app.agents.review_rules import ReviewAgent
from app.api.v1.routes import generation as generation_routes
from app.main import create_app
from app.models.agent_run import AgentRun
from app.schemas.project import ProjectProviderEntry
from tests.factories import create_project, create_run


def _provider_resolution_deterministic() -> generation_routes.ProviderResolution:
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


async def _noop_task() -> None:
    return None


async def _return_resolution(_project, _settings, resolution):
    return resolution


def _invalid_provider_resolution() -> generation_routes.ProviderResolution:
    return generation_routes.ProviderResolution(
        valid=False,
        text=ProjectProviderEntry(
            selected_key="openai",
            source="project",
            resolved_key=None,
            valid=False,
            reason_code="provider_missing_credentials",
            reason_message="缺少 OpenAI 文本凭据",
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


def _video_only_invalid_provider_resolution() -> generation_routes.ProviderResolution:
    return generation_routes.ProviderResolution(
        valid=False,
        text=ProjectProviderEntry(
            selected_key="openai",
            source="default",
            resolved_key="openai",
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
            resolved_key=None,
            valid=False,
            reason_code="provider_missing_credentials",
            reason_message="缺少 OpenAI 视频凭据",
        ),
    )


@pytest.mark.asyncio
async def test_generate_project_not_found(async_client):
    res = await async_client.post("/api/v1/projects/99999/generate", json={})
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_dispatch_to_engine_starts_run(monkeypatch):
    """_dispatch_to_engine 要把 stage/auto_mode/user_feedback 透传给引擎。"""
    captured: list[dict] = []

    async def _ensure(base_url, database_url, static_dir):
        captured.append({"ensured": True})

    async def _start(base_url, **kwargs):
        captured.append(kwargs)
        return {"status": "running"}

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _ensure)
    monkeypatch.setattr(generation_routes, "engine_start_run", _start)

    from app.config import Settings

    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    await generation_routes._dispatch_to_engine(
        settings=settings,
        project_id=7,
        run_id=11,
        stage="render_shots",
        auto_mode=True,
        user_feedback="调整节奏",
    )

    assert captured[0] == {"ensured": True}
    assert captured[1]["project_id"] == 7
    assert captured[1]["run_id"] == 11
    assert captured[1]["stage"] == "render_shots"
    assert captured[1]["auto_mode"] is True
    assert captured[1]["user_feedback"] == "调整节奏"


@pytest.mark.asyncio
async def test_dispatch_to_engine_resume_uses_resume_endpoint(monkeypatch):
    resumed: list[dict] = []

    async def _ensure(base_url, database_url, static_dir):
        return None

    async def _resume(base_url, **kwargs):
        resumed.append(kwargs)
        return {"status": "running"}

    async def _start(base_url, **kwargs):  # pragma: no cover - must not be called
        raise AssertionError("resume 不应走 start")

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _ensure)
    monkeypatch.setattr(generation_routes, "engine_resume_run", _resume)
    monkeypatch.setattr(generation_routes, "engine_start_run", _start)

    from app.config import Settings

    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    await generation_routes._dispatch_to_engine(
        settings=settings, project_id=3, run_id=5, resume=True
    )

    assert resumed == [{"project_id": 3, "run_id": 5}]


@pytest.mark.asyncio
async def test_dispatch_to_engine_maps_unavailable_to_503(monkeypatch):
    from fastapi import HTTPException

    async def _ensure(base_url, database_url, static_dir):
        raise generation_routes.EngineUnavailableError("engine down")

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _ensure)

    from app.config import Settings

    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    with pytest.raises(HTTPException) as exc:
        await generation_routes._dispatch_to_engine(
            settings=settings, project_id=1, run_id=1
        )
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_generate_project_success(async_client, test_session, monkeypatch):
    expected_snapshot = (
        _provider_resolution_deterministic().as_project_provider_settings().model_dump(mode="json")
    )
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(
            project,
            settings,
            _provider_resolution_deterministic(),
        ),
    )

    project = await create_project(test_session)
    res = await async_client.post(f"/api/v1/projects/{project.id}/generate", json={})
    assert res.status_code == 201
    data = res.json()
    run = await test_session.get(AgentRun, data["id"])
    assert run is not None
    assert run.status == "running"
    assert data["provider_snapshot"] == expected_snapshot
    assert run.provider_snapshot == expected_snapshot


@pytest.mark.asyncio
async def test_generate_project_returns_provider_precheck_failed_without_creating_run(
    async_client, test_session, monkeypatch
):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(
            project, settings, _invalid_provider_resolution()
        ),
    )

    project = await create_project(test_session)
    before = (await test_session.execute(select(AgentRun))).scalars().all()

    res = await async_client.post(f"/api/v1/projects/{project.id}/generate", json={})

    assert res.status_code == 422
    data = res.json()
    assert data["error"]["code"] == "PROVIDER_PRECHECK_FAILED"
    assert data["error"]["details"]["provider_resolution"]["modalities"]["text"]["reason_code"] == (
        "provider_missing_credentials"
    )
    after = (await test_session.execute(select(AgentRun))).scalars().all()
    assert len(after) == len(before)


@pytest.mark.asyncio
async def test_generate_project_allows_start_when_only_video_provider_is_invalid(
    async_client, test_session, monkeypatch
):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(
            project, settings, _video_only_invalid_provider_resolution()
        ),
    )

    project = await create_project(test_session)

    res = await async_client.post(f"/api/v1/projects/{project.id}/generate", json={})

    assert res.status_code == 201
    data = res.json()
    run = await test_session.get(AgentRun, data["id"])
    assert run is not None
    assert run.status == "running"


@pytest.mark.asyncio
async def test_generate_project_does_not_require_admin_token(
    test_session, test_settings, ws_manager, monkeypatch
):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(
            project,
            settings,
            generation_routes.ProviderResolution(
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
            ),
        ),
    )

    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return test_settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws

    project = await create_project(test_session)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(f"/api/v1/projects/{project.id}/generate", json={})

    assert res.status_code == 201


@pytest.mark.asyncio
async def test_cancel_project_run_no_active(async_client, test_session):
    project = await create_project(test_session)
    res = await async_client.post(f"/api/v1/projects/{project.id}/cancel")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "no_active_run"


@pytest.mark.asyncio
async def test_cancel_project_run_updates(async_client, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="running")

    res = await async_client.post(f"/api/v1/projects/{project.id}/cancel")
    assert res.status_code == 200
    await test_session.refresh(run)
    assert run.status == "cancelled"


@pytest.mark.asyncio
async def test_feedback_project_success(async_client, test_session, monkeypatch):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(
            project,
            settings,
            _provider_resolution_deterministic(),
        ),
    )

    # ReviewAgent 的路由决策由 LLM 承担；此处只验路由契约，不调外部模型。
    async def _fake_route(**_kwargs) -> str:
        return "plan_characters"

    monkeypatch.setattr(generation_routes, "_route_feedback_to_stage", _fake_route)

    project = await create_project(test_session)
    res = await async_client.post(
        f"/api/v1/projects/{project.id}/feedback",
        json={"content": "Please adjust tone"},
    )
    assert res.status_code == 202
    data = res.json()
    run = await test_session.get(AgentRun, data["run_id"])
    assert run is not None
    assert run.status == "running"
    assert (
        run.provider_snapshot
        == _provider_resolution_deterministic()
        .as_project_provider_settings()
        .model_dump(mode="json")
    )

    from app.models.message import Message

    res = await test_session.execute(select(Message).where(Message.run_id == run.id))
    messages = res.scalars().all()
    assert len(messages) == 1
    assert messages[0].content == "Please adjust tone"


@pytest.mark.asyncio
async def test_feedback_project_returns_409_for_active_conflict(async_client, test_session):
    project = await create_project(test_session)
    await create_run(test_session, project_id=project.id, status="running")

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/feedback",
        json={"content": "Please adjust tone"},
    )

    assert res.status_code == 409
    body = res.json()
    assert "run" in body or "state" in body or "kind" in body


@pytest.mark.asyncio
async def test_review_agent_routes_shot_feedback_to_render(test_session, test_settings):
    import json

    from tests.agent_fixtures import FakeLLM, make_context

    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(
        json.dumps(
            {
                "agent": "review",
                "analysis": {
                    "feedback_type": "shot",
                    "summary": "重渲染镜头",
                    "target_items": [],
                    "suggested_changes": "重画",
                },
                "routing": {
                    "start_agent": "render",
                    "mode": "incremental",
                    "reason": "shot image redo",
                },
                "target_ids": {"character_ids": [], "shot_ids": []},
            },
            ensure_ascii=False,
        )
    )
    ctx = await make_context(
        test_session,
        test_settings,
        project=project,
        run=run,
        llm=llm,
    )
    ctx.user_feedback = "请重新渲染这个镜头"
    ctx.feedback_type = "shot"

    routing = await ReviewAgent().run(ctx)

    assert routing["start_agent"] == "render"
    assert routing["mode"] == "incremental"
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_resume_run_mismatched_project_id(async_client, test_session):
    """Resume a run that belongs to a different project → 404."""
    project = await create_project(test_session)
    other_project = await create_project(test_session)
    run = await create_run(test_session, project_id=other_project.id, status="failed")

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/resume",
        json={"run_id": run.id},
    )
    assert res.status_code == 404
    assert "Run not found" in res.json()["detail"]


@pytest.mark.asyncio
async def test_generation_state_none_when_no_runs(async_client, test_session):
    project = await create_project(test_session)
    res = await async_client.get(f"/api/v1/projects/{project.id}/generation-state")
    assert res.status_code == 200
    assert res.json() is None


@pytest.mark.asyncio
async def test_generation_state_recoverable_for_failed_run(async_client, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="failed")

    res = await async_client.get(f"/api/v1/projects/{project.id}/generation-state")
    assert res.status_code == 200
    data = res.json()
    assert data is not None
    assert data["state"] == "recoverable"
    assert data["active_run"]["id"] == run.id
    assert "resume" in data["available_actions"]


@pytest.mark.asyncio
async def test_generation_state_recoverable_for_stale_running_run(async_client, test_session):
    """DB 里是 running 但进程内没有任务（如中途崩溃）→ 应视为可恢复而非活跃。"""
    project = await create_project(test_session)
    await create_run(test_session, project_id=project.id, status="running")

    res = await async_client.get(f"/api/v1/projects/{project.id}/generation-state")
    assert res.status_code == 200
    data = res.json()
    assert data is not None
    assert data["state"] == "recoverable"


@pytest.mark.asyncio
async def test_generation_state_project_not_found(async_client):
    res = await async_client.get("/api/v1/projects/999999/generation-state")
    assert res.status_code == 404
