"""Regression tests for fixes in the regenerate, review and resume paths (#146, #150)."""

from __future__ import annotations

import pytest

from app.services import run_lifecycle
from tests.factories import create_character, create_project, create_run, create_shot


@pytest.fixture
def engine_calls(monkeypatch):
    calls: list[dict] = []

    async def fake_engine_start_run(base_url, **kwargs):
        calls.append(kwargs)
        return {"status": "running"}

    monkeypatch.setattr(run_lifecycle, "engine_start_run", fake_engine_start_run)
    return calls


async def _project_with_cut(session):
    project = await create_project(session, status="ready")
    project.video_url = "http://test.com/final.mp4"
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return project


# -- a regenerate that may still fail must not mark the film superseded (#146) --


@pytest.mark.asyncio
async def test_shot_image_regenerate_keeps_the_cut_current(async_client, test_session, engine_calls):
    project = await _project_with_cut(test_session)
    shot = await create_shot(test_session, project_id=project.id)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})

    assert res.status_code == 201
    assert engine_calls[0]["stage"] == "render_shots"
    await test_session.refresh(project)
    assert project.status != "superseded"
    assert project.video_url == "http://test.com/final.mp4"


@pytest.mark.asyncio
async def test_plain_character_redraw_keeps_the_cut_current(async_client, test_session, engine_calls):
    project = await _project_with_cut(test_session)
    character = await create_character(test_session, project_id=project.id)

    res = await async_client.post(f"/api/v1/characters/{character.id}/regenerate", json={"type": "image"})

    assert res.status_code == 201
    await test_session.refresh(project)
    assert project.status != "superseded"


@pytest.mark.asyncio
async def test_character_redraw_with_a_new_description_marks_the_cut_stale(
    async_client, test_session, engine_calls
):
    project = await _project_with_cut(test_session)
    character = await create_character(test_session, project_id=project.id)

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={"type": "image", "description": "now wears a red scarf"},
    )

    assert res.status_code == 201
    await test_session.refresh(project)
    assert project.status == "superseded"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "video"])
async def test_fill_empty_shots_keeps_the_cut_current(async_client, test_session, engine_calls, kind):
    project = await _project_with_cut(test_session)
    await create_shot(test_session, project_id=project.id, order=1)
    await create_shot(test_session, project_id=project.id, order=2, image_url=None, video_url=None)

    res = await async_client.post(f"/api/v1/projects/{project.id}/shots/fill-empty", json={"type": kind})

    assert res.status_code == 201
    await test_session.refresh(project)
    assert project.status != "superseded"


# -- shot approval asks only for what a person can fill in (#150) --


@pytest.mark.asyncio
async def test_shot_approval_does_not_need_render_prompts_or_motion_note(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)
    shot = await create_shot(test_session, project_id=project.id, prompt="")
    shot.camera = "medium shot"
    shot.character_ids = [character.id]
    shot.image_prompt = None
    shot.motion_note = None
    test_session.add(shot)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 200, res.text
    assert res.json()["approval_state"] == "approved"


@pytest.mark.asyncio
async def test_shot_approval_lists_missing_fields_in_chinese(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id)

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert res.status_code == 400
    assert res.json()["error"]["message"] == "批准镜头前请先补全：镜头、出场角色"


# -- editing a description invalidates the old visual review (#150) --


@pytest.mark.asyncio
async def test_description_edit_resets_the_visual_review(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, description="乌鸦看见水瓶")
    shot.review_status = "passed"
    test_session.add(shot)
    await test_session.commit()

    res = await async_client.patch(f"/api/v1/shots/{shot.id}", json={"description": "乌鸦丢石子"})

    assert res.status_code == 200
    body = res.json()
    assert body["review_status"] == "unchecked"
    assert body["review_note"] == "描述已修改，画面还没按新描述重画"


@pytest.mark.asyncio
async def test_description_edit_without_media_leaves_review_alone(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, image_url=None, video_url=None)

    res = await async_client.patch(f"/api/v1/shots/{shot.id}", json={"description": "新的描述"})

    assert res.status_code == 200
    assert res.json()["review_status"] is None


# -- a stopped run cannot be resumed (#150) --


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "message"),
    [("cancelled", "已停止的 run 不能恢复，请重新生成"), ("succeeded", "已完成的 run 不能恢复")],
)
async def test_resume_refuses_finished_runs(async_client, test_session, status, message):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status=status, live_lease=False)

    res = await async_client.post(f"/api/v1/runs/{run.id}/resume")

    assert res.status_code == 409
    error = res.json()["error"]
    assert error["code"] == "RUN_NOT_RESUMABLE"
    assert error["message"] == message


# -- timestamps leave the API as UTC with a Z (#150) --


@pytest.mark.asyncio
async def test_api_timestamps_carry_a_utc_marker(async_client, test_session, engine_calls):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id)

    project_body = (await async_client.get(f"/api/v1/projects/{project.id}")).json()
    run_body = (await async_client.post(f"/api/v1/shots/{shot.id}/regenerate", json={"type": "image"})).json()

    assert project_body["created_at"].endswith("Z")
    assert project_body["updated_at"].endswith("Z")
    assert run_body["created_at"].endswith("Z")
