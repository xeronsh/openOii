"""Character bible: face embeddings and same-project look-alike search."""

from __future__ import annotations

import json

import httpx
import pytest

from app.services import character_bible as bible
from tests.factories import create_character, create_project


class _Vec:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return list(self.values)


@pytest.fixture
def faces(monkeypatch):
    state = {"available": True, "faces": []}
    monkeypatch.setattr(bible, "is_face_cropping_available", lambda: state["available"])
    monkeypatch.setattr(bible, "detect_faces", lambda data: state["faces"])
    return state


def test_embedding_from_bytes_picks_the_best_face(faces):
    faces["faces"] = [
        {"det_score": 0.4, "embedding": [0.0, 1.0]},
        {"det_score": 0.9, "embedding": _Vec([1.0, 0.0])},
    ]
    assert bible.compute_face_embedding_from_bytes(b"img") == [1.0, 0.0]
    faces["faces"] = [{"det_score": 0.5, "embedding": [0.5, 0.5]}]
    assert bible.compute_face_embedding_from_bytes(b"img") == [0.5, 0.5]
    faces["faces"] = []
    assert bible.compute_face_embedding_from_bytes(b"img") is None
    faces["available"] = False
    assert bible.compute_face_embedding_from_bytes(b"img") is None


async def test_embedding_from_url_downloads_then_extracts(faces, monkeypatch):
    real_client = httpx.AsyncClient
    status = {"code": 200}

    def handler(request):
        return httpx.Response(status["code"], content=b"jpeg")

    monkeypatch.setattr(
        bible.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )
    faces["faces"] = [{"det_score": 1.0, "embedding": [0.1, 0.2]}]
    assert await bible.compute_face_embedding("https://cdn.example/c.png") == [0.1, 0.2]
    status["code"] = 404
    assert await bible.compute_face_embedding("https://cdn.example/c.png") is None
    faces["available"] = False
    assert await bible.compute_face_embedding("https://cdn.example/c.png") is None


def test_cosine_similarity():
    assert bible._cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert bible._cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert bible._cosine_similarity([0.0, 0.0], [1.0, 1.0]) == 0.0


async def test_find_similar_characters_ranks_and_skips_bad_rows(test_session):
    project = await create_project(test_session)
    other = await create_project(test_session)
    me = await create_character(test_session, project.id, name="me")
    twin = await create_character(test_session, project.id, name="twin")
    close = await create_character(test_session, project.id, name="close")
    far = await create_character(test_session, project.id, name="far")
    broken = await create_character(test_session, project.id, name="broken")
    short = await create_character(test_session, project.id, name="short")
    elsewhere = await create_character(test_session, other.id, name="elsewhere")
    await create_character(test_session, project.id, name="no-embedding")
    blank = await create_character(test_session, project.id, name="blank")
    rows = [
        (me, [1.0, 0.0, 0.0]),
        (twin, [1.0, 0.0, 0.0]),
        (close, [0.9, 0.1, 0.0]),
        (far, [0.0, 1.0, 0.0]),
        (short, [1.0, 0.0]),
        (elsewhere, [1.0, 0.0, 0.0]),
    ]
    for char, vec in rows:
        char.face_embedding = json.dumps(vec)
    broken.face_embedding = "{not json"
    blank.face_embedding = ""
    await test_session.commit()

    found = await bible.find_similar_characters([1.0, 0.0, 0.0], project.id, test_session, exclude_id=me.id)
    assert [c.name for c, _ in found] == ["twin", "close"]
    assert found[0][1] >= found[1][1]

    everyone = await bible.find_similar_characters([1.0, 0.0, 0.0], project.id, test_session, threshold=0.0)
    assert {c.name for c, _ in everyone} == {"me", "twin", "close", "far"}
