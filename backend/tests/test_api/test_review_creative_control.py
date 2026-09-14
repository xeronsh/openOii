from __future__ import annotations


import pytest

from app.services import run_lifecycle

from tests.factories import create_character, create_project, create_shot


def _stub_engine_dispatch(monkeypatch):
    """Dispatch now goes to the engine; record the call instead of running it."""

    async def fake_engine_start_run(base_url, **kwargs):
        fake_engine_start_run.calls.append(kwargs)  # type: ignore[attr-defined]
        return {"status": "running"}

    fake_engine_start_run.calls = []  # type: ignore[attr-defined]
    monkeypatch.setattr(run_lifecycle, "engine_start_run", fake_engine_start_run)
    return fake_engine_start_run


@pytest.mark.asyncio
async def test_character_regenerate_accepts_edit_payload_and_promotes_on_approval(
    async_client, test_session, monkeypatch
):
    _stub_engine_dispatch(monkeypatch)

    project = await create_project(test_session)
    character = await create_character(
        test_session,
        project_id=project.id,
        name="Draft Hero",
        description="Initial draft",
        image_url="http://test.com/initial.png",
    )
    related_shot = await create_shot(
        test_session,
        project_id=project.id,
        description="Uses the draft hero",
        prompt="Draft hero enters the scene",
        image_url="http://test.com/related-shot.png",
        video_url="http://test.com/related-shot.mp4",
    )
    unrelated_shot = await create_shot(
        test_session,
        project_id=project.id,
        order=2,
        description="Unrelated establishing shot",
        prompt="A quiet empty street",
        image_url="http://test.com/unrelated-shot.png",
        video_url="http://test.com/unrelated-shot.mp4",
    )
    related_shot.character_ids = [character.id]
    test_session.add(related_shot)
    test_session.add(unrelated_shot)
    await test_session.commit()
    await test_session.refresh(related_shot)
    await test_session.refresh(unrelated_shot)

    related_shot.freeze_approval()
    test_session.add(related_shot)
    await test_session.commit()
    await test_session.refresh(related_shot)

    project.video_url = "http://test.com/final-project.mp4"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    approve_res = await async_client.post(f"/api/v1/characters/{character.id}/approve")
    assert approve_res.status_code == 200

    regenerate_res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={
            "type": "image",
            "description": "Refined draft",
            "image_url": "http://test.com/refined.png",
        },
    )
    assert regenerate_res.status_code == 201
    run_body = regenerate_res.json()
    assert run_body["resource_type"] == "character"
    assert run_body["resource_id"] == character.id

    refreshed = await test_session.get(type(character), character.id)
    await test_session.refresh(refreshed)
    assert refreshed.description == "Refined draft"
    assert refreshed.image_url == "http://test.com/refined.png"
    assert refreshed.approval_state == "superseded"

    await test_session.refresh(related_shot)
    await test_session.refresh(unrelated_shot)
    await test_session.refresh(project)
    assert related_shot.video_url is None
    assert project.video_url == "http://test.com/final-project.mp4"
    assert project.status == "superseded"
    assert unrelated_shot.video_url == "http://test.com/unrelated-shot.mp4"

    second_approve = await async_client.post(f"/api/v1/characters/{character.id}/approve")
    assert second_approve.status_code == 200

    await test_session.refresh(refreshed)
    assert refreshed.approval_state == "approved"
    assert refreshed.approved_description == "Refined draft"
    assert refreshed.approved_image_url == "http://test.com/refined.png"


@pytest.mark.asyncio
async def test_character_regenerate_keeps_stale_final_visible_and_surfaces_blockers(
    async_client, test_session, ws_manager, monkeypatch
):
    _stub_engine_dispatch(monkeypatch)

    project = await create_project(test_session, title="Final Assembly")
    character = await create_character(
        test_session,
        project_id=project.id,
        name="Hero",
        description="Original hero",
        image_url="http://test.com/hero.png",
    )
    blocking_shot = await create_shot(
        test_session,
        project_id=project.id,
        description="Blocking shot",
        prompt="Hero reacts",
        image_url="http://test.com/blocking-shot.png",
        video_url="http://test.com/blocking-shot.mp4",
    )
    unrelated_shot = await create_shot(
        test_session,
        project_id=project.id,
        order=2,
        description="Unrelated shot",
        prompt="Background reveal",
        image_url="http://test.com/unrelated-shot.png",
        video_url="http://test.com/unrelated-shot.mp4",
    )
    blocking_shot.character_ids = [character.id]
    test_session.add(blocking_shot)
    test_session.add(unrelated_shot)
    await test_session.commit()
    await test_session.refresh(blocking_shot)
    await test_session.refresh(unrelated_shot)

    project.video_url = "http://test.com/final.mp4"
    project.status = "ready"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    res = await async_client.post(
        f"/api/v1/characters/{character.id}/regenerate",
        json={
            "type": "image",
            "description": "Retouched hero",
            "image_url": "http://test.com/hero-retouched.png",
        },
    )
    assert res.status_code == 201

    await test_session.refresh(project)
    await test_session.refresh(blocking_shot)
    await test_session.refresh(unrelated_shot)

    assert project.video_url == "http://test.com/final.mp4"
    assert project.status == "superseded"
    assert blocking_shot.video_url is None
    assert unrelated_shot.video_url == "http://test.com/unrelated-shot.mp4"

    project_events = [event for _, event in ws_manager.events if event["type"] == "project_updated"]
    assert project_events, "expected a project_updated websocket event"
    payload = project_events[-1]["data"]["project"]
    assert payload["video_url"] == "http://test.com/final.mp4"
    assert payload["status"] == "superseded"
    assert payload["blocking_clips"]
    assert payload["blocking_clips"][0]["shot_id"] == blocking_shot.id
