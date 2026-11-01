"""Export routes end to end on a sandbox DB with a fake exporter."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

import app.db.session as db_session
from app.api.v1.routes import export as export_routes
from app.db.utils import utcnow
from app.models.export_cache import ExportCache
from app.schemas.export import ExportResponse
from tests.factories import create_project, create_shot


class FakeExporter:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls = []

    async def export_pdf(self, project, shots, characters, include_dialogue, include_character_info):
        self.calls.append(("pdf", project.id, [s.order for s in shots]))
        if self.fail:
            raise RuntimeError("disk full")
        return f"/static/exports/{project.id}.pdf"

    async def export_webtoon(self, project, shots, include_dialogue):
        self.calls.append(("webtoon", project.id, [s.order for s in shots]))
        return f"/static/exports/{project.id}.png"


@pytest.fixture
def export_env(monkeypatch, shared_session_maker):
    """Point the export cache and background task at the test DB and collect the task."""
    tasks = []
    real_create_task = asyncio.create_task

    def create_task(coro):
        task = real_create_task(coro)
        if getattr(coro, "__name__", "") == "_run_export_task":
            tasks.append(task)
        return task

    monkeypatch.setattr(db_session, "async_session_maker", shared_session_maker)
    monkeypatch.setattr(export_routes.asyncio, "create_task", create_task)
    monkeypatch.setattr(export_routes, "_export_status_cache", {})

    def use(exporter):
        monkeypatch.setattr(export_routes, "_export_service", exporter)
        return exporter

    return tasks, use


def _export_events(ws_manager):
    return [event["data"] for _, event in ws_manager.events if event["type"] == "export_completed"]


@pytest.mark.asyncio
async def test_pdf_export_completes_and_is_recorded(async_client, test_session, ws_manager, export_env):
    tasks, use = export_env
    exporter = use(FakeExporter())
    project = await create_project(test_session)
    await create_shot(test_session, project_id=project.id, order=2)
    await create_shot(test_session, project_id=project.id, order=1)

    started = await async_client.post(f"/api/v1/projects/{project.id}/export/pdf")
    assert started.status_code == 202
    assert started.json()["status"] == "processing"
    await asyncio.gather(*tasks)

    export_id = started.json()["export_id"]
    status = await async_client.get(f"/api/v1/projects/{project.id}/export/{export_id}/status")
    assert status.json()["status"] == "completed"
    assert status.json()["download_url"] == f"/static/exports/{project.id}.pdf"
    assert exporter.calls == [("pdf", project.id, [1, 2])]
    await test_session.refresh(project)
    assert project.exports == [f"/static/exports/{project.id}.pdf"]
    assert _export_events(ws_manager) == [
        {
            "export_id": export_id,
            "format": "pdf",
            "download_url": f"/static/exports/{project.id}.pdf",
            "status": "completed",
            "error": None,
        }
    ]


@pytest.mark.asyncio
async def test_export_times_are_utc_with_z(async_client, test_session, export_env):
    tasks, use = export_env
    use(FakeExporter())
    project = await create_project(test_session)

    started = await async_client.post(f"/api/v1/projects/{project.id}/export/pdf")
    await asyncio.gather(*tasks)

    created = started.json()["created_at"]
    assert created.endswith("Z")
    assert created[:13] == utcnow().isoformat()[:13]


@pytest.mark.asyncio
async def test_webtoon_export_uses_the_strip_exporter(async_client, test_session, export_env):
    tasks, use = export_env
    exporter = use(FakeExporter())
    project = await create_project(test_session)

    started = await async_client.post(f"/api/v1/projects/{project.id}/export/webtoon")
    await asyncio.gather(*tasks)

    assert started.json()["format"] == "webtoon"
    assert exporter.calls == [("webtoon", project.id, [])]


@pytest.mark.asyncio
async def test_failed_export_reports_failed_with_the_reason(async_client, test_session, ws_manager, export_env):
    tasks, use = export_env
    use(FakeExporter(fail=True))
    project = await create_project(test_session)

    started = await async_client.post(f"/api/v1/projects/{project.id}/export/pdf")
    await asyncio.gather(*tasks)

    export_id = started.json()["export_id"]
    status = await async_client.get(f"/api/v1/projects/{project.id}/export/{export_id}/status")
    assert status.json()["status"] == "failed"
    assert status.json()["download_url"] is None
    assert _export_events(ws_manager)[0]["status"] == "failed"
    assert _export_events(ws_manager)[0]["error"] == "disk full"
    await test_session.refresh(project)
    assert not project.exports


@pytest.mark.asyncio
async def test_export_404s(async_client, export_env):
    tasks, _ = export_env

    assert (await async_client.post("/api/v1/projects/99999/export/pdf")).status_code == 404
    assert (await async_client.post("/api/v1/projects/99999/export/webtoon")).status_code == 404
    assert (await async_client.get("/api/v1/projects/1/export/nope/status")).status_code == 404
    assert tasks == []


@pytest.mark.asyncio
async def test_expired_status_is_dropped(async_client, test_session, export_env):
    project = await create_project(test_session)
    payload = ExportResponse(export_id="old1", project_id=project.id, format="pdf", status="completed")
    test_session.add(
        ExportCache(
            export_id="old1", payload=payload.model_dump_json(), expires_at=utcnow() - timedelta(seconds=1)
        )
    )
    await test_session.commit()

    res = await async_client.get(f"/api/v1/projects/{project.id}/export/old1/status")

    assert res.status_code == 404
    test_session.expire_all()
    assert await test_session.get(ExportCache, "old1") is None


@pytest.mark.asyncio
async def test_status_falls_back_to_memory_when_the_cache_table_fails(
    async_client, test_session, monkeypatch, export_env
):
    project = await create_project(test_session)

    def broken_maker():
        raise RuntimeError("db locked")

    monkeypatch.setattr(db_session, "async_session_maker", broken_maker)
    await export_routes._store_export_status(
        ExportResponse(export_id="mem1", project_id=project.id, format="pdf", status="processing")
    )

    res = await async_client.get(f"/api/v1/projects/{project.id}/export/mem1/status")

    assert res.status_code == 200
    assert res.json()["status"] == "processing"
