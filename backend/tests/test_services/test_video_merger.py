from __future__ import annotations

from pathlib import Path

import pytest

from app.services.video_merger import VideoMergerService


def test_merge_videos_requires_urls(tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)
    with pytest.raises(ValueError, match="No video URLs"):
        import asyncio

        asyncio.run(svc.merge_videos([]))


@pytest.mark.asyncio
async def test_merge_videos_normalizes_single_url(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)

    async def fake_download(url, dest, max_bytes=None):
        dest.write_bytes(b"data")

    monkeypatch.setattr(svc, "download_video", fake_download)
    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_download)

    assert await svc.merge_videos(["https://cdn.example.com/a.mp4"], output_filename="single") == "/static/videos/single.mp4"
    assert (tmp_path / "single.mp4").read_bytes() == b"data"


@pytest.mark.asyncio
async def test_merge_videos_writes_output_and_uses_ffmpeg(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)

    async def fake_download(url, dest, max_bytes=None):
        dest.write_bytes(b"data")

    class FakeProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_exec(*args, **kwargs):
        Path(args[-1]).write_bytes(b"merged")
        return FakeProc()

    monkeypatch.setattr(svc, "download_video", fake_download)
    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_download)
    monkeypatch.setattr("app.services.video_merger.asyncio.create_subprocess_exec", fake_exec)

    result = await svc.merge_videos(["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], output_filename="merged")

    assert result == "/static/videos/merged.mp4"
    assert (tmp_path / "merged.mp4").read_bytes() == b"merged"


@pytest.mark.asyncio
async def test_merge_videos_reencodes_on_ffmpeg_copy_failure(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)

    async def fake_download(url, dest, max_bytes=None):
        dest.write_bytes(b"data")

    class FakeFailProc:
        returncode = 1

        async def communicate(self):
            return b"", b"copy failed"

    class FakeOkProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    procs = [FakeFailProc(), FakeOkProc()]

    async def fake_exec(*args, **kwargs):
        proc = procs.pop(0)
        if proc.returncode == 0:
            Path(args[-1]).write_bytes(b"merged")
        return proc

    monkeypatch.setattr(svc, "download_video", fake_download)
    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_download)
    monkeypatch.setattr("app.services.video_merger.asyncio.create_subprocess_exec", fake_exec)

    result = await svc.merge_videos(["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], output_filename="merged")

    assert result == "/static/videos/merged.mp4"
    assert (tmp_path / "merged.mp4").read_bytes() == b"merged"


@pytest.mark.asyncio
async def test_merge_videos_raises_when_reencode_fails(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)

    async def fake_download(url, dest, max_bytes=None):
        dest.write_bytes(b"data")

    class FakeFailProc:
        returncode = 1

        async def communicate(self):
            return b"", b"copy failed"

    monkeypatch.setattr(svc, "download_video", fake_download)
    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_download)
    async def fake_exec(*args, **kwargs):
        return FakeFailProc()

    monkeypatch.setattr("app.services.video_merger.asyncio.create_subprocess_exec", fake_exec)

    with pytest.raises(RuntimeError, match="ffmpeg failed"):
        await svc.merge_videos(["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4"], output_filename="merged")


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


@pytest.mark.asyncio
async def test_merge_videos_infer_extension_from_query_string(monkeypatch, tmp_path):
    svc = VideoMergerService(output_dir=tmp_path)

    async def fake_download(url, dest, max_bytes=None):
        dest.write_bytes(b"data")

    class FakeProc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_exec(*args, **kwargs):
        Path(args[-1]).write_bytes(b"merged")
        return FakeProc()

    monkeypatch.setattr(svc, "download_video", fake_download)
    monkeypatch.setattr("app.services.video_merger.download_video_async", fake_download)
    monkeypatch.setattr("app.services.video_merger.asyncio.create_subprocess_exec", fake_exec)

    result = await svc.merge_videos(
        ["https://cdn.example.com/a.mp4?token=abc", "https://cdn.example.com/b.mp4?token=xyz"],
        output_filename="merged",
    )
    assert result == "/static/videos/merged.mp4"
    assert (tmp_path / "merged.mp4").read_bytes() == b"merged"
