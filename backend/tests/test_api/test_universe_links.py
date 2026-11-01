"""Universe chapters and shared characters: link, unlink, promote, sync back, delete."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.universe import SharedCharacter
from tests.factories import create_character, create_project

pytestmark = pytest.mark.asyncio


async def _universe(async_client, name="World") -> int:
    res = await async_client.post("/api/v1/universes", json={"name": name})
    assert res.status_code == 201
    return res.json()["id"]


async def test_link_and_unlink_a_chapter(async_client, test_session):
    uid = await _universe(async_client)
    project = await create_project(test_session, title="Chapter 1")

    linked = await async_client.post(
        f"/api/v1/universes/{uid}/projects",
        json={"project_id": project.id, "chapter_number": 1, "chapter_title": "Dawn"},
    )
    assert linked.status_code == 201
    assert linked.json()["project_title"] == "Chapter 1"
    assert linked.json()["chapter_title"] == "Dawn"
    await test_session.refresh(project)
    assert project.universe_id == uid

    removed = await async_client.delete(f"/api/v1/universes/{uid}/projects/{project.id}")
    again = await async_client.delete(f"/api/v1/universes/{uid}/projects/{project.id}")

    assert removed.status_code == 204
    assert again.status_code == 404
    await test_session.refresh(project)
    assert project.universe_id is None


async def test_link_404_for_unknown_universe_or_project(async_client, test_session):
    uid = await _universe(async_client)
    project = await create_project(test_session)

    assert (
        await async_client.post("/api/v1/universes/999/projects", json={"project_id": project.id})
    ).status_code == 404
    assert (
        await async_client.post(f"/api/v1/universes/{uid}/projects", json={"project_id": 999})
    ).status_code == 404


async def test_promote_then_sync_back_bumps_the_shared_version(async_client, test_session):
    uid = await _universe(async_client)
    project = await create_project(test_session)
    hero = await create_character(test_session, project_id=project.id, name="Crow", description="black coat")

    promoted = await async_client.post(f"/api/v1/universes/{uid}/shared-characters", json={"character_id": hero.id})
    assert promoted.status_code == 201
    assert (promoted.json()["name"], promoted.json()["version"]) == ("Crow", 1)

    hero.description = "white coat"
    test_session.add(hero)
    await test_session.commit()
    synced = await async_client.post(f"/api/v1/universes/characters/{hero.id}/sync-to-universe")
    repromoted = await async_client.post(
        f"/api/v1/universes/{uid}/shared-characters", json={"character_id": hero.id}
    )
    listed = await async_client.get(f"/api/v1/universes/{uid}/shared-characters")

    assert synced.status_code == 200
    assert (synced.json()["description"], synced.json()["version"]) == ("white coat", 2)
    assert repromoted.json()["id"] == promoted.json()["id"]
    assert repromoted.json()["version"] == 3
    assert [c["name"] for c in listed.json()] == ["Crow"]


async def test_sync_back_404_for_a_character_that_was_never_shared(async_client, test_session):
    project = await create_project(test_session)
    plain = await create_character(test_session, project_id=project.id)

    assert (await async_client.post(f"/api/v1/universes/characters/{plain.id}/sync-to-universe")).status_code == 404
    assert (await async_client.post("/api/v1/universes/characters/999/sync-to-universe")).status_code == 404


async def test_manual_shared_character(async_client):
    uid = await _universe(async_client)

    res = await async_client.post(
        f"/api/v1/universes/{uid}/shared-characters/manual",
        json={"name": "Moth", "visual_notes": "grey wings", "character_tags": "side"},
    )

    assert res.status_code == 201
    assert (res.json()["name"], res.json()["visual_notes"]) == ("Moth", "grey wings")
    assert (
        await async_client.post("/api/v1/universes/999/shared-characters/manual", json={"name": "X"})
    ).status_code == 404


async def test_import_shared_cast_needs_a_universe(async_client, test_session):
    project = await create_project(test_session)

    res = await async_client.post(f"/api/v1/universes/projects/{project.id}/import-shared-cast")

    assert res.status_code == 400


async def test_delete_universe_frees_its_chapters(async_client, test_session):
    uid = await _universe(async_client)
    project = await create_project(test_session)
    await async_client.post(f"/api/v1/universes/{uid}/projects", json={"project_id": project.id})
    await async_client.post(f"/api/v1/universes/{uid}/shared-characters/manual", json={"name": "Moth"})

    res = await async_client.delete(f"/api/v1/universes/{uid}")

    assert res.status_code == 204
    await test_session.refresh(project)
    assert project.universe_id is None
    shared = (await test_session.execute(select(SharedCharacter))).scalars().one()
    assert shared.is_active is False
    # A deleted universe is gone everywhere, not only from the list.
    assert (await async_client.get(f"/api/v1/universes/{uid}")).status_code == 404
    assert (await async_client.get(f"/api/v1/universes/{uid}/timeline")).status_code == 404
    assert (await async_client.put(f"/api/v1/universes/{uid}", json={"name": "Back"})).status_code == 404
    assert (await async_client.delete(f"/api/v1/universes/{uid}")).status_code == 404
    relink = await async_client.post(f"/api/v1/universes/{uid}/projects", json={"project_id": project.id})
    assert relink.status_code == 404
    assert (await async_client.get("/api/v1/universes")).json() == []
