from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.services import audio_service
from app.services.audio_service import AudioService
from app.services import file_cleaner


def make_settings(**overrides):
    base = dict(
        database_url="sqlite+aiosqlite:///:memory:",
        tts_enabled=True,
        bgm_enabled=True,
        bgm_volume=0.3,
        tts_volume=1.0,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.mark.asyncio
async def test_mix_audio_downloads_remote_video_before_ffmpeg(tmp_path, monkeypatch):
    static_dir = tmp_path / "static"
    audio_dir = static_dir / "audio"
    audio_dir.mkdir(parents=True)
    tts_file = audio_dir / "tts.mp3"
    tts_file.write_bytes(b"fake tts")

    monkeypatch.setattr(file_cleaner, "STATIC_DIR", static_dir)
    monkeypatch.setattr(audio_service, "AUDIO_OUTPUT_DIR", audio_dir)

    downloaded_paths: list[Path] = []

    class FakeMerger:
        async def download_video(self, url: str, dest_path: Path) -> None:
            assert url == "https://cdn.example.com/shot.mp4"
            dest_path.write_bytes(b"fake video")
            downloaded_paths.append(dest_path)

    monkeypatch.setattr(
        "app.services.video_merger.get_video_merger_service",
        lambda: FakeMerger(),
    )

    async def fake_ffmpeg_mix(
        self,
        video_path: Path,
        tts_path: Path | None,
        bgm_path: Path | None,
        output_path: Path,
        tts_volume: float,
        bgm_volume: float,
    ) -> Path:
        assert video_path.exists()
        assert tts_path == tts_file
        assert bgm_path is None
        assert tts_volume == 1.0
        assert bgm_volume == 0.3
        output_path.write_bytes(b"mixed")
        return output_path

    monkeypatch.setattr(AudioService, "_ffmpeg_mix", fake_ffmpeg_mix)

    result = await AudioService(make_settings()).mix_audio_into_video(
        video_path="https://cdn.example.com/shot.mp4",
        tts_path="/static/audio/tts.mp3",
    )

    assert result.startswith("/static/videos/audio_")
    assert (static_dir / result.removeprefix("/static/")).is_file()
    assert downloaded_paths
    assert not downloaded_paths[0].exists()


@pytest.mark.asyncio
async def test_ffmpeg_mix_maps_only_primary_video_stream(tmp_path, monkeypatch):
    captured: dict[str, tuple[str, ...]] = {}

    probe_json = b'{"streams": [{"codec_type": "video", "duration": "4.0"}]}'

    class FakeProcess:
        returncode = 0

        def __init__(self, stdout: bytes = b""):
            self._stdout = stdout

        async def communicate(self):
            return self._stdout, b""

    async def fake_create_subprocess_exec(*cmd, stdout=None, stderr=None):
        if cmd[0] == "ffprobe":
            return FakeProcess(probe_json)
        captured["cmd"] = cmd
        return FakeProcess()

    monkeypatch.setattr(
        audio_service.asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    svc = AudioService(make_settings())
    await svc._ffmpeg_mix(
        video_path=tmp_path / "source.mp4",
        tts_path=tmp_path / "tts.mp3",
        bgm_path=None,
        output_path=tmp_path / "out.mp4",
        tts_volume=1.0,
        bgm_volume=0.3,
    )

    cmd = captured["cmd"]
    first_map = cmd.index("-map")
    assert cmd[first_map + 1] == "0:v:0"


@pytest.mark.asyncio
async def test_generate_tts_uses_local_placeholder_when_fake_provider(tmp_path, monkeypatch):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    monkeypatch.setattr(audio_service, "AUDIO_OUTPUT_DIR", audio_dir)

    svc = AudioService(
        make_settings(
            text_provider="fake",
            image_provider="fake",
            video_provider="fake",
        )
    )
    url = await svc.generate_tts("开始本地测试。")

    assert url is not None
    assert url.startswith("/static/audio/tts_")
    # Ensure file landed under the patched output dir.
    filename = url.rsplit("/", 1)[-1]
    assert (audio_dir / filename).is_file()
    assert (audio_dir / filename).stat().st_size > 100
