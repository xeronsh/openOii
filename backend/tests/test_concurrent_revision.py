"""Python-side optimistic concurrency on project / character / shot (P0 #3).

The engine and FastAPI both write these tables. These tests prove the Python
side upholds its half of the contract:

1. every successful ORM write bumps `revision`;
2. a stale `expected_revision` on an HTTP edit is rejected with 409
   CONCURRENT_MODIFICATION before anything is written;
3. a writer that read a stale row loses the race at flush time with
   StaleDataError (the mapper-level CAS on revision), which the HTTP layer
   converts to 409.
"""

from __future__ import annotations

import pytest

from app.models.project import Project
from tests.factories import create_character, create_project, create_shot


@pytest.mark.asyncio
async def test_orm_write_increments_entity_revision(test_session):
    project = await create_project(test_session)
    assert project.revision == 1

    project.title = "Bumped"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)
    assert project.revision == 2

    character = await create_character(test_session, project_id=project.id)
    character.description = "Bumped"
    test_session.add(character)
    await test_session.commit()
    await test_session.refresh(character)
    assert character.revision == 2

    shot = await create_shot(test_session, project_id=project.id, order=1)
    shot.description = "Bumped"
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(shot)
    assert shot.revision == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["put", "patch"])
async def test_update_project_with_stale_revision_is_409(
    async_client, test_session, method
):
    project = await create_project(test_session, title="Fresh")

    stale_res = await getattr(async_client, method)(
        f"/api/v1/projects/{project.id}",
        json={"expected_revision": project.revision + 5, "title": "Stale"},
    )
    assert stale_res.status_code == 409
    body = stale_res.json()
    assert body["error"]["code"] == "CONCURRENT_MODIFICATION"

    # The stale write must not have landed.
    fresh_res = await async_client.get(f"/api/v1/projects/{project.id}")
    assert fresh_res.status_code == 200
    assert fresh_res.json()["title"] == "Fresh"


@pytest.mark.asyncio
async def test_update_character_with_stale_revision_is_409(async_client, test_session):
    project = await create_project(test_session)
    character = await create_character(
        test_session, project_id=project.id, name="Mika"
    )

    stale_res = await async_client.patch(
        f"/api/v1/characters/{character.id}",
        json={"expected_revision": 999, "name": "Stale Name"},
    )
    assert stale_res.status_code == 409
    assert stale_res.json()["error"]["code"] == "CONCURRENT_MODIFICATION"

    read_res = await async_client.get(f"/api/v1/projects/{project.id}/characters")
    names = [item["name"] for item in read_res.json()]
    assert names == ["Mika"]


@pytest.mark.asyncio
async def test_update_shot_with_stale_revision_is_409(async_client, test_session):
    project = await create_project(test_session)
    shot = await create_shot(test_session, project_id=project.id, order=1)

    stale_res = await async_client.patch(
        f"/api/v1/shots/{shot.id}",
        json={"expected_revision": 999, "description": "Stale"},
    )
    assert stale_res.status_code == 409
    assert stale_res.json()["error"]["code"] == "CONCURRENT_MODIFICATION"

    read_res = await async_client.get(f"/api/v1/projects/{project.id}/shots")
    assert read_res.json()[0]["description"] != "Stale"


@pytest.mark.asyncio
async def test_update_with_matching_revision_succeeds_and_bumps(
    async_client, test_session
):
    project = await create_project(test_session, title="Before")

    res = await async_client.patch(
        f"/api/v1/projects/{project.id}",
        json={"expected_revision": project.revision, "title": "After"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["title"] == "After"

    round_trip = await async_client.get(f"/api/v1/projects/{project.id}")
    assert round_trip.status_code == 200
    assert round_trip.json()["revision"] == data["revision"] == 2


@pytest.mark.asyncio
async def test_concurrent_session_stale_write_raises_stale_data_error(
    test_session, shared_session_maker
):
    """Two writers, one row: the session that read rev 1 loses after rev 2 lands."""
    from sqlalchemy.ext.asyncio import AsyncSession as _AsyncSession
    from sqlalchemy.ext.asyncio import async_sessionmaker as _maker

    maker: _maker[_AsyncSession] = shared_session_maker

    # The loser loads the row first (revision 1)...then the winner writes.
    async with maker() as loser:
        victim = await loser.get(Project, (await create_project(test_session)).id)
        assert victim is not None
        assert victim.revision == 1

        winner = await test_session.get(Project, victim.id)
        assert winner is not None
        winner.title = "First writer"
        test_session.add(winner)
        await test_session.commit()
        await test_session.refresh(winner)
        assert winner.revision == 2

        # ...and now flushes its edit against the stale revision.
        victim.title = "Second writer"
        with pytest.raises(Exception) as excinfo:
            await loser.commit()
        assert "StaleDataError" in type(excinfo.value).__name__ or (
            "stale" in str(excinfo.value).lower()
        )
