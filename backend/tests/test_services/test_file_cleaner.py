from __future__ import annotations

from pathlib import Path

from app.services import file_cleaner


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


def test_delete_file_skips_missing_or_external(monkeypatch):
    monkeypatch.setattr(file_cleaner, "get_local_path", lambda url: None)
    assert file_cleaner.delete_file("https://example.com/a.mp4") is False


def test_delete_files_counts_successes(monkeypatch):
    calls = []

    def fake_delete(url):
        calls.append(url)
        return url == "/static/videos/a.mp4"

    monkeypatch.setattr(file_cleaner, "delete_file", fake_delete)
    assert file_cleaner.delete_files(["/static/videos/a.mp4", "/static/videos/b.mp4"]) == 1
    assert calls == ["/static/videos/a.mp4", "/static/videos/b.mp4"]


def test_get_local_path_returns_none_when_static_dir_missing(monkeypatch):
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", Path("/tmp/nonexistent-static-dir"))
    assert file_cleaner.get_local_path("/static/videos/a.mp4") == Path("/tmp/nonexistent-static-dir/videos/a.mp4")


def test_delete_file_keeps_existing_local_file(monkeypatch, tmp_path):
    """Unlink is disabled until reference-safe media collection exists."""
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", tmp_path)
    target = tmp_path / "videos" / "a.mp4"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("x", encoding="utf-8")

    assert file_cleaner.delete_file("/static/videos/a.mp4") is False
    assert target.exists()


def test_delete_file_returns_false_for_missing_local_file(monkeypatch, tmp_path):
    monkeypatch.setattr(file_cleaner, "STATIC_DIR", tmp_path)

    assert file_cleaner.delete_file("/static/videos/missing.mp4") is False
