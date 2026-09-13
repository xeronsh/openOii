from __future__ import annotations

import pytest

from app.models.universe import SharedCharacter, Universe

pytestmark = pytest.mark.asyncio


async def test_create_universe_round_trips_cover_image_url(async_client):
    res = await async_client.post(
        "/api/v1/universes",
        json={
            "name": "Cover World",
            "description": "with cover",
            "world_setting": "shared world",
            "style_rules": "bright panels",
            "cover_image_url": "/static/images/cover.png",
        },
    )

    assert res.status_code == 201
    data = res.json()
    assert data["cover_image_url"] == "/static/images/cover.png"

    list_res = await async_client.get("/api/v1/universes")
    assert list_res.status_code == 200
    assert list_res.json()[0]["cover_image_url"] == "/static/images/cover.png"


async def test_update_universe_can_clear_nullable_fields(async_client, test_session):
    universe = Universe(
        name="Clearable",
        description="old description",
        world_setting="old world",
        style_rules="old style",
        cover_image_url="/static/images/old.png",
    )
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    res = await async_client.put(
        f"/api/v1/universes/{universe.id}",
        json={
            "description": None,
            "world_setting": None,
            "style_rules": None,
            "cover_image_url": None,
        },
    )

    assert res.status_code == 200
    data = res.json()
    assert data["description"] is None
    assert data["world_setting"] is None
    assert data["style_rules"] is None
    assert data["cover_image_url"] is None


async def test_import_shared_cast_into_project(async_client, test_session):
    from app.models.project import Project, Character
    from app.models.universe import Universe, SharedCharacter, UniverseProjectLink

    universe = Universe(name="Cast World")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    project = Project(
        title="第1章",
        story="s",
        style="anime",
        status="draft",
        universe_id=universe.id,
    )
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)
    test_session.add(
        UniverseProjectLink(universe_id=universe.id, project_id=project.id, chapter_number=1)
    )
    test_session.add(
        SharedCharacter(universe_id=universe.id, name="艾拉", description="勘探员")
    )
    test_session.add(
        SharedCharacter(universe_id=universe.id, name="意识体", description="遗迹")
    )
    # Existing same-name should be skipped
    test_session.add(Character(project_id=project.id, name="艾拉", description="已有"))
    await test_session.commit()

    res = await async_client.post(
        f"/api/v1/universes/projects/{project.id}/import-shared-cast"
    )
    assert res.status_code == 200
    data = res.json()
    assert data["imported_count"] == 1
    assert data["skipped_existing"] == 1
    assert data["imported"][0]["name"] == "意识体"


async def test_universe_timeline_lists_chapters_with_counts(async_client, test_session):
    from app.models.project import Project, Character, Shot
    from app.models.universe import Universe, UniverseProjectLink

    universe = Universe(name="Timeline World", world_setting="深海文明")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    p1 = Project(title="第一章", story="s1", style="anime", summary="开端", status="ready")
    p2 = Project(title="第二章", story="s2", style="anime", summary="发展", status="draft")
    test_session.add(p1)
    test_session.add(p2)
    await test_session.commit()
    await test_session.refresh(p1)
    await test_session.refresh(p2)

    test_session.add(
        UniverseProjectLink(
            universe_id=universe.id,
            project_id=p1.id,
            chapter_number=1,
            chapter_title="启程",
        )
    )
    test_session.add(
        UniverseProjectLink(
            universe_id=universe.id,
            project_id=p2.id,
            chapter_number=2,
            chapter_title="觉醒",
        )
    )
    test_session.add(Character(project_id=p1.id, name="艾拉", description="勘探员"))
    test_session.add(Shot(project_id=p1.id, order=1, description="海沟", prompt="p", image_prompt="i"))
    await test_session.commit()

    res = await async_client.get(
        f"/api/v1/universes/{universe.id}/timeline?current_project_id={p2.id}"
    )
    assert res.status_code == 200
    data = res.json()
    assert data["universe_name"] == "Timeline World"
    assert len(data["chapters"]) == 2
    current = next(c for c in data["chapters"] if c["project_id"] == p2.id)
    assert current["is_current"] is True
    ch1 = next(c for c in data["chapters"] if c["project_id"] == p1.id)
    assert ch1["character_count"] == 1
    assert ch1["shot_count"] == 1


async def test_shared_character_response_preserves_has_embedding(async_client, test_session):
    universe = Universe(name="Embedding World")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    shared_character = SharedCharacter(
        universe_id=universe.id,
        name="Embedded Character",
        face_embedding="[0.1, 0.2, 0.3]",
    )
    test_session.add(shared_character)
    await test_session.commit()

    list_res = await async_client.get(f"/api/v1/universes/{universe.id}/shared-characters")
    assert list_res.status_code == 200
    assert list_res.json()[0]["has_embedding"] is True

    detail_res = await async_client.get(f"/api/v1/universes/{universe.id}")
    assert detail_res.status_code == 200
    assert detail_res.json()["shared_characters"][0]["has_embedding"] is True


async def test_import_character_into_same_universe_project(async_client, test_session):
    from app.models.project import Project

    universe = Universe(name="Import World")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    project = Project(
        title="第1章",
        story="s",
        style="anime",
        status="draft",
        universe_id=universe.id,
    )
    shared = SharedCharacter(universe_id=universe.id, name="艾拉", description="勘探员")
    test_session.add(project)
    test_session.add(shared)
    await test_session.commit()
    await test_session.refresh(project)
    await test_session.refresh(shared)

    res = await async_client.post(
        f"/api/v1/universes/projects/{project.id}/import-character/{shared.id}"
    )
    assert res.status_code == 201
    data = res.json()
    assert data["name"] == "艾拉"
    assert data["project_id"] == project.id


async def test_import_character_rejects_cross_universe_project(async_client, test_session):
    from app.models.project import Project, Character
    from sqlalchemy import select

    universe_a = Universe(name="Universe A")
    universe_b = Universe(name="Universe B")
    test_session.add(universe_a)
    test_session.add(universe_b)
    await test_session.commit()
    await test_session.refresh(universe_a)
    await test_session.refresh(universe_b)

    # 目标项目属于 B 宇宙（或不属于任何宇宙），共享角色属于 A 宇宙
    project_other = Project(
        title="别人的项目",
        story="s",
        style="anime",
        status="draft",
        universe_id=universe_b.id,
    )
    project_orphan = Project(title="无宇宙项目", story="s", style="anime", status="draft")
    shared = SharedCharacter(universe_id=universe_a.id, name="艾拉", description="勘探员")
    test_session.add(project_other)
    test_session.add(project_orphan)
    test_session.add(shared)
    await test_session.commit()
    await test_session.refresh(project_other)
    await test_session.refresh(project_orphan)
    await test_session.refresh(shared)

    for pid in (project_other.id, project_orphan.id):
        res = await async_client.post(
            f"/api/v1/universes/projects/{pid}/import-character/{shared.id}"
        )
        assert res.status_code == 400
        assert "universe" in res.json()["error"]["message"].lower()

    # 跨宇宙导入被拒后，目标项目不应出现该角色
    chars = await test_session.execute(
        select(Character).where(Character.project_id == project_other.id)
    )
    assert chars.scalars().all() == []


async def test_import_character_missing_shared_character_returns_404(
    async_client, test_session
):
    from app.models.project import Project

    universe = Universe(name="Missing Char World")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    project = Project(
        title="第1章",
        story="s",
        style="anime",
        status="draft",
        universe_id=universe.id,
    )
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    res = await async_client.post(
        f"/api/v1/universes/projects/{project.id}/import-character/99999"
    )
    assert res.status_code == 404
