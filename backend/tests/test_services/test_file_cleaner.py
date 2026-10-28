from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text

from app.services import file_cleaner
from tests.factories import create_project, create_run


def test_extract_static_path_accepts_direct_static_url():
    assert file_cleaner._extract_static_path("/static/videos/a.mp4") == "/static/videos/a.mp4"


def test_extract_static_path_rejects_absolute_url_with_static_path():
    # Only same-origin /static/... paths are local; a remote host's /static/ is not ours.
    assert file_cleaner._extract_static_path("https://example.com/static/images/a.png") is None


def test_extract_static_path_rejects_non_static_url():
    assert file_cleaner._extract_static_path("https://example.com/asset.png") is None


def test_get_local_path_rejects_path_traversal(monkeypatch):
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", Path("/tmp/static"))
    assert file_cleaner.get_local_path("/static/../secrets.txt") is None


def test_get_local_path_returns_none_when_static_dir_missing(monkeypatch):
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", Path("/tmp/nonexistent-static-dir"))
    assert file_cleaner.get_local_path("/static/videos/a.mp4") == Path("/tmp/nonexistent-static-dir/videos/a.mp4")


OLD = "2000-01-01T00:00:00.000Z"


@pytest.fixture()
async def media(test_session, monkeypatch, tmp_path):
    """A media_object registry (migration 0028 shape) over a temporary static dir."""
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", tmp_path)
    (tmp_path / "managed-v1").mkdir()
    await test_session.execute(
        text(
            "CREATE TABLE media_object (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, "
            "relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL "
            "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
        )
    )

    async def register(name: str, *, created_at: str | None = OLD, registered: bool = True) -> Path:
        path = tmp_path / "managed-v1" / name
        path.write_bytes(b"x")
        if registered:
            await test_session.execute(
                text(
                    "INSERT INTO media_object (id, namespace, relative_path, created_at) "
                    "VALUES (:id, 'managed-v1', :rel, COALESCE(:at, strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
                ),
                {"id": name, "rel": f"managed-v1/{name}", "at": created_at},
            )
        await test_session.commit()
        return path

    return register


async def _registered(session) -> set[str]:
    rows = await session.execute(text("SELECT relative_path FROM media_object"))
    return {row[0] for row in rows.all()}


@pytest.mark.asyncio
async def test_sweep_deletes_only_old_unreferenced_registered_media(test_session, media, tmp_path):
    referenced = await media("kept.png")
    in_run_context = await media("ctx.mp4")
    orphan = await media("orphan.mp4")
    young = await media("young.mp4", created_at=None)
    legacy = await media("legacy.mp4", registered=False)
    outside = tmp_path / "videos" / "outside.mp4"
    outside.parent.mkdir()
    outside.write_bytes(b"x")
    # Any column of any table counts: an entity field (full URL) and run JSON.
    project = await create_project(test_session)
    project.video_url = "http://host/static/managed-v1/kept.png"
    await test_session.commit()
    run = await create_run(test_session, project_id=project.id, status="succeeded")
    await test_session.execute(
        text("UPDATE agentrun SET context_snapshot = :ctx WHERE id = :id"),
        {"ctx": '{"clips": ["/static/managed-v1/ctx.mp4"]}', "id": run.id},
    )
    await test_session.commit()

    removed = await file_cleaner.sweep_managed_media(test_session)

    assert removed == 1
    assert not orphan.exists()
    for path in (referenced, in_run_context, young, legacy, outside):
        assert path.exists()
    assert await _registered(test_session) == {
        "managed-v1/kept.png",
        "managed-v1/ctx.mp4",
        "managed-v1/young.mp4",
    }


@pytest.mark.asyncio
async def test_sweep_skips_while_a_run_is_active(test_session, media):
    orphan = await media("orphan.mp4")
    project = await create_project(test_session)
    await create_run(test_session, project_id=project.id, status="running")

    assert await file_cleaner.sweep_managed_media(test_session) == 0
    assert orphan.exists()


@pytest.mark.asyncio
async def test_sweep_never_follows_a_registered_path_out_of_static_dir(test_session, media, tmp_path):
    target = tmp_path.parent / f"{tmp_path.name}-outside.mp4"
    target.write_bytes(b"x")
    await media("escape.mp4")
    link = tmp_path / "managed-v1" / "escape.mp4"
    link.unlink()
    link.symlink_to(target)

    assert await file_cleaner.sweep_managed_media(test_session) == 0
    assert target.exists() and link.is_symlink()
