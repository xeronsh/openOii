from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import Settings
from app.services import provider_resolution as provider_resolution_module
from app.services.provider_resolution import (
    TEXT_PROBE_GENERATE_FAILURE_TTL_S,
    TEXT_PROBE_MAX_RETRIES,
    _missing_credentials_message,
    _normalize_provider_key,
    _resolve_entry,
    _text_credentials_available,
    probe_text_provider,
    resolve_project_provider_settings,
    resolve_project_provider_settings_async,
)
from app.services.text_capabilities import TextProviderCapability


def make_project(**overrides: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        text_provider_override=overrides.get("text_provider_override"),
        image_provider_override=overrides.get("image_provider_override"),
        video_provider_override=overrides.get("video_provider_override"),
    )


def test_resolver_uses_runtime_defaults_for_text_provider() -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        image_api_key="image-key",
        video_api_key="video-key",
    )

    result = resolve_project_provider_settings(make_project(), settings)

    assert result.valid is True
    assert result.text.selected_key == "openai"
    assert result.text.source == "default"
    assert result.text.resolved_key == "openai"
    assert result.text.valid is True
    assert result.text.status == "valid"
    assert result.text.reason_code is None
    assert result.text.capabilities is not None
    assert result.text.capabilities.stream is True


def test_provider_resolution_helpers_cover_normalization() -> None:
    assert _normalize_provider_key(None) is None
    assert _normalize_provider_key("  OPENAI  ") == "openai"
    assert _normalize_provider_key("   ") is None
    assert _missing_credentials_message("openai") == "openai Provider 缺少凭据，当前无法启动。"


def test_resolve_entry_handles_invalid_and_missing_credentials() -> None:
    invalid = _resolve_entry(
        override_key="unknown",
        default_key="openai",
        supported_keys=("openai",),
        credential_ok={"openai": True},
        modality_label="文本",
    )
    assert invalid.valid is False
    assert invalid.reason_code == "provider_unsupported"

    missing = _resolve_entry(
        override_key="openai",
        default_key="openai",
        supported_keys=("openai",),
        credential_ok={"openai": False},
        modality_label="文本",
    )
    assert missing.valid is False
    assert missing.reason_code == "provider_missing_credentials"


def test_resolve_entry_accepts_blank_override_as_default() -> None:
    entry = _resolve_entry(
        override_key="   ",
        default_key="openai",
        supported_keys=("openai",),
        credential_ok={"openai": True},
        modality_label="文本",
    )
    assert entry.selected_key == "openai"
    assert entry.source == "default"
    assert entry.valid is True


def test_text_credentials_available_matches_provider_keys() -> None:
    settings = Settings(text_provider="openai", text_api_key="text-key", anthropic_api_key="anthro", anthropic_auth_token="token")
    assert _text_credentials_available("openai", settings) is True
    assert _text_credentials_available("anthropic", settings) is True
    assert _text_credentials_available("unknown", settings) is False


def test_resolver_marks_doubao_without_credentials_invalid() -> None:
    settings = Settings(image_api_key="image-key", text_provider="anthropic", anthropic_api_key="anthropic-key")

    result = resolve_project_provider_settings(
        make_project(video_provider_override="doubao"),
        settings,
    )

    assert result.video.selected_key == "doubao"
    assert result.video.source == "project"
    assert result.video.resolved_key is None
    assert result.video.valid is False
    assert result.video.reason_code == "provider_missing_credentials"
    assert result.video.reason_message
    assert result.valid is False


def test_resolver_accepts_fake_video_without_credentials() -> None:
    settings = Settings(
        image_api_key="image-key",
        text_provider="anthropic",
        anthropic_api_key="anthropic-key",
        video_provider="fake",
    )

    result = resolve_project_provider_settings(make_project(), settings)

    assert result.video.selected_key == "fake"
    assert result.video.source == "default"
    assert result.video.resolved_key == "fake"
    assert result.video.valid is True
    assert result.valid is True


def test_resolver_accepts_fake_text_and_image_without_credentials() -> None:
    settings = Settings(
        text_provider="fake",
        image_provider="fake",
        video_provider="fake",
    )

    result = resolve_project_provider_settings(make_project(), settings)

    assert result.valid is True
    assert result.text.selected_key == "fake"
    assert result.text.valid is True
    assert result.image.selected_key == "fake"
    assert result.image.valid is True
    assert result.video.selected_key == "fake"
    assert result.video.valid is True


def test_resolver_accepts_modelscope_image_with_image_api_key() -> None:
    settings = Settings(
        text_provider="fake",
        image_provider="modelscope",
        image_api_key="image-key",
        video_provider="fake",
    )

    result = resolve_project_provider_settings(make_project(), settings)

    assert result.valid is True
    assert result.image.selected_key == "modelscope"
    assert result.image.resolved_key == "modelscope"
    assert result.image.valid is True


def test_resolver_is_deterministic_for_same_inputs() -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        image_api_key="image-key",
        video_provider="doubao",
        doubao_api_key="doubao-key",
    )
    project = make_project(text_provider_override="openai", video_provider_override="doubao")

    first = resolve_project_provider_settings(project, settings)
    second = resolve_project_provider_settings(project, settings)

    assert first.model_dump() == second.model_dump()


@pytest.mark.asyncio
async def test_async_resolver_marks_text_provider_degraded_when_stream_is_unavailable(monkeypatch) -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        image_api_key="image-key",
        video_api_key="video-key",
    )

    async def fake_probe(_settings: Settings) -> TextProviderCapability:
        return TextProviderCapability(
            status="degraded",
            generate=True,
            stream=False,
            reason_code="provider_stream_unavailable",
            reason_message="文本 Provider 流式不可用，已自动回退非流式生成。",
        )

    monkeypatch.setattr(
        "app.services.provider_resolution.probe_text_provider",
        fake_probe,
    )

    result = await resolve_project_provider_settings_async(make_project(), settings)

    assert result.valid is True
    assert result.text.valid is True
    assert result.text.status == "degraded"
    assert result.text.reason_code == "provider_stream_unavailable"
    assert result.text.capabilities is not None
    assert result.text.capabilities.generate is True
    assert result.text.capabilities.stream is False


@pytest.mark.asyncio
async def test_async_resolver_uses_cache_only_probe(monkeypatch) -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        image_api_key="image-key",
        video_api_key="video-key",
    )
    calls: list[str] = []

    def fake_cached(probe_settings: Settings):
        calls.append(probe_settings.text_provider)
        return TextProviderCapability(status="valid", generate=True, stream=True)

    monkeypatch.setattr("app.services.provider_resolution.get_cached_text_provider_probe", fake_cached)

    result = await resolve_project_provider_settings_async(make_project(), settings, probe_mode="cache_only")

    assert calls == ["openai"]
    assert result.valid is True


@pytest.mark.asyncio
async def test_probe_text_provider_uses_nonzero_probe_retries(monkeypatch) -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        text_base_url="https://text.example.com",
        text_model="gpt-test",
        text_endpoint="/chat/completions",
    )
    captured: dict[str, int] = {}

    class DummyTextService:
        def __init__(self, probe_settings: Settings, *, max_retries: int = 0):
            captured["max_retries"] = max_retries

        async def probe(self) -> TextProviderCapability:
            return TextProviderCapability(status="valid", generate=True, stream=True)

    monkeypatch.setattr("app.services.provider_resolution.TextService", DummyTextService)

    result = await probe_text_provider(settings)

    assert captured["max_retries"] == TEXT_PROBE_MAX_RETRIES
    assert result.status == "valid"


@pytest.mark.asyncio
async def test_probe_text_provider_allows_slow_proxy_probe(monkeypatch) -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        text_base_url="https://slow-proxy.example.com",
        text_model="gpt-slow-test",
        text_endpoint="/chat/completions",
        request_timeout_s=120,
    )
    captured: dict[str, float] = {}

    class DummyTextService:
        def __init__(self, probe_settings: Settings, *, max_retries: int = 0):
            captured["request_timeout_s"] = probe_settings.request_timeout_s

        async def probe(self) -> TextProviderCapability:
            return TextProviderCapability(status="valid", generate=True, stream=True)

    monkeypatch.setattr("app.services.provider_resolution.TextService", DummyTextService)

    result = await probe_text_provider(settings)

    assert captured["request_timeout_s"] == 60.0
    assert result.status == "valid"


@pytest.mark.asyncio
async def test_probe_text_provider_caches_generate_failures_briefly(monkeypatch) -> None:
    settings = Settings(
        text_provider="openai",
        text_api_key="text-key",
        text_base_url="https://flaky-proxy.example.com",
        text_model="gpt-flaky-test",
        text_endpoint="/chat/completions",
    )
    captured: dict[str, float] = {}

    class DummyTextService:
        def __init__(self, probe_settings: Settings, *, max_retries: int = 0):
            pass

        async def probe(self) -> TextProviderCapability:
            return TextProviderCapability(
                status="invalid",
                generate=False,
                stream=False,
                reason_code="provider_generate_unavailable",
                reason_message="文本 Provider 连通性预检失败：Server error (HTTP 502)",
            )

    def fake_set_cached_provider_capability(
        cache_key: str,
        result: TextProviderCapability,
        *,
        ttl_s: float,
    ) -> TextProviderCapability:
        captured["ttl_s"] = ttl_s
        return result

    monkeypatch.setattr("app.services.provider_resolution.TextService", DummyTextService)
    monkeypatch.setattr(
        provider_resolution_module,
        "set_cached_provider_capability",
        fake_set_cached_provider_capability,
    )

    result = await probe_text_provider(settings)

    assert result.status == "invalid"
    assert captured["ttl_s"] == TEXT_PROBE_GENERATE_FAILURE_TTL_S
