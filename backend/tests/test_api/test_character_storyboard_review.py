from __future__ import annotations

import pytest

from tests.factories import create_character, create_project, create_shot


@pytest.mark.asyncio
async def test_character_update_and_approve_freezes_primary_reference(
    async_client, test_session, ws_manager
):
    project = await create_project(test_session)
    assert project.id is not None
    character = await create_character(
        test_session,
        project_id=project.id,
        name="Draft Hero",
        description="Initial draft",
        image_url="http://test.com/draft.png",
    )

    update_res = await async_client.patch(
        f"/api/v1/characters/{character.id}",
        json={
            "name": "Approved Hero",
            "description": "Polished draft",
            "image_url": "http://test.com/final.png",
        },
    )
    assert update_res.status_code == 200
    update_body = update_res.json()
    assert update_body["approval_state"] == "draft"
    assert update_body["approved_at"] is None

    approve_res = await async_client.post(f"/api/v1/characters/{character.id}/approve")
    assert approve_res.status_code == 200
    approve_body = approve_res.json()
    assert approve_body["approval_state"] == "approved"
    assert approve_body["approved_name"] == "Approved Hero"
    assert approve_body["approved_description"] == "Polished draft"
    assert approve_body["approved_image_url"] == "http://test.com/final.png"

    repatch_res = await async_client.patch(
        f"/api/v1/characters/{character.id}",
        json={"image_url": "http://test.com/new-draft.png"},
    )
    assert repatch_res.status_code == 200
    repatch_body = repatch_res.json()
    assert repatch_body["approval_state"] == "superseded"
    assert repatch_body["approved_image_url"] == "http://test.com/final.png"
    assert repatch_body["image_url"] == "http://test.com/new-draft.png"

    assert ws_manager.events[-1][1]["type"] == "character_updated"
    assert ws_manager.events[-1][1]["data"]["character"]["approval_state"] == "superseded"


@pytest.mark.asyncio
async def test_shot_update_and_approve_freezes_bound_cast_and_intent(
    async_client, test_session, ws_manager
):
    project = await create_project(test_session)
    assert project.id is not None
    hero = await create_character(test_session, project_id=project.id, name="Hero")
    villain = await create_character(test_session, project_id=project.id, name="Villain")
    shot = await create_shot(test_session, project_id=project.id, description="Draft shot")
    assert hero.id is not None
    assert villain.id is not None
    assert shot.id is not None

    update_res = await async_client.patch(
        f"/api/v1/shots/{shot.id}",
        json={
            "description": "Final confrontation",
            "prompt": "A dramatic showdown at sunset",
            "image_prompt": "Hero and villain face each other in a rooftop standoff",
            "duration": 4.5,
            "camera": "wide",
            "motion_note": "slow push-in",
            "character_ids": [hero.id, villain.id],
        },
    )
    assert update_res.status_code == 200
    update_body = update_res.json()
    assert update_body["approval_state"] == "draft"
    assert update_body["character_ids"] == [hero.id, villain.id]

    approve_res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert approve_res.status_code == 200
    approve_body = approve_res.json()
    assert approve_body["approval_state"] == "approved"
    assert approve_body["approved_description"] == "Final confrontation"
    assert approve_body["approved_duration"] == 4.5
    assert approve_body["approved_camera"] == "wide"
    assert approve_body["approved_motion_note"] == "slow push-in"
    assert approve_body["approved_character_ids"] == [hero.id, villain.id]

    repatch_res = await async_client.patch(
        f"/api/v1/shots/{shot.id}",
        json={"camera": "close-up", "character_ids": [hero.id]},
    )
    assert repatch_res.status_code == 200
    repatch_body = repatch_res.json()
    assert repatch_body["approval_state"] == "superseded"
    assert repatch_body["approved_camera"] == "wide"
    assert repatch_body["character_ids"] == [hero.id]

    assert ws_manager.events[-1][1]["type"] == "shot_updated"
    assert ws_manager.events[-1][1]["data"]["shot"]["approval_state"] == "superseded"


@pytest.mark.asyncio
async def test_shot_approval_rejects_incomplete_intent(async_client, test_session):
    project = await create_project(test_session)
    assert project.id is not None
    shot = await create_shot(test_session, project_id=project.id, description="Draft shot")
    assert shot.id is not None

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert res.status_code == 400
    assert (
        res.json()["error"]["message"]
        == "Shot approval requires structured intent, duration, camera, motion note, and bound cast"
    )


@pytest.mark.asyncio
async def test_shot_approval_rejects_stale_character_snapshot(async_client, test_session):
    project = await create_project(test_session)
    assert project.id is not None
    character = await create_character(test_session, project_id=project.id, name="Hero")
    shot = await create_shot(test_session, project_id=project.id)
    assert character.id is not None
    assert shot.id is not None

    shot.description = "Final showdown"
    shot.prompt = "A dramatic rooftop duel"
    shot.image_prompt = "Hero confronts the villain on a rooftop"
    shot.duration = 4.0
    shot.camera = "wide"
    shot.motion_note = "slow push-in"
    shot.character_ids = [character.id]
    test_session.add(shot)
    await test_session.commit()

    await test_session.delete(character)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/shots/{shot.id}/approve")
    assert res.status_code == 400
    assert res.json()["error"]["message"] == f"Unknown character_ids for project: [{character.id}]"


@pytest.mark.asyncio
async def test_websocket_payloads_report_current_review_state(
    async_client, test_session, ws_manager
):
    project = await create_project(test_session)
    assert project.id is not None
    character = await create_character(test_session, project_id=project.id, name="Lead")
    shot = await create_shot(test_session, project_id=project.id, description="Opening shot")
    assert character.id is not None
    assert shot.id is not None

    await async_client.patch(
        f"/api/v1/shots/{shot.id}",
        json={
            "prompt": "The lead enters the frame",
            "image_prompt": "Lead steps into a dramatic opening frame",
            "duration": 3.5,
            "camera": "wide",
            "motion_note": "slow dolly",
            "character_ids": [character.id],
        },
    )
    await async_client.post(f"/api/v1/characters/{character.id}/approve")
    await async_client.post(f"/api/v1/shots/{shot.id}/approve")

    assert ws_manager.events[-2][1]["data"]["character"]["approval_state"] == "approved"
    assert ws_manager.events[-2][1]["data"]["character"]["approved_at"] is not None
    assert ws_manager.events[-1][1]["data"]["shot"]["approval_state"] == "approved"
    assert ws_manager.events[-1][1]["data"]["shot"]["approved_at"] is not None
