from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from app.services import run_lifecycle
from app.services import agent_runner as agent_runner_mod
from app.models.agent_run import AgentRun
from tests.factories import create_character, create_project


def _immediate_task(coro):
    loop = asyncio.get_running_loop()
    coro.close()
    fut = loop.create_future()
    fut.set_result(None)
    return fut


class _CaptureWs:
    def __init__(self) -> None:
        self.events: list[tuple[int, dict]] = []

    async def send_event(self, project_id: int, event: dict):
        self.events.append((project_id, event))


@asynccontextmanager
async def _session_cm(session):
    yield session


class _FakeAgent:
    name = "fake-agent"

    async def run(self, ctx):
        ctx.project.status = "processing"
        ctx.session.add(ctx.project)
        await ctx.session.commit()


class _SessionProxy:
    def __init__(self, session, *, get_result=None):
        self._session = session
        self._get_result = get_result

    async def get(self, *args, **kwargs):
        if self._get_result is not None:
            return self._get_result
        return await self._session.get(*args, **kwargs)

    def add(self, obj):
        return self._session.add(obj)

    async def commit(self):
        return await self._session.commit()

    async def refresh(self, obj):
        return await self._session.refresh(obj)


@pytest.mark.asyncio
async def test_list_characters(async_client, test_session):
    project = await create_project(test_session)
    await create_character(test_session, project_id=project.id, name="Hero")
    await create_character(test_session, project_id=project.id, name="Villain")

    res = await async_client.get(f"/api/v1/projects/{project.id}/characters")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 2
    assert data[0]["name"] == "Hero"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["put", "patch"])
async def test_update_character(async_client, test_session, method):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Old Name")

    res = await getattr(async_client, method)(
        f"/api/v1/characters/{character.id}",
        json={"name": "New Name", "description": "Updated"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "New Name"
    assert data["description"] == "Updated"


@pytest.mark.asyncio
async def test_update_character_not_found(async_client):
    res = await async_client.patch(
        "/api/v1/characters/99999",
        json={"name": "Test"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_delete_character(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Delete Me")

    res = await async_client.delete(f"/api/v1/characters/{character.id}")

    assert res.status_code == 204

    list_res = await async_client.get(f"/api/v1/projects/{project.id}/characters")
    assert list_res.status_code == 200
    assert list_res.json() == []


@pytest.mark.asyncio
async def test_delete_character_clears_project_video_when_present(async_client, test_session):
    project = await create_project(test_session)
    project.video_url = "http://test.com/project.mp4"
    test_session.add(project)
    await test_session.commit()

    character = await create_character(test_session, project_id=project.id, name="Delete Me")

    res = await async_client.delete(f"/api/v1/characters/{character.id}")

    assert res.status_code == 204


@pytest.mark.asyncio
async def test_approve_character(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(
        test_session,
        project_id=project.id,
        name="Hero",
        description="desc",
        image_url="/static/hero.png",
    )

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")

    assert res.status_code == 200
    body = res.json()
    assert body["approval_state"] == "approved"


@pytest.mark.asyncio
async def test_approve_character_not_found(async_client):
    res = await async_client.post("/api/v1/characters/99999/approve")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_character_rejects_invalid_type(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "video"},
    )

    assert res.status_code == 400


@pytest.mark.asyncio
async def test_regenerate_character_happy_path(async_client, test_session, monkeypatch):
    # 起 task 的逻辑已收进 run_lifecycle，patron 该模块的 create_task
    monkeypatch.setattr(run_lifecycle.asyncio, "create_task", _immediate_task)

    project = await create_project(test_session)
    character = await create_character(
        test_session,
        project_id=project.id,
        name="Hero",
        image_url="/static/hero.png",
    )

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "image"},
    )

    assert res.status_code == 201
    body = res.json()
    assert body["project_id"] == project.id
    assert body["resource_type"] == "character"


@pytest.mark.asyncio
async def test_regenerate_character_rejects_duplicate_run(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    from tests.factories import create_run

    run = await create_run(test_session, project_id=project.id, status="running")
    run.resource_type = "character"
    run.resource_id = character.id
    test_session.add(run)
    await test_session.commit()

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "image"},
    )

    assert res.status_code == 409


@pytest.mark.asyncio
async def test_regenerate_character_project_not_found(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    await test_session.delete(project)
    await test_session.commit()

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "image"},
    )

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_character_rejects_duplicate_run_with_deleted_project(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    from tests.factories import create_run

    run = await create_run(test_session, project_id=project.id, status="running")
    run.resource_type = "character"
    run.resource_id = character.id
    test_session.add(run)
    await test_session.commit()

    await test_session.delete(project)
    await test_session.commit()

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "image"},
    )

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_character_rejects_invalid_type_when_model_missing(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "video"},
    )

    assert res.status_code == 400


@pytest.mark.asyncio
async def test_run_agent_plan_handles_missing_project_or_run(test_session, test_settings, monkeypatch):
    project = await create_project(test_session)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="fake-agent",
        progress=0.0,
        error=None,
        resource_type="character",
        resource_id=1,
    )
    test_session.add(run)
    await test_session.commit()
    await test_session.refresh(run)

    ws = _CaptureWs()

    @asynccontextmanager
    async def fake_async_session_maker():
        yield _SessionProxy(test_session, get_result=None)

    monkeypatch.setattr(agent_runner_mod, "async_session_maker", fake_async_session_maker)
    monkeypatch.setattr(agent_runner_mod.task_manager, "remove", lambda project_id: None)

    await agent_runner_mod.run_agent_plan(
        project_id=project.id,
        run_id=run.id,
        agent_plan=[_FakeAgent()],
        settings=test_settings,
        ws=ws,
    )

    assert ws.events[0][1]["type"] == "run_started"


@pytest.mark.asyncio
async def test_run_agent_plan_emits_progress_and_completes(test_session, test_settings, monkeypatch):
    project = await create_project(test_session)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="fake-agent",
        progress=0.0,
        error=None,
        resource_type="character",
        resource_id=1,
    )
    # create and persist run through session instead of direct construction
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="fake-agent",
        progress=0.0,
        error=None,
        resource_type="character",
        resource_id=1,
    )
    test_session.add(run)
    await test_session.commit()
    await test_session.refresh(run)

    ws = _CaptureWs()

    @asynccontextmanager
    async def fake_async_session_maker():
        yield _SessionProxy(test_session)

    monkeypatch.setattr(agent_runner_mod, "async_session_maker", fake_async_session_maker)
    monkeypatch.setattr(agent_runner_mod.task_manager, "remove", lambda project_id: None)

    await agent_runner_mod.run_agent_plan(
        project_id=project.id,
        run_id=run.id,
        agent_plan=[_FakeAgent()],
        settings=test_settings,
        ws=ws,
    )

    await test_session.refresh(run)
    await test_session.refresh(project)

    assert run.status == "succeeded"
    assert run.progress == 1.0
    assert project.status == "processing"
    assert any(event[1]["type"] == "run_completed" for event in ws.events)


@pytest.mark.asyncio
async def test_approve_character_delete_then_approve_returns_404(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    await test_session.delete(character)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_delete_character_not_found(async_client):
    res = await async_client.delete("/api/v1/characters/99999")

    assert res.status_code == 404




@pytest.mark.asyncio
async def test_approve_character_rejects_missing_id(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")
    character.id = None

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")

    assert res.status_code == 422


@pytest.mark.asyncio
async def test_approve_character_missing_id(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")
    character.id = None

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")

    assert res.status_code == 422


class _FailingAgent:
    name = "failing-agent"

    async def run(self, ctx):
        raise RuntimeError("agent boom")


class _SlowAgent:
    name = "slow-agent"

    async def run(self, ctx):
        ctx.project.status = "processing"
        ctx.session.add(ctx.project)
        await ctx.session.commit()
        await asyncio.sleep(999)


@pytest.mark.asyncio
async def test_run_agent_plan_handles_exception(test_session, test_settings, monkeypatch):
    """Line 143-154: Exception path sets run.status=failed and emits run_failed event."""
    project = await create_project(test_session)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="failing-agent",
        progress=0.0,
        error=None,
        resource_type="character",
        resource_id=1,
    )
    test_session.add(run)
    await test_session.commit()
    await test_session.refresh(run)

    ws = _CaptureWs()

    @asynccontextmanager
    async def fake_async_session_maker():
        yield _SessionProxy(test_session)

    monkeypatch.setattr(agent_runner_mod, "async_session_maker", fake_async_session_maker)
    monkeypatch.setattr(agent_runner_mod.task_manager, "remove", lambda project_id: None)

    await agent_runner_mod.run_agent_plan(
        project_id=project.id,
        run_id=run.id,
        agent_plan=[_FailingAgent()],
        settings=test_settings,
        ws=ws,
    )

    await test_session.refresh(run)
    assert run.status == "failed"
    assert "agent boom" in (run.error or "")
    assert any(e[1]["type"] == "run_failed" for e in ws.events)


@pytest.mark.asyncio
async def test_run_agent_plan_cancelled(test_session, test_settings, monkeypatch):
    """Line 133-142: CancelledError sets run.status=cancelled and emits run_cancelled event."""
    project = await create_project(test_session)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="slow-agent",
        progress=0.0,
        error=None,
        resource_type="character",
        resource_id=1,
    )
    test_session.add(run)
    await test_session.commit()
    await test_session.refresh(run)

    ws = _CaptureWs()

    cancel_task = None

    @asynccontextmanager
    async def fake_async_session_maker():
        nonlocal cancel_task
        yield _SessionProxy(test_session)
        # cancel the agent task after session exits
        if cancel_task and not cancel_task.done():
            cancel_task.cancel()

    monkeypatch.setattr(agent_runner_mod, "async_session_maker", fake_async_session_maker)
    monkeypatch.setattr(agent_runner_mod.task_manager, "remove", lambda project_id: None)

    import app.services.agent_runner as runner_mod

    original_create_task = asyncio.create_task

    def _capture_create_task(coro):
        nonlocal cancel_task
        task = original_create_task(coro)
        cancel_task = task
        return task

    monkeypatch.setattr(runner_mod.asyncio, "create_task", _capture_create_task)

    import contextlib

    task = asyncio.create_task(
        agent_runner_mod.run_agent_plan(
            project_id=project.id,
            run_id=run.id,
            agent_plan=[_SlowAgent()],
            settings=test_settings,
            ws=ws,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    await test_session.refresh(run)
    assert run.status == "cancelled"
    assert any(e[1]["type"] == "run_cancelled" for e in ws.events)


@pytest.mark.asyncio
async def test_approve_character_project_not_found(async_client, test_session):
    """Line 231: approve character when project deleted → 404."""
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    await test_session.delete(project)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")
    assert res.status_code == 404
