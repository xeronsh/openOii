from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api.deps import get_app_settings, get_db_session, get_ws_manager
from app.api.v1.routes import projects as project_routes
from app.main import create_app
from app.models.project import Project
from app.models.universe import Universe, UniverseProjectLink
from app.schemas.project import ProjectProviderEntry, ProviderResolution
from app.services.provider_resolution import resolve_project_provider_settings
from tests.factories import create_message, create_project, create_run


@pytest.fixture(autouse=True)
def _stub_async_provider_resolution(monkeypatch):
    async def _fake(project, settings, **kwargs):
        return resolve_project_provider_settings(project, settings)

    monkeypatch.setattr(project_routes, "resolve_project_provider_settings_async", _fake)


@pytest.mark.asyncio
async def test_list_projects_empty(async_client):
    res = await async_client.get("/api/v1/projects")
    assert res.status_code == 200
    data = res.json()
    assert data["items"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_list_projects_with_data(async_client, test_session):
    await create_project(test_session, title="Project 1")
    await create_project(test_session, title="Project 2")

    res = await async_client.get("/api/v1/projects")
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 2
    assert data["total"] == 2


@pytest.mark.asyncio
async def test_create_project_persists_bootstrap_payload(async_client, test_session, test_settings):
    test_settings.text_api_key = "text-key"
    test_settings.image_api_key = "image-key"
    test_settings.video_provider = "openai"
    payload = {
        "title": "New Project",
        "story": "Once upon a time",
        "style": "cinematic",
        "target_shot_count": 8,
        "character_hints": ["主角", "反派"],
        "creation_mode": "quick",
        "reference_images": ["/static/references/ref.png"],
        "exports": ["pdf", "webtoon"],
        "text_provider_override": "openai",
        "image_provider_override": "openai",
        "video_provider_override": "doubao",
    }

    res = await async_client.post("/api/v1/projects", json=payload)
    assert res.status_code == 201
    data = res.json()
    assert data["title"] == "New Project"
    assert data["story"] == "Once upon a time"
    assert data["style"] == "cinematic"
    assert data["status"] == "draft"
    assert data["target_shot_count"] == 8
    assert data["character_hints"] == ["主角", "反派"]
    assert data["creation_mode"] == "quick"
    assert data["reference_images"] == ["/static/references/ref.png"]
    assert data["exports"] == ["pdf", "webtoon"]
    assert data["provider_settings"]["text"]["selected_key"] == "openai"
    assert data["provider_settings"]["text"]["source"] == "project"
    assert data["provider_settings"]["image"]["resolved_key"] == "openai"
    assert data["provider_settings"]["video"]["selected_key"] == "doubao"
    assert data["provider_settings"]["video"]["valid"] is False
    assert data["provider_settings"]["video"]["reason_code"] == "provider_missing_credentials"
    assert isinstance(data["id"], int)

    project = await test_session.get(Project, data["id"])
    assert project is not None
    assert project.story == payload["story"]
    assert project.style == payload["style"]
    assert project.status == "draft"
    assert project.target_shot_count == 8
    assert project.character_hints == ["主角", "反派"]
    assert project.creation_mode == "quick"
    assert project.reference_images == ["/static/references/ref.png"]
    assert project.exports == ["pdf", "webtoon"]
    assert project.text_provider_override == "openai"
    assert project.image_provider_override == "openai"
    assert project.video_provider_override == "doubao"


@pytest.mark.asyncio
async def test_get_project(async_client, test_session, test_settings):
    test_settings.text_provider = "openai"
    test_settings.text_api_key = "text-key"
    test_settings.video_provider = "openai"
    project = await create_project(
        test_session,
        title="Get Test",
        text_provider_override="openai",
        image_provider_override="openai",
    )
    res = await async_client.get(f"/api/v1/projects/{project.id}")
    assert res.status_code == 200
    data = res.json()
    assert data["id"] == project.id
    assert data["title"] == "Get Test"
    assert data["provider_settings"]["text"] == {
        "selected_key": "openai",
        "source": "project",
        "resolved_key": "openai",
        "valid": True,
        "status": "valid",
        "reason_code": None,
        "reason_message": None,
        "capabilities": {"generate": True, "stream": True},
    }
    assert data["provider_settings"]["image"]["selected_key"] == "openai"
    assert data["provider_settings"]["image"]["resolved_key"] == "openai"
    assert data["provider_settings"]["image"]["valid"] is True
    assert data["provider_settings"]["video"]["selected_key"] == "openai"
    assert data["provider_settings"]["video"]["source"] == "default"
    assert data["provider_settings"]["video"]["resolved_key"] == "openai"
    assert data["provider_settings"]["video"]["reason_message"] is None


@pytest.mark.asyncio
async def test_get_project_provider_settings_follow_runtime_defaults(
    async_client,
    test_session,
    test_settings,
):
    test_settings.text_provider = "openai"
    test_settings.text_api_key = "text-key"
    test_settings.video_provider = "doubao"
    project = await create_project(test_session, title="Runtime Default")

    res = await async_client.get(f"/api/v1/projects/{project.id}")

    assert res.status_code == 200
    data = res.json()
    assert data["provider_settings"]["text"]["selected_key"] == "openai"
    assert data["provider_settings"]["text"]["resolved_key"] == "openai"
    assert data["provider_settings"]["video"]["selected_key"] == "doubao"
    assert data["provider_settings"]["video"]["valid"] is False


@pytest.mark.asyncio
async def test_get_project_exposes_degraded_text_provider(async_client, test_session, monkeypatch):
    async def _fake(_project, _settings, **kwargs):
        return ProviderResolution(
            valid=True,
            text=ProjectProviderEntry(
                selected_key="openai",
                source="default",
                resolved_key="openai",
                valid=True,
                status="degraded",
                reason_code="provider_stream_unavailable",
                reason_message="文本 Provider 流式不可用，已自动回退非流式生成。",
                capabilities=ProjectProviderEntry.Capabilities(generate=True, stream=False),
            ),
            image=ProjectProviderEntry(
                selected_key="openai",
                source="default",
                resolved_key="openai",
                valid=True,
                status="valid",
                reason_code=None,
                reason_message=None,
                capabilities=ProjectProviderEntry.Capabilities(generate=True, stream=None),
            ),
            video=ProjectProviderEntry(
                selected_key="openai",
                source="default",
                resolved_key="openai",
                valid=True,
                status="valid",
                reason_code=None,
                reason_message=None,
                capabilities=ProjectProviderEntry.Capabilities(generate=True, stream=None),
            ),
        )

    monkeypatch.setattr(project_routes, "resolve_project_provider_settings_async", _fake)
    project = await create_project(test_session, title="Degraded Provider")

    res = await async_client.get(f"/api/v1/projects/{project.id}")

    assert res.status_code == 200
    data = res.json()
    assert data["provider_settings"]["text"]["valid"] is True
    assert data["provider_settings"]["text"]["status"] == "degraded"
    assert data["provider_settings"]["text"]["capabilities"] == {
        "generate": True,
        "stream": False,
    }


@pytest.mark.asyncio
async def test_get_project_provider_settings_follow_runtime_resolution_payload(
    async_client, test_session, monkeypatch
):
    async def _fake(_project, _settings, **kwargs):
        return ProviderResolution(
            valid=False,
            text=ProjectProviderEntry(
                selected_key="anthropic",
                source="default",
                resolved_key=None,
                valid=False,
                status="invalid",
                reason_code="provider_missing_credentials",
                reason_message="缺少 Anthropic 文本凭据",
            ),
            image=ProjectProviderEntry(
                selected_key="openai",
                source="project",
                resolved_key="openai",
                valid=True,
                status="valid",
                reason_code=None,
                reason_message=None,
            ),
            video=ProjectProviderEntry(
                selected_key="doubao",
                source="default",
                resolved_key="doubao",
                valid=True,
                status="valid",
                reason_code=None,
                reason_message=None,
            ),
        )

    monkeypatch.setattr(project_routes, "resolve_project_provider_settings_async", _fake)
    project = await create_project(
        test_session,
        title="Runtime Resolution",
        text_provider_override="openai",
        video_provider_override="openai",
    )

    res = await async_client.get(f"/api/v1/projects/{project.id}")

    assert res.status_code == 200
    data = res.json()
    assert data["provider_settings"]["text"] == {
        "selected_key": "anthropic",
        "source": "default",
        "resolved_key": None,
        "valid": False,
        "status": "invalid",
        "reason_code": "provider_missing_credentials",
        "reason_message": "缺少 Anthropic 文本凭据",
        "capabilities": None,
    }
    assert data["provider_settings"]["image"]["source"] == "project"
    assert data["provider_settings"]["video"]["selected_key"] == "doubao"


@pytest.mark.asyncio
async def test_get_project_not_found(async_client):
    res = await async_client.get("/api/v1/projects/99999")
    assert res.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["put", "patch"])
async def test_update_project(async_client, test_session, test_settings, method):
    test_settings.text_api_key = "text-key"
    test_settings.video_provider = "openai"
    project = await create_project(test_session, title="Old Title")
    res = await getattr(async_client, method)(
        f"/api/v1/projects/{project.id}",
        json={
            "title": "New Title",
            "style": "noir",
            "text_provider_override": "openai",
            "video_provider_override": None,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["title"] == "New Title"
    assert data["style"] == "noir"
    assert data["provider_settings"]["text"]["selected_key"] == "openai"
    assert data["provider_settings"]["text"]["resolved_key"] == "openai"
    assert data["provider_settings"]["image"]["selected_key"] == "openai"
    assert data["provider_settings"]["video"]["selected_key"] == "openai"

    round_trip = await async_client.get(f"/api/v1/projects/{project.id}")
    assert round_trip.status_code == 200
    assert round_trip.json()["provider_settings"] == data["provider_settings"]


@pytest.mark.asyncio
async def test_create_project_accepts_fake_video_provider(async_client):
    # _stub_async_provider_resolution is autouse=True, no need to call directly

    res = await async_client.post(
        "/api/v1/projects",
        json={
            "title": "Fake Video Project",
            "video_provider_override": "fake",
        },
    )

    assert res.status_code == 201
    data = res.json()
    assert data["provider_settings"]["video"]["selected_key"] == "fake"
    assert data["provider_settings"]["video"]["valid"] is True


@pytest.mark.asyncio
async def test_create_project_accepts_modelscope_image_provider(async_client, test_session):
    res = await async_client.post(
        "/api/v1/projects",
        json={
            "title": "ModelScope Image Project",
            "image_provider_override": "modelscope",
        },
    )

    assert res.status_code == 201
    data = res.json()
    assert data["provider_settings"]["image"]["selected_key"] == "modelscope"
    assert data["provider_settings"]["image"]["resolved_key"] == "modelscope"
    assert data["provider_settings"]["image"]["valid"] is True

    project = await test_session.get(Project, data["id"])
    assert project is not None
    assert project.image_provider_override == "modelscope"


@pytest.mark.asyncio
async def test_create_project_rejects_unknown_provider_keys(async_client):
    res = await async_client.post(
        "/api/v1/projects",
        json={
            "title": "Bad Project",
            "text_provider_override": "claude",
        },
    )

    assert res.status_code == 422


@pytest.mark.asyncio
async def test_create_project_rejects_unknown_universe_id(async_client):
    res = await async_client.post(
        "/api/v1/projects",
        json={
            "title": "Bad Universe Project",
            "universe_id": 99999,
        },
    )

    assert res.status_code == 404
    assert res.json()["error"]["message"] == "Universe not found"


@pytest.mark.asyncio
async def test_create_project_links_existing_universe(async_client, test_session):
    universe = Universe(name="Linked World")
    test_session.add(universe)
    await test_session.commit()
    await test_session.refresh(universe)

    res = await async_client.post(
        "/api/v1/projects",
        json={
            "title": "Chapter Project",
            "universe_id": universe.id,
            "chapter_number": 2,
            "chapter_title": "归来",
        },
    )

    assert res.status_code == 201
    data = res.json()
    assert data["universe_id"] == universe.id
    assert data["chapter_number"] == 2
    assert data["chapter_title"] == "归来"

    links = (
        await test_session.execute(
            select(UniverseProjectLink).where(UniverseProjectLink.project_id == data["id"])
        )
    ).scalars().all()
    assert len(links) == 1
    assert links[0].universe_id == universe.id
    assert links[0].chapter_number == 2
    assert links[0].chapter_title == "归来"


@pytest.mark.asyncio
async def test_get_project_messages(async_client, test_session):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id, status="running")
    await create_message(
        test_session,
        run_id=run.id,
        project_id=project.id,
        agent="system",
        role="assistant",
        content="hello world",
    )

    res = await async_client.get(f"/api/v1/projects/{project.id}/messages")

    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["project_id"] == project.id
    assert data[0]["content"] == "hello world"


@pytest.mark.asyncio
async def test_delete_project(async_client, test_session):
    project = await create_project(test_session)
    res = await async_client.delete(f"/api/v1/projects/{project.id}")
    assert res.status_code == 204

    res = await async_client.get(f"/api/v1/projects/{project.id}")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_batch_delete_projects(async_client, test_session):
    project1 = await create_project(test_session, title="Project 1")
    project2 = await create_project(test_session, title="Project 2")
    project3 = await create_project(test_session, title="Project 3")

    res = await async_client.post(
        "/api/v1/projects/batch-delete", json={"ids": [project1.id, project2.id]}
    )

    assert res.status_code == 204

    list_res = await async_client.get("/api/v1/projects")
    data = list_res.json()
    remain_ids = {item["id"] for item in data["items"]}
    assert remain_ids == {project3.id}


@pytest.mark.asyncio
async def test_delete_project_does_not_require_admin_token_when_configured(
    test_session, test_settings, ws_manager
):
    test_settings.admin_token = "secret-admin-token"
    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return test_settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws

    project = await create_project(test_session)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.delete(f"/api/v1/projects/{project.id}")

    assert res.status_code == 204


@pytest.mark.asyncio
async def test_get_final_video_download(test_session, monkeypatch, tmp_path):
    project = await create_project(test_session)
    final_file = tmp_path / "merged-final.mp4"
    final_file.write_bytes(b"fake video bytes")

    from app.api.v1.routes import projects as projects_routes

    monkeypatch.setattr(projects_routes, "get_local_path", lambda url: final_file)
    project.video_url = "http://cdn.example.com/static/videos/merged-final.mp4"
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    response = await projects_routes.download_final_video(project.id, session=test_session)

    assert response.status_code == 200
    content_disposition = response.headers.get("content-disposition", "")
    assert "merged-final.mp4" in content_disposition


@pytest.mark.asyncio
async def test_get_final_video_no_video_url(async_client, test_session):
    """404 when project has no video_url."""
    project = await create_project(test_session)
    project.video_url = None
    test_session.add(project)
    await test_session.commit()

    res = await async_client.get(f"/api/v1/projects/{project.id}/final-video")
    assert res.status_code == 404
    assert "Final video not found" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_get_final_video_file_missing(async_client, test_session, monkeypatch):
    """404 when video_url points to a non-existent file."""
    project = await create_project(test_session)
    project.video_url = "http://cdn.example.com/static/videos/missing.mp4"
    test_session.add(project)
    await test_session.commit()

    from app.api.v1.routes import projects as projects_routes

    monkeypatch.setattr(projects_routes, "get_local_path", lambda url: None)

    res = await async_client.get(f"/api/v1/projects/{project.id}/final-video")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_upload_reference_image(async_client, test_session):
    """Upload a reference image and verify it's added to the project."""
    project = await create_project(test_session)

    # 1x1 red PNG
    import base64

    tiny_png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
    )

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/upload-reference",
        files={"file": ("test.png", tiny_png, "image/png")},
    )

    assert res.status_code == 200
    data = res.json()
    assert "url" in data
    assert data["url"].startswith("/static/references/")
    assert len(data["reference_images"]) >= 1


@pytest.mark.asyncio
async def test_upload_reference_image_rejects_non_image(async_client, test_session):
    """Reject non-image file types."""
    project = await create_project(test_session)

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/upload-reference",
        files={"file": ("test.txt", b"hello", "text/plain")},
    )

    assert res.status_code == 400
    assert "Only image files" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_upload_reference_image_rejects_oversize(test_session):
    """Reject images over 10MB."""
    project = await create_project(test_session)

    # 11MB of zeros pretending to be PNG
    big_content = b"\x89PNG" + b"\x00" * (11 * 1024 * 1024)

    from fastapi import HTTPException

    class FakeUploadFile:
        content_type = "image/png"

        async def read(self) -> bytes:
            return big_content

    with pytest.raises(HTTPException) as exc_info:
        await project_routes.upload_reference_image(
            project.id,
            file=FakeUploadFile(),
            session=test_session,
        )

    assert exc_info.value.status_code == 400
    assert "10MB" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_get_final_video_project_not_found(async_client):
    """404 when project doesn't exist."""
    res = await async_client.get("/api/v1/projects/999999/final-video")
    assert res.status_code == 404
