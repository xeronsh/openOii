"""Version history routes: list, read, compare and roll back shots and characters."""

from __future__ import annotations

import pytest

from app.services.version_service import VersionService, character_snapshot, shot_snapshot
from tests.factories import create_character, create_project, create_shot

versions = VersionService()


async def _snapshot_shot(session, shot):
    version = await versions.create_version(session, "shot", shot.id, shot_snapshot(shot))
    await session.commit()
    return version


def _events(ws_manager, kind):
    return [event["data"] for _, event in ws_manager.events if event["type"] == kind]


@pytest.mark.asyncio
async def test_list_versions_newest_first_and_scoped_to_the_project(async_client, test_session):
    project = await create_project(test_session)
    other = await create_project(test_session, title="Other")
    shot = await create_shot(test_session, project_id=project.id, description="v1")
    await _snapshot_shot(test_session, shot)
    shot.description = "v2"
    await _snapshot_shot(test_session, shot)

    res = await async_client.get(
        f"/api/v1/projects/{project.id}/versions", params={"entity_type": "shot", "entity_id": shot.id}
    )
    elsewhere = await async_client.get(
        f"/api/v1/projects/{other.id}/versions", params={"entity_type": "shot", "entity_id": shot.id}
    )

    assert res.status_code == 200
    assert [v["version"] for v in res.json()["versions"]] == [2, 1]
    assert [v["snapshot"]["description"] for v in res.json()["versions"]] == ["v2", "v1"]
    assert elsewhere.json()["versions"] == []


@pytest.mark.asyncio
async def test_get_version_and_404(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id)
    version = await _snapshot_shot(test_session, shot)

    res = await async_client.get(f"/api/v1/versions/{version.id}")

    assert res.status_code == 200
    assert res.json()["entity_id"] == shot.id
    assert (await async_client.get("/api/v1/versions/99999")).status_code == 404


@pytest.mark.asyncio
async def test_compare_lists_only_changed_fields(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, description="before")
    await _snapshot_shot(test_session, shot)
    shot.description = "after"
    shot.camera = "close-up"
    await _snapshot_shot(test_session, shot)

    res = await async_client.get(
        f"/api/v1/projects/{project.id}/versions/compare",
        params={"entity_type": "shot", "entity_id": shot.id, "v1": 1, "v2": 2},
    )

    assert res.status_code == 200
    diffs = {d["field_name"]: (d["old_value"], d["new_value"]) for d in res.json()["diffs"]}
    assert diffs == {"description": ("before", "after"), "camera": (None, "close-up")}


@pytest.mark.asyncio
async def test_compare_404_for_a_missing_version_or_another_project(async_client, test_session):
    project = await create_project(test_session)
    other = await create_project(test_session, title="Other")
    shot = await create_shot(test_session, project_id=project.id)
    await _snapshot_shot(test_session, shot)
    params = {"entity_type": "shot", "entity_id": shot.id, "v1": 1, "v2": 2}

    missing = await async_client.get(f"/api/v1/projects/{project.id}/versions/compare", params=params)
    foreign = await async_client.get(
        f"/api/v1/projects/{other.id}/versions/compare", params={**params, "v2": 1}
    )

    assert missing.status_code == 404
    assert foreign.status_code == 404


@pytest.mark.asyncio
async def test_rollback_shot_restores_fields_and_marks_the_cut_stale(async_client, test_session, ws_manager):
    project = await create_project(test_session, status="ready")
    shot = await create_shot(test_session, project_id=project.id, description="good take")
    await _snapshot_shot(test_session, shot)
    shot.description = "bad take"
    test_session.add(shot)
    await _snapshot_shot(test_session, shot)

    res = await async_client.post(
        "/api/v1/versions/rollback", json={"entity_type": "shot", "entity_id": shot.id, "target_version": 1}
    )

    assert res.status_code == 200
    body = res.json()
    assert body["message"] == "已回滚到版本 1"
    assert body["new_version"]["version"] == 3
    assert body["new_version"]["trigger"] == "rollback"
    await test_session.refresh(shot)
    await test_session.refresh(project)
    assert shot.description == "good take"
    assert project.status == "superseded"
    assert _events(ws_manager, "shot_updated")[0]["shot"]["description"] == "good take"
    assert _events(ws_manager, "project_updated")[0]["project"]["status"] == "superseded"
    assert _events(ws_manager, "version_rollback") == [
        {"entity_type": "shot", "entity_id": shot.id, "from_version": 2, "to_version": 1}
    ]
    assert _events(ws_manager, "version_created")[-1]["version"] == 3


@pytest.mark.asyncio
async def test_rollback_character_clears_the_shots_that_used_it(async_client, test_session, ws_manager):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Crow", description="black")
    await versions.create_version(test_session, "character", character.id, character_snapshot(character))
    character.description = "white"
    test_session.add(character)
    await test_session.commit()
    with_crow = await create_shot(test_session, project_id=project.id, order=1)
    with_crow.character_ids = [character.id]
    test_session.add(with_crow)
    without = await create_shot(test_session, project_id=project.id, order=2)
    await test_session.commit()

    res = await async_client.post(
        "/api/v1/versions/rollback",
        json={"entity_type": "character", "entity_id": character.id, "target_version": 1},
    )

    assert res.status_code == 200
    await test_session.refresh(character)
    await test_session.refresh(with_crow)
    await test_session.refresh(without)
    assert character.description == "black"
    assert (with_crow.image_url, with_crow.video_url) == (None, None)
    assert without.image_url == "http://test.com/shot.png"
    assert [e["shot"]["id"] for e in _events(ws_manager, "shot_updated")] == [with_crow.id]
    created = _events(ws_manager, "version_created")
    assert {"entity_type": "shot", "entity_id": with_crow.id, "version": 1, "trigger": "rollback"} in created
    assert _events(ws_manager, "character_updated")[0]["character"]["description"] == "black"


@pytest.mark.asyncio
async def test_rollback_to_an_unknown_version_is_404(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id)

    res = await async_client.post(
        "/api/v1/versions/rollback", json={"entity_type": "shot", "entity_id": shot.id, "target_version": 4}
    )

    assert res.status_code == 404
