from __future__ import annotations

from app.config import Settings, apply_settings_overrides, get_settings


# --- text_headers ---


def test_text_headers_with_key():
    s = Settings(database_url="sqlite+aiosqlite:///:memory:", text_api_key="sk-test")
    headers = s.text_headers()
    assert headers["Authorization"] == "Bearer sk-test"


def test_text_headers_no_key():
    s = Settings(database_url="sqlite+aiosqlite:///:memory:")
    headers = s.text_headers()
    assert "Authorization" not in headers


# --- apply_settings_overrides ---


def test_apply_settings_overrides_empty():
    """Empty overrides should be no-op."""
    apply_settings_overrides({})


def test_apply_settings_overrides_updates_field(monkeypatch):
    settings = get_settings()
    original_app_name = settings.app_name
    try:
        apply_settings_overrides({"app_name": "TestOverride"})
        assert get_settings().app_name == "TestOverride"
    finally:
        settings.app_name = original_app_name


# --- enable_image_to_video property ---


def test_enable_image_to_video_property():
    s = Settings(database_url="sqlite+aiosqlite:///:memory:", enable_image_to_video=True)
    assert s.enable_image_to_video is True
