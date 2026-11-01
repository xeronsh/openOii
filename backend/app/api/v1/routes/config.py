from __future__ import annotations

import ipaddress
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AdminDep, SessionDep
from app.config import get_settings
from app.schemas.config import (
    ConfigItemRead,
    ConnectionCapabilities,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    RevealValueRequest,
    RevealValueResponse,
    TestConnectionRequest,
    TestConnectionResponse,
)
from app.services import connection_probe
from app.services.config_service import ConfigService
from app.services.connection_probe import ProbeOutcome, describe_error_text, describe_exception
from app.services.provider_resolution import VIDEO_VENDOR_KEYS, probe_text_provider
from app.services.video_vendor_probe import probe_video_vendor

router = APIRouter()


def _is_safe_url(url: str) -> bool:
    """检查 URL 是否安全（不指向私网/本地）"""
    # 空 URL 视为安全（使用默认值）
    if not url or not url.strip():
        return True
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.hostname:
            return False

        # 只允许 http/https
        if parsed.scheme not in {"http", "https"}:
            return False

        # 检查是否是 IP 地址
        try:
            ip = ipaddress.ip_address(parsed.hostname)
            # 拒绝私网和本地地址
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        except ValueError:
            # 不是 IP 地址，是域名
            # 拒绝 localhost 相关域名
            hostname_lower = parsed.hostname.lower()
            if hostname_lower in {"localhost", "localhost.localdomain"}:
                return False
            if hostname_lower.endswith(".local") or hostname_lower.endswith(".localhost"):
                return False

        return True
    except Exception:
        return False


def _same_url(a: str, b: str) -> bool:
    return bool(a.strip()) and a.strip().rstrip("/") == (b or "").strip().rstrip("/")


# 允许在 test_connection 中覆盖的配置字段白名单
_ALLOWED_OVERRIDE_FIELDS = {
    # 文本生成
    "anthropic_api_key",
    "anthropic_auth_token",
    "anthropic_base_url",
    "anthropic_model",
    "text_api_key",
    "text_base_url",
    "text_model",
    "text_endpoint",
    "text_provider",
    "text_enable_thinking",
    "text_reasoning_effort",
    # 图像生成
    "image_provider",
    "image_api_key",
    "image_base_url",
    "image_model",
    "image_endpoint",
    "enable_image_to_image",
    "fake_image_fixture_url",
    # 视频生成
    "video_api_key",
    "video_base_url",
    "video_model",
    "video_endpoint",
    "video_provider",
    "video_mode",
    "video_ratio",
    "enable_image_to_video",
    "video_image_mode",
    "video_inline_local_images",
    "fake_video_fixture_url",
    "fake_video_fixture_path",
    "doubao_api_key",
    "doubao_video_model",
    "doubao_video_duration",
    "doubao_video_ratio",
    "doubao_generate_audio",
    # 视觉审查
    "critique_vision_provider",
    "critique_vision_base_url",
    "critique_vision_api_key",
    "critique_vision_model",
    # 配音
    "tts_provider",
    "tts_base_url",
    "tts_api_key",
    "tts_model",
    "tts_default_voice",
    # 背景音乐
    "bgm_provider",
    "bgm_base_url",
    "bgm_api_key",
    "bgm_model",
}


@router.get("", response_model=list[ConfigItemRead])
async def list_configs(session: AsyncSession = SessionDep):
    service = ConfigService(session)
    return await service.list_effective()


@router.post("/reveal", response_model=RevealValueResponse)
async def reveal_value(
    payload: RevealValueRequest,
    session: AsyncSession = SessionDep,
    _: None = AdminDep,
):
    """获取敏感配置的真实值（用于前端显示）"""
    service = ConfigService(session)
    value = await service.get_raw_value(payload.key)
    return RevealValueResponse(key=payload.key, value=value)


@router.put("", response_model=ConfigUpdateResponse, status_code=status.HTTP_200_OK)
@router.post("", response_model=ConfigUpdateResponse, status_code=status.HTTP_200_OK)
async def update_configs(
    payload: ConfigUpdateRequest,
    session: AsyncSession = SessionDep,
    _: None = AdminDep,
):
    service = ConfigService(session)
    result = await service.upsert_configs(payload.configs)
    await service.apply_settings_overrides()
    restart_required = bool(result.restart_keys)
    message = "配置已更新，请重启服务使更改生效" if restart_required else "配置已更新"
    return ConfigUpdateResponse(
        updated=result.updated,
        skipped=result.skipped,
        restart_required=restart_required,
        restart_keys=result.restart_keys,
        message=message,
    )


@router.post("/test-connection", response_model=TestConnectionResponse)
async def test_connection(
    payload: TestConnectionRequest,
):
    """测试服务连接"""
    settings = get_settings()

    # 如果传递了配置覆盖，创建临时配置对象
    if payload.config_overrides:
        # 验证字段白名单
        for key in payload.config_overrides.keys():
            field_name = key.lower()
            if field_name not in _ALLOWED_OVERRIDE_FIELDS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"不允许覆盖配置字段: {key}",
                )

        # 将覆盖值应用到 settings 的副本
        settings_dict = settings.model_dump()

        for key, value in payload.config_overrides.items():
            field_name = key.lower()
            if field_name in settings_dict:
                # 检查是否是脱敏值（包含 ***）
                if value and isinstance(value, str) and "***" in value:
                    # 是脱敏值，不覆盖，使用数据库/环境变量中的原始值
                    continue
                # 不是脱敏值，使用传递的值
                if value is not None:
                    # 如果是 URL 字段，检查安全性
                    if field_name.endswith("_base_url") and isinstance(value, str):
                        # 已保存的本地地址（例如本机网关）可以原样再测；
                        # 新填的私网 / 本地地址要先保存，防止借测试接口探测内网。
                        current = settings_dict.get(field_name)
                        unchanged = _same_url(value, current if isinstance(current, str) else "")
                        if not unchanged and not _is_safe_url(value):
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"不安全的 URL: {key}（本地 / 内网地址请先保存配置，再测试连接）",
                            )
                    settings_dict[field_name] = value

        from app.config import Settings

        settings = Settings.model_validate(settings_dict)

    if payload.service == "llm":
        return await _test_llm_connection(settings)
    elif payload.service == "image":
        return await _test_image_connection(settings)
    elif payload.service == "video":
        return await _test_video_connection(settings)
    elif payload.service == "vision":
        return await _test_vision_connection(settings)
    elif payload.service == "tts":
        return await _test_tts_connection(settings)
    elif payload.service == "bgm":
        return await _test_bgm_connection(settings)

    return TestConnectionResponse(success=False, message="未知服务类型")  # type: ignore[unreachable]


async def _test_llm_connection(settings) -> TestConnectionResponse:
    """测试 LLM 服务连接：一次极短的真实调用（结果有缓存），失败原因映射成中文。"""
    model_name = (
        settings.anthropic_model if settings.text_provider == "anthropic" else settings.text_model
    )
    base = f"提供商: {settings.text_provider}, 模型: {model_name}"
    try:
        probe = await probe_text_provider(settings)
    except Exception as e:  # noqa: BLE001
        failure = describe_exception(e)
        return TestConnectionResponse(
            success=False,
            message=failure.message,
            details=f"{failure.hint}\n{base}",
            status="invalid",
            capabilities=ConnectionCapabilities(generate=False, stream=False),
        )

    if probe.status == "valid":
        message = "LLM 服务连接成功"
        details = base
    elif probe.status == "degraded":
        message = "LLM 服务部分可用"
        details = f"{base}\n{probe.reason_message}" if probe.reason_message else base
    else:
        mapped = describe_error_text(probe.reason_message)
        message = mapped.message if mapped else "连接失败"
        lines = [mapped.hint] if mapped else []
        lines.append(base)
        if probe.reason_message:
            lines.append(f"原始信息：{probe.reason_message[:200]}")
        details = "\n".join(lines)

    return TestConnectionResponse(
        success=probe.generate,
        message=message,
        details=details,
        status=probe.status,
        capabilities=ConnectionCapabilities(generate=probe.generate, stream=probe.stream),
    )


def _probe_response(outcome: ProbeOutcome, provider: str, model: str | None) -> TestConnectionResponse:
    details = f"{outcome.details}\n提供商: {provider}, 模型: {model or '-'}"
    return TestConnectionResponse(
        success=outcome.success,
        message=outcome.message,
        details=details,
        status=outcome.status,
    )


async def _test_vision_connection(settings) -> TestConnectionResponse:
    """视觉审查：GET /models 只读探测；本地 llama-server 不要密钥。"""
    base_url = settings.critique_vision_base_url or ""
    if not base_url.strip():
        return TestConnectionResponse(
            success=False,
            message="还没有配置视觉审查模型",
            details="选一个预设或填写地址；不配置时分镜会标为「未检查」。",
            status="invalid",
        )
    outcome = await connection_probe.probe_openai_compatible(
        label="视觉审查",
        base_url=base_url,
        endpoint="/chat/completions",
        api_key=settings.critique_vision_api_key or "local",
        model=settings.critique_vision_model,
    )
    return _probe_response(outcome, "openai", settings.critique_vision_model)


async def _test_tts_connection(settings) -> TestConnectionResponse:
    """配音：只读探测（列音色 / 列模型），不合成音频。"""
    from app.services.tts_providers import TTSConfig, default_voice, probe

    config = TTSConfig.build(
        settings.tts_provider, settings.tts_base_url, settings.tts_api_key, settings.tts_model
    )
    voice = settings.tts_default_voice or default_voice(config.provider)
    outcome = await probe(config, voice)
    return _probe_response(outcome, config.provider, config.model or voice)


async def _test_bgm_connection(settings) -> TestConnectionResponse:
    """背景音乐：只读探测（余额 / 额度 / 密钥），不生成音乐。"""
    from app.services.audio_service import BGM_BASE_DIR
    from app.services.bgm_library import library_tracks
    from app.services.bgm_providers import BGMConfig, probe

    config = BGMConfig.build(settings.bgm_provider, settings.bgm_base_url, settings.bgm_api_key, settings.bgm_model)
    count = len(library_tracks(BGM_BASE_DIR / settings.bgm_directory))
    outcome = await probe(config, count)
    return _probe_response(outcome, config.provider, config.model or "曲库")


async def _test_image_connection(settings) -> TestConnectionResponse:
    """测试图像服务：只读 GET /models，不再真的生成一张图。"""
    if settings.image_provider == "fake":
        return TestConnectionResponse(
            success=True, message="图像服务连接成功", details="Fake 图像 Provider，无需联网。", status="valid"
        )
    outcome = await connection_probe.probe_openai_compatible(
        label="图像",
        base_url=settings.image_base_url,
        endpoint=settings.image_endpoint,
        api_key=settings.image_api_key,
        model=settings.image_model,
    )
    return _probe_response(outcome, settings.image_provider, settings.image_model)


async def _test_video_connection(settings) -> TestConnectionResponse:
    """测试视频服务：豆包查任务列表，OpenAI 兼容 GET /models，不再真的生成视频。"""
    if settings.video_provider == "fake":
        return TestConnectionResponse(
            success=True, message="视频服务连接成功", details="Fake 视频 Provider，无需联网。", status="valid"
        )
    if settings.video_provider == "doubao":
        outcome = await connection_probe.probe_doubao_video(
            api_key=settings.doubao_api_key, model=settings.doubao_video_model
        )
        return _probe_response(outcome, "doubao", settings.doubao_video_model)
    if settings.video_provider in VIDEO_VENDOR_KEYS:
        outcome = await probe_video_vendor(
            provider=settings.video_provider,
            base_url=settings.video_base_url,
            api_key=settings.video_api_key,
            model=settings.video_model,
        )
        return _probe_response(outcome, settings.video_provider, settings.video_model)
    outcome = await connection_probe.probe_openai_compatible(
        label="视频",
        base_url=settings.video_base_url,
        endpoint=settings.video_endpoint,
        api_key=settings.video_api_key,
        model=settings.video_model,
    )
    return _probe_response(outcome, settings.video_provider, settings.video_model)
