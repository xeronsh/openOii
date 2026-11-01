"""Character bible routes: notes, reference images and face embeddings."""

from __future__ import annotations

import json

import pytest

from app.api.v1.routes import characters as routes
from tests.factories import create_character, create_project


def _bible_events(ws_manager):
    return [event["data"] for _, event in ws_manager.events if event["type"] == "bible_updated"]


@pytest.mark.asyncio
async def test_bible_without_embedding_has_no_similarity(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, name="Crow")

    res = await async_client.get(f"/api/v1/characters/{character.id}/bible")

    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Crow"
    assert body["has_embedding"] is False
    assert body["reference_images"] == []
    assert body["similarity_scores"] == []


@pytest.mark.asyncio
async def test_bible_lists_similar_characters_rounded(async_client, test_session, monkeypatch):
    project = await create_project(test_session)
    crow = await create_character(test_session, project_id=project.id, name="Crow")
    twin = await create_character(test_session, project_id=project.id, name="Twin")
    crow.face_embedding = json.dumps([0.1, 0.2])
    test_session.add(crow)
    await test_session.commit()
    seen = {}

    async def fake_similar(embedding, project_id, session, exclude_id=None):
        seen.update(embedding=embedding, project_id=project_id, exclude_id=exclude_id)
        return [(twin, 0.91234)]

    monkeypatch.setattr(routes, "find_similar_characters", fake_similar)

    body = (await async_client.get(f"/api/v1/characters/{crow.id}/bible")).json()

    assert seen == {"embedding": [0.1, 0.2], "project_id": project.id, "exclude_id": crow.id}
    assert body["has_embedding"] is True
    assert body["similarity_scores"] == [{"character_id": twin.id, "name": "Twin", "similarity": 0.912}]


@pytest.mark.asyncio
async def test_bible_ignores_a_corrupt_embedding(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)
    character.face_embedding = "not json"
    test_session.add(character)
    await test_session.commit()

    res = await async_client.get(f"/api/v1/characters/{character.id}/bible")

    assert res.status_code == 200
    assert res.json()["similarity_scores"] == []


@pytest.mark.asyncio
async def test_bible_of_unknown_character_is_404(async_client):
    assert (await async_client.get("/api/v1/characters/99999/bible")).status_code == 404


@pytest.mark.asyncio
async def test_update_bible_saves_notes_and_images(async_client, test_session, ws_manager):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)

    res = await async_client.put(
        f"/api/v1/characters/{character.id}/bible",
        json={"visual_notes": "red scarf", "reference_images": ["/static/a.png"]},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["visual_notes"] == "red scarf"
    assert body["reference_images"] == ["/static/a.png"]
    assert _bible_events(ws_manager) == [
        {"character_id": character.id, "visual_notes": True, "reference_images_count": 1, "has_embedding": False}
    ]


@pytest.mark.asyncio
async def test_update_bible_images_only_does_not_flag_notes(async_client, test_session, ws_manager):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)

    res = await async_client.put(
        f"/api/v1/characters/{character.id}/bible", json={"reference_images": ["/static/a.png", "/static/b.png"]}
    )

    assert res.status_code == 200
    assert res.json()["visual_notes"] is None
    assert _bible_events(ws_manager)[0]["visual_notes"] is False


@pytest.mark.asyncio
async def test_update_bible_rejects_a_stale_revision(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)

    res = await async_client.put(
        f"/api/v1/characters/{character.id}/bible",
        json={"visual_notes": "late edit", "expected_revision": character.revision + 5},
    )

    assert res.status_code == 409
    await test_session.refresh(character)
    assert character.visual_notes is None


@pytest.mark.asyncio
async def test_reference_images_append_and_delete(async_client, test_session, ws_manager):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)
    url = f"/api/v1/characters/{character.id}/reference-images"

    await async_client.post(url, json={"image_url": "/static/a.png"})
    added = await async_client.post(url, json={"image_url": "/static/b.png"})
    assert added.json()["reference_images"] == ["/static/a.png", "/static/b.png"]

    deleted = await async_client.delete(f"{url}/0")
    assert deleted.status_code == 204
    bible = (await async_client.get(f"/api/v1/characters/{character.id}/bible")).json()
    assert bible["reference_images"] == ["/static/b.png"]
    assert [event["reference_images_count"] for event in _bible_events(ws_manager)] == [1, 2, 1]


@pytest.mark.asyncio
@pytest.mark.parametrize("index", [1, -1])
async def test_reference_image_delete_rejects_a_bad_index(async_client, test_session, index):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)
    character.reference_images = ["/static/a.png"]
    test_session.add(character)
    await test_session.commit()

    res = await async_client.delete(f"/api/v1/characters/{character.id}/reference-images/{index}")

    assert res.status_code == 400
    await test_session.refresh(character)
    assert character.reference_images == ["/static/a.png"]


@pytest.mark.asyncio
async def test_compute_embedding_stores_the_vector(async_client, test_session, monkeypatch, ws_manager):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, image_url="/static/crow.png")
    asked = []

    async def fake_embedding(image_url):
        asked.append(image_url)
        return [0.5, 0.25]

    monkeypatch.setattr(routes, "compute_face_embedding", fake_embedding)

    res = await async_client.post(f"/api/v1/characters/{character.id}/compute-embedding")

    assert res.status_code == 200
    assert asked == ["/static/crow.png"]
    await test_session.refresh(character)
    assert json.loads(character.face_embedding) == [0.5, 0.25]
    assert _bible_events(ws_manager)[-1]["has_embedding"] is True


@pytest.mark.asyncio
async def test_compute_embedding_falls_back_to_the_first_reference(async_client, test_session, monkeypatch):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, image_url=None)
    character.reference_images = ["/static/ref.png", "/static/ref2.png"]
    test_session.add(character)
    await test_session.commit()
    asked = []

    async def fake_embedding(image_url):
        asked.append(image_url)
        return [1.0]

    monkeypatch.setattr(routes, "compute_face_embedding", fake_embedding)

    assert (await async_client.post(f"/api/v1/characters/{character.id}/compute-embedding")).status_code == 200
    assert asked == ["/static/ref.png"]


@pytest.mark.asyncio
async def test_compute_embedding_needs_an_image(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id, image_url=None)

    res = await async_client.post(f"/api/v1/characters/{character.id}/compute-embedding")

    assert res.status_code == 400


@pytest.mark.asyncio
async def test_compute_embedding_reports_no_face(async_client, test_session, monkeypatch):
    project = await create_project(test_session)
    character = await create_character(test_session, project_id=project.id)

    async def no_face(image_url):
        return None

    monkeypatch.setattr(routes, "compute_face_embedding", no_face)

    res = await async_client.post(f"/api/v1/characters/{character.id}/compute-embedding")

    assert res.status_code == 422
    await test_session.refresh(character)
    assert character.face_embedding is None
