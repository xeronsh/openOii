from __future__ import annotations

import asyncio
import logging
from typing import Literal, Protocol

from app.config import Settings
from app.schemas.project import ProjectProviderEntry, ProviderResolution
from app.services.llm import LLMService
from app.services.text import TextService
from app.services.text_capabilities import (
    TextProviderCapability,
    build_provider_capability_cache_key,
    get_cached_provider_capability,
    set_cached_provider_capability,
)


class ProjectProviderOverrides(Protocol):
    text_provider_override: str | None
    image_provider_override: str | None
    video_provider_override: str | None


logger = logging.getLogger(__name__)

TEXT_PROVIDER_KEYS = ("anthropic", "openai", "fake")
IMAGE_PROVIDER_KEYS = ("modelscope", "openai", "fake")
VIDEO_VENDOR_KEYS = ("kling", "vidu", "zhipu", "minimax", "dashscope", "veo")
VIDEO_PROVIDER_KEYS = ("openai", "doubao", *VIDEO_VENDOR_KEYS, "fake")
TEXT_PROBE_TTL_S = 300.0
TEXT_PROBE_GENERATE_FAILURE_TTL_S = 15.0
TEXT_PROBE_TIMEOUT_S = 60.0
TEXT_PROBE_MAX_RETRIES = 1


def _normalize_provider_key(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    return normalized or None


def _missing_credentials_message(label: str) -> str:
    return f"{label} Provider 缺少凭据，当前无法启动。"


def _default_capabilities(*, generate: bool | None, stream: bool | None = None) -> ProjectProviderEntry.Capabilities:
    return ProjectProviderEntry.Capabilities(generate=generate, stream=stream)


def _provider_snapshot_payload(snapshot: object) -> dict[str, object] | None:
    if isinstance(snapshot, dict):
        return snapshot
    if hasattr(snapshot, "model_dump"):
        try:
            dumped = snapshot.model_dump(mode="json")
        except Exception:
            return None
        if isinstance(dumped, dict):
            return dumped
    return None


def _text_probe_cache_key(settings: Settings) -> str:
    return build_provider_capability_cache_key(
        provider=settings.text_provider,
        text_base_url=settings.text_base_url,
        text_model=settings.text_model,
        text_endpoint=settings.text_endpoint,
        anthropic_base_url=settings.anthropic_base_url,
        anthropic_model=settings.anthropic_model,
        secret=settings.text_api_key or settings.anthropic_api_key or settings.anthropic_auth_token,
    )


def _text_credentials_available(provider_key: str | None, settings: Settings) -> bool:
    if provider_key == "anthropic":
        return bool(settings.anthropic_api_key or settings.anthropic_auth_token)
    if provider_key == "openai":
        return bool(settings.text_api_key)
    if provider_key == "fake":
        return True
    return False


def _text_probe_cache_ttl(result: TextProviderCapability) -> float:
    if result.status == "invalid" and result.reason_code == "provider_generate_unavailable":
        return TEXT_PROBE_GENERATE_FAILURE_TTL_S
    return TEXT_PROBE_TTL_S


async def probe_text_provider(settings: Settings) -> TextProviderCapability:
    cache_key = _text_probe_cache_key(settings)
    cached = get_cached_provider_capability(cache_key)
    if cached is not None:
        return cached

    probe_settings = settings.model_copy(
        update={"request_timeout_s": min(settings.request_timeout_s, TEXT_PROBE_TIMEOUT_S)}
    )

    service: LLMService | TextService
    if probe_settings.text_provider == "anthropic":
        service = LLMService(probe_settings, max_retries=TEXT_PROBE_MAX_RETRIES)
    elif probe_settings.text_provider == "openai":
        service = TextService(probe_settings, max_retries=TEXT_PROBE_MAX_RETRIES)
    elif probe_settings.text_provider == "fake":
        # The engine owns the fake text model; the backend only reports it as usable.
        result = TextProviderCapability(status="valid", generate=True, stream=True)
        return set_cached_provider_capability(cache_key, result, ttl_s=_text_probe_cache_ttl(result))
    else:
        result = TextProviderCapability(
            status="invalid",
            generate=False,
            stream=False,
            reason_code="provider_unsupported",
            reason_message=f"文本 Provider '{probe_settings.text_provider}' 不受支持。",
        )
        return set_cached_provider_capability(cache_key, result, ttl_s=_text_probe_cache_ttl(result))

    result = await service.probe()
    return set_cached_provider_capability(cache_key, result, ttl_s=_text_probe_cache_ttl(result))


def get_cached_text_provider_probe(settings: Settings) -> TextProviderCapability | None:
    return get_cached_provider_capability(_text_probe_cache_key(settings))


def _resolve_entry(
    *,
    override_key: str | None,
    default_key: str | None,
    supported_keys: tuple[str, ...],
    credential_ok: dict[str, bool],
    modality_label: Literal["文本", "图像", "视频"],
    probe: TextProviderCapability | None = None,
) -> ProjectProviderEntry:
    normalized_override = _normalize_provider_key(override_key)
    normalized_default = _normalize_provider_key(default_key)

    selected_key = normalized_override or normalized_default
    source: Literal["project", "default"] = "project" if normalized_override else "default"

    if selected_key is None:
        return ProjectProviderEntry(
            selected_key="",
            source=source,
            resolved_key=None,
            valid=False,
            status="invalid",
            reason_code="provider_default_unavailable",
            reason_message=f"{modality_label} Provider 默认值不可用。",
            capabilities=_default_capabilities(generate=False),
        )

    if selected_key not in supported_keys:
        reason_code = "provider_unknown" if source == "default" else "provider_unsupported"
        return ProjectProviderEntry(
            selected_key=selected_key,
            source=source,
            resolved_key=None,
            valid=False,
            status="invalid",
            reason_code=reason_code,
            reason_message=f"{modality_label} Provider '{selected_key}' 不受支持。",
            capabilities=_default_capabilities(generate=False),
        )

    if not credential_ok.get(selected_key, False):
        return ProjectProviderEntry(
            selected_key=selected_key,
            source=source,
            resolved_key=None,
            valid=False,
            status="invalid",
            reason_code="provider_missing_credentials",
            reason_message=_missing_credentials_message(selected_key),
            capabilities=_default_capabilities(generate=False),
        )

    if probe is not None:
        if probe.status == "invalid":
            return ProjectProviderEntry(
                selected_key=selected_key,
                source=source,
                resolved_key=None,
                valid=False,
                status="invalid",
                reason_code=probe.reason_code,
                reason_message=probe.reason_message,
                capabilities=_default_capabilities(generate=probe.generate, stream=probe.stream),
            )
        if probe.status == "degraded":
            return ProjectProviderEntry(
                selected_key=selected_key,
                source=source,
                resolved_key=selected_key,
                valid=True,
                status="degraded",
                reason_code=probe.reason_code,
                reason_message=probe.reason_message,
                capabilities=_default_capabilities(generate=probe.generate, stream=probe.stream),
            )

    return ProjectProviderEntry(
        selected_key=selected_key,
        source=source,
        resolved_key=selected_key,
        valid=True,
        status="valid",
        reason_code=None,
        reason_message=None,
        capabilities=_default_capabilities(
            generate=True,
            stream=True if modality_label == "文本" else None,
        ),
    )


def resolve_project_provider_settings(
    project: ProjectProviderOverrides,
    settings: Settings,
    *,
    text_probe: TextProviderCapability | None = None,
) -> ProviderResolution:
    text = _resolve_entry(
        override_key=project.text_provider_override,
        default_key=settings.text_provider,
        supported_keys=TEXT_PROVIDER_KEYS,
        credential_ok={
            "anthropic": bool(settings.anthropic_api_key or settings.anthropic_auth_token),
            "openai": bool(settings.text_api_key),
            "fake": True,
        },
        modality_label="文本",
        probe=text_probe,
    )
    image = _resolve_entry(
        override_key=project.image_provider_override,
        default_key=settings.image_provider,
        supported_keys=IMAGE_PROVIDER_KEYS,
        credential_ok={
            "modelscope": bool(settings.image_api_key),
            "openai": bool(settings.image_api_key),
            "fake": True,
        },
        modality_label="图像",
    )
    video = _resolve_entry(
        override_key=project.video_provider_override,
        default_key=settings.video_provider,
        supported_keys=VIDEO_PROVIDER_KEYS,
        credential_ok={
            "openai": bool(settings.video_api_key),
            "doubao": bool(settings.doubao_api_key),
            **{key: bool(settings.video_api_key) for key in VIDEO_VENDOR_KEYS},
            "fake": True,
        },
        modality_label="视频",
    )

    return ProviderResolution(
        valid=text.valid and image.valid and video.valid,
        text=text,
        image=image,
        video=video,
    )


# How long starting a run may wait for a cold text probe. A real model answers
# the two probe calls in 20-60s; the user must not stare at a frozen button for
# that. Past the budget the run starts optimistically (the engine reports a
# broken provider as a normal run failure) and the probe finishes in the
# background so the next start reads it from the cache.
TEXT_PROBE_START_BUDGET_S = 2.0
_probe_tasks: dict[str, asyncio.Task[TextProviderCapability]] = {}


def _probe_in_background(settings: Settings) -> asyncio.Task[TextProviderCapability]:
    key = _text_probe_cache_key(settings)
    task = _probe_tasks.get(key)
    if task is None or task.done():
        task = asyncio.get_running_loop().create_task(probe_text_provider(settings))
        _probe_tasks[key] = task
        task.add_done_callback(lambda done, key=key: _probe_tasks.pop(key, None) if _probe_tasks.get(key) is done else None)
    return task


def warm_text_provider_probe(settings: Settings) -> None:
    """Start a probe in the background when the cache is cold (no-op otherwise)."""
    if settings.text_provider not in TEXT_PROVIDER_KEYS or not _text_credentials_available(
        settings.text_provider, settings
    ):
        return
    if get_cached_text_provider_probe(settings) is not None:
        return
    try:
        _probe_in_background(settings)
    except RuntimeError:  # no running loop
        return


def warm_project_text_probe(project: ProjectProviderOverrides, settings: Settings) -> None:
    selected = _normalize_provider_key(project.text_provider_override) or _normalize_provider_key(
        settings.text_provider
    )
    if selected is None:
        return
    warm_text_provider_probe(settings.model_copy(update={"text_provider": selected}))


async def _bounded_probe(settings: Settings) -> TextProviderCapability | None:
    cached = get_cached_text_provider_probe(settings)
    if cached is not None:
        return cached
    task = _probe_in_background(settings)
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=TEXT_PROBE_START_BUDGET_S)
    except asyncio.TimeoutError:
        logger.info("text provider probe still running after %.1fs; starting optimistically", TEXT_PROBE_START_BUDGET_S)
        return None


async def resolve_project_provider_settings_async(
    project: ProjectProviderOverrides,
    settings: Settings,
    *,
    probe_mode: Literal["live", "cache_only", "bounded"] = "bounded",
) -> ProviderResolution:
    selected_text_key = _normalize_provider_key(project.text_provider_override) or _normalize_provider_key(
        settings.text_provider
    )
    text_probe: TextProviderCapability | None = None

    if selected_text_key in TEXT_PROVIDER_KEYS and _text_credentials_available(selected_text_key, settings):
        probe_settings = settings.model_copy(update={"text_provider": selected_text_key})
        if probe_mode == "cache_only":
            text_probe = get_cached_text_provider_probe(probe_settings)
        elif probe_mode == "bounded":
            text_probe = await _bounded_probe(probe_settings)
        else:
            text_probe = await probe_text_provider(probe_settings)

    return resolve_project_provider_settings(project, settings, text_probe=text_probe)
