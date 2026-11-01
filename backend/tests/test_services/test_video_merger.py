from __future__ import annotations

import pytest

from app.services.video_merger import VideoMergerService


@pytest.mark.asyncio
async def test_close_is_noop(tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)
    await svc.close()
    await svc.close()  # idempotent, no pooled client to release


@pytest.mark.asyncio
async def test_download_video_copies_local_static_file(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"local-video")
    dest = tmp_path / "dest.mp4"

    monkeypatch.setattr("app.services.video_merger.get_local_path", lambda url: source)

    await svc.download_video("/static/videos/source.mp4", dest)

    assert dest.read_bytes() == b"local-video"


@pytest.mark.asyncio
async def test_download_video_delegates_remote_urls(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)
    calls = []

    async def fake_remote(url, dest, max_bytes):
        calls.append((url, max_bytes))
        dest.write_bytes(b"video_data")

    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_remote)
    dest = tmp_path / "test.mp4"
    await svc.download_video("https://cdn.example.com/video.mp4", dest)
    assert dest.read_bytes() == b"video_data"
    assert calls and calls[0][0] == "https://cdn.example.com/video.mp4"


def test_get_video_merger_service_singleton():
    import app.services.video_merger as vm_module

    # Reset singleton
    original = vm_module._merger_service
    vm_module._merger_service = None
    try:
        svc1 = vm_module.get_video_merger_service()
        svc2 = vm_module.get_video_merger_service()
        assert svc1 is svc2
    finally:
        vm_module._merger_service = original
