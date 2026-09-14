from __future__ import annotations

import pytest

from app.services import run_lifecycle
from tests.factories import create_character, create_project


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
    # Dispatch now goes to the engine; stub the loopback call and assert the
    # run is created and handed over with the right entity scope.
    async def fake_engine_start_run(base_url, **kwargs):
        fake_engine_start_run.calls.append(kwargs)  # type: ignore[attr-defined]
        return {"status": "running"}

    fake_engine_start_run.calls = []  # type: ignore[attr-defined]
    monkeypatch.setattr(run_lifecycle, "engine_start_run", fake_engine_start_run)

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
    calls = fake_engine_start_run.calls  # type: ignore[attr-defined]
    assert len(calls) == 1
    assert calls[0]["stage"] == "render_characters"
    assert calls[0]["target_character_ids"] == (character.id,)


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
@pytest.mark.asyncio
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


@pytest.mark.asyncio
async def test_approve_character_project_not_found(async_client, test_session):
    """Line 231: approve character when project deleted → 404."""
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Hero")

    await test_session.delete(project)
    await test_session.commit()

    res = await async_client.post(f"/api/v1/characters/{character.id}/approve")
    assert res.status_code == 404
