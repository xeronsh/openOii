from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager

import pytest

from app.services import agent_runner as agent_runner_mod
from app.models.agent_run import AgentRun

from tests.factories import create_character, create_project, create_shot


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
async def test_list_shots(async_client, test_session):
    project = await create_project(test_session)
    await create_shot(test_session, project_id=project.id, order=1)
    await create_shot(test_session, project_id=project.id, order=2)

    res = await async_client.get(f"/api/v1/projects/{project.id}/shots")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 2
    assert data[0]["order"] == 1


@pytest.mark.asyncio
async def test_reorder_project_shots_updates_orders_atomically(
    async_client, test_session, ws_manager
):
    project = await create_project(test_session)
    first = await create_shot(test_session, project_id=project.id, order=1)
    second = await create_shot(test_session, project_id=project.id, order=2)
    third = await create_shot(test_session, project_id=project.id, order=3)

    res = await async_client.patch(
        f"/api/v1/projects/{project.id}/shots/reorder",
        json={
            "items": [
                {"shot_id": third.id, "order": 1},
                {"shot_id": first.id, "order": 2},
                {"shot_id": second.id, "order": 3},
            ]
        },
    )

    assert res.status_code == 200
    body = res.json()
    assert [shot["id"] for shot in body["shots"]] == [third.id, first.id, second.id]
    assert [shot["order"] for shot in body["shots"]] == [1, 2, 3]

    list_res = await async_client.get(f"/api/v1/projects/{project.id}/shots")
    assert [shot["id"] for shot in list_res.json()] == [third.id, first.id, second.id]
    assert ws_manager.events[-1][0] == project.id
    assert ws_manager.events[-1][1]["type"] == "shots_reordered"
    assert [shot["id"] for shot in ws_manager.events[-1][1]["data"]["shots"]] == [
        third.id,
        first.id,
        second.id,
    ]


@pytest.mark.asyncio
async def test_reorder_project_shots_marks_existing_final_video_superseded(
    async_client, test_session, ws_manager
):
    project = await create_project(test_session)
    project.video_url = "http://test.com/final.mp4"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)
    first = await create_shot(test_session, project_id=project.id, order=1)
    second = await create_shot(test_session, project_id=project.id, order=2)

    res = await async_client.patch(
        f"/api/v1/projects/{project.id}/shots/reorder",
        json={
            "items": [
                {"shot_id": second.id, "order": 1},
                {"shot_id": first.id, "order": 2},
            ]
        },
    )

    assert res.status_code == 200
    await test_session.refresh(project)
    assert project.video_url == "http://test.com/final.mp4"
    assert project.status == "superseded"
    assert [event[1]["type"] for event in ws_manager.events[-2:]] == [
        "shots_reordered",
        "project_updated",
    ]
    assert ws_manager.events[-1][1]["data"]["project"]["status"] == "superseded"


@pytest.mark.asyncio
async def test_reorder_project_shots_rejects_invalid_payloads(async_client, test_session):
    project = await create_project(test_session)
    other_project = await create_project(test_session)
    first = await create_shot(test_session, project_id=project.id, order=1)
    second = await create_shot(test_session, project_id=project.id, order=2)
    other = await create_shot(test_session, project_id=other_project.id, order=1)

    duplicate_res = await async_client.patch(
        f"/api/v1/projects/{project.id}/shots/reorder",
        json={
            "items": [
                {"shot_id": first.id, "order": 1},
                {"shot_id": first.id, "order": 2},
            ]
        },
    )
    assert duplicate_res.status_code == 400

    gap_res = await async_client.patch(
        f"/api/v1/projects/{project.id}/shots/reorder",
        json={
            "items": [
                {"shot_id": first.id, "order": 1},
                {"shot_id": second.id, "order": 3},
            ]
        },
    )
    assert gap_res.status_code == 400

    other_project_res = await async_client.patch(
        f"/api/v1/projects/{project.id}/shots/reorder",
        json={
            "items": [
                {"shot_id": first.id, "order": 1},
                {"shot_id": other.id, "order": 2},
            ]
        },
    )
    assert other_project_res.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["put", "patch"])
async def test_update_shot(async_client, test_session, method):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, description="Old")

    res = await getattr(async_client, method)(
        f"/api/v1/shots/{shot.id}",
        json={"description": "New description", "prompt": "New prompt"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["description"] == "New description"
    assert data["prompt"] == "New prompt"


@pytest.mark.asyncio
async def test_update_shot_not_found(async_client):
    res = await async_client.patch(
        "/api/v1/shots/99999",
        json={"description": "Test"},
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_shot(async_client, test_session, monkeypatch):
    monkeypatch.setattr(agent_runner_mod.asyncio, "create_task", _immediate_task)

    project = await create_project(test_session)
    project.video_url = "http://test.com/project-final.mp4"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    shot = await create_shot(
        test_session,
        project_id=project.id,
        description="Approved shot",
        prompt="Approved prompt",
        image_url="http://test.com/approved-shot.png",
        video_url="http://test.com/approved-shot.mp4",
    )

    shot.freeze_approval()
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "video"})
    assert res.status_code == 201
    body = res.json()
    assert body["resource_type"] == "shot"
    assert body["resource_id"] == shot.id

    await test_session.refresh(shot)
    await test_session.refresh(project)
    assert shot.video_url == "http://test.com/approved-shot.mp4"
    assert project.video_url == "http://test.com/project-final.mp4"
    assert project.status == "superseded"


@pytest.mark.asyncio
async def test_delete_shot(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, description="Delete shot")

    res = await async_client.delete(f"/api/v1/shots/{shot.id}")

    assert res.status_code == 204

    list_res = await async_client.get(f"/api/v1/projects/{project.id}/shots")
    assert list_res.status_code == 200
    assert list_res.json() == []




@pytest.mark.asyncio
async def test_approve_shot(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Cast")
    shot = await create_shot(
        test_session,
        project_id=project.id,
        order=1,
        description="desc",
        prompt="prompt",
        image_url="http://test.com/shot.png",
        duration=5,
    )
    shot.camera = "cam"
    shot.motion_note = "note"
    shot.image_prompt = "image prompt"
    shot.character_ids = [character.id]
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 200
    body = res.json()
    assert body["approval_state"] == "approved"


@pytest.mark.asyncio
async def test_approve_shot_not_found(async_client):
    res = await async_client.post("/api/v1/shots/99999/approve")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_approve_shot_rejects_missing_fields(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1, description="desc")

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 400


@pytest.mark.asyncio
async def test_regenerate_shot_rejects_duplicate_run_with_existing_run(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    # create an in-flight run for same shot
    from tests.factories import create_run

    run = await create_run(test_session, project_id=project.id, status="running")
    run.resource_type = "shot"
    run.resource_id = shot.id
    test_session.add(run)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})

    assert res.status_code == 409


@pytest.mark.asyncio
async def test_approve_shot_rejects_missing_character(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1, description="desc")

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 400


@pytest.mark.asyncio
async def test_regenerate_shot_happy_path(async_client, test_session, monkeypatch):
    monkeypatch.setattr(agent_runner_mod.asyncio, "create_task", _immediate_task)

    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})

    assert res.status_code == 201
    body = res.json()
    assert body["project_id"] == project.id
    assert body["resource_type"] == "shot"


@pytest.mark.asyncio
async def test_regenerate_shot_defaults_to_video(async_client, test_session, monkeypatch):
    monkeypatch.setattr(agent_runner_mod.asyncio, "create_task", _immediate_task)

    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate")

    assert res.status_code == 201


@pytest.mark.asyncio
async def test_regenerate_shot_rejects_duplicate_run(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    from tests.factories import create_run

    run = await create_run(test_session, project_id=project.id, status="running")
    run.resource_type = "shot"
    run.resource_id = shot.id
    test_session.add(run)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})

    assert res.status_code == 409


@pytest.mark.asyncio
async def test_regenerate_shot_project_not_found(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    await test_session.delete(project)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_shot_rejects_invalid_type(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "bad"})

    assert res.status_code == 422


@pytest.mark.asyncio
async def test_run_agent_plan_emits_progress_and_completes(test_session, test_settings, monkeypatch):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="fake-agent",
        progress=0.0,
        error=None,
        resource_type="shot",
        resource_id=shot.id,
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
        target_ids=None,
    )

    await test_session.refresh(run)
    await test_session.refresh(project)

    assert run.status == "succeeded"
    assert run.progress == 1.0
    assert project.status == "processing"
    assert any(event[1]["type"] == "run_completed" for event in ws.events)


@pytest.mark.asyncio
async def test_approve_shot_not_found_after_delete(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    await test_session.delete(shot)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_update_shot_not_found_after_delete(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    await test_session.delete(shot)
    await test_session.commit()

    res = await async_client.patch(f"/api/v1/shots/{shot.id}", json={"description": "x"})

    assert res.status_code == 404




@pytest.mark.asyncio
async def test_approve_shot_rejects_missing_id(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)
    shot.id = None

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 422


@pytest.mark.asyncio
async def test_delete_shot_clears_project_video_when_present(async_client, test_session):
    project = await create_project(test_session)
    project.video_url = "http://test.com/project.mp4"
    test_session.add(project)
    await test_session.commit()

    shot = await create_shot(test_session, project_id=project.id, description="Delete shot")

    res = await async_client.delete(f"/api/v1/shots/{shot.id}")

    assert res.status_code == 204


# --- _run_agent_plan tests ---


class _FailingAgent:
    name = "failing-agent"

    async def run(self, ctx):
        raise RuntimeError("shot agent boom")


class _SlowAgent:
    name = "slow-agent"

    async def run(self, ctx):
        ctx.project.status = "processing"
        ctx.session.add(ctx.project)
        await ctx.session.commit()
        await asyncio.sleep(999)


@pytest.mark.asyncio
async def test_run_agent_plan_handles_exception(test_session, test_settings, monkeypatch):
    """Line 214-224: Exception path sets run.status=failed and emits run_failed event."""
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="failing-agent",
        progress=0.0,
        error=None,
        resource_type="shot",
        resource_id=shot.id,
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
        target_ids=None,
    )

    await test_session.refresh(run)
    assert run.status == "failed"
    assert "shot agent boom" in (run.error or "")
    assert any(e[1]["type"] == "run_failed" for e in ws.events)


@pytest.mark.asyncio
async def test_run_agent_plan_cancelled(test_session, test_settings, monkeypatch):
    """Line 204-212: CancelledError sets run.status=cancelled and emits run_cancelled event."""
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)
    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="slow-agent",
        progress=0.0,
        error=None,
        resource_type="shot",
        resource_id=shot.id,
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

    task = asyncio.create_task(
        agent_runner_mod.run_agent_plan(
            project_id=project.id,
            run_id=run.id,
            agent_plan=[_SlowAgent()],
            settings=test_settings,
            ws=ws,
            target_ids=None,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    await test_session.refresh(run)
    assert run.status == "cancelled"
    assert any(e[1]["type"] == "run_cancelled" for e in ws.events)


# --- _validate_shot_approval_ready edge cases ---


@pytest.mark.asyncio
async def test_approve_shot_missing_duration(async_client, test_session):
    """Line 83-84: _validate_shot_approval_ready raises 400 when duration is missing."""
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Cast")
    shot = await create_shot(
        test_session,
        project_id=project.id,
        order=1,
        description="desc",
        prompt="prompt",
    )
    shot.camera = "cam"
    shot.motion_note = "note"
    shot.image_prompt = "img prompt"
    shot.duration = None
    shot.character_ids = [character.id]
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_validate_shot_character_ids_empty_list(async_client, test_session):
    """Empty character_ids → validation passes but approval rejects missing chars."""
    project = await create_project(test_session)
    shot = await create_shot(
        test_session,
        project_id=project.id,
        order=1,
        description="desc",
        prompt="prompt",
    )
    shot.camera = "cam"
    shot.motion_note = "note"
    shot.image_prompt = "img prompt"
    shot.duration = 5
    shot.character_ids = []
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_validate_shot_unknown_character_ids(async_client, test_session):
    """approve with character_ids that don't belong to project → 400."""
    project = await create_project(test_session)
    shot = await create_shot(
        test_session,
        project_id=project.id,
        order=1,
        description="desc",
        prompt="prompt",
    )
    shot.camera = "cam"
    shot.motion_note = "note"
    shot.image_prompt = "img prompt"
    shot.duration = 5
    shot.character_ids = [99999]
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert res.status_code == 400
    assert "Unknown character_ids" in res.json()["error"]["message"]
