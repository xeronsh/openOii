from __future__ import annotations

import ipaddress
from typing import Any
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
from app.services.config_service import ConfigService
from app.services.provider_resolution import probe_text_provider

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
    "fake_text_response",
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
                        if not _is_safe_url(value):
                            raise HTTPException(
                                status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"不安全的 URL: {key}（不允许私网/本地地址）",
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

    return TestConnectionResponse(success=False, message="未知服务类型")  # type: ignore[unreachable]


async def _test_llm_connection(settings) -> TestConnectionResponse:
    """测试 LLM 服务连接（使用实际服务类）"""
    try:
        probe = await probe_text_provider(settings)
        model_name = (
            settings.anthropic_model
            if settings.text_provider == "anthropic"
            else settings.text_model
        )
        details = f"提供商: {settings.text_provider}, 模型: {model_name}"
        if probe.reason_message:
            details = f"{details}\n{probe.reason_message}"

        return TestConnectionResponse(
            success=probe.generate,
            message=(
                "LLM 服务连接成功"
                if probe.status == "valid"
                else "LLM 服务部分可用"
                if probe.status == "degraded"
                else "连接失败"
            ),
            details=details,
            status=probe.status,
            capabilities=ConnectionCapabilities(generate=probe.generate, stream=probe.stream),
        )
    except Exception as e:
        return TestConnectionResponse(
            success=False,
            message="连接失败",
            details=str(e)[:200],
            status="invalid",
            capabilities=ConnectionCapabilities(generate=False, stream=False),
        )


async def _test_image_connection(settings) -> TestConnectionResponse:
    """测试图像生成服务连接（使用实际服务类）"""
    try:
        from app.services.image_factory import create_image_service

        # 实例化服务
        service = create_image_service(settings)

        # 尝试发送最小请求
        try:
            # 使用完整参数避免 400 错误
            await service.generate(prompt="test", size="1024x1024", n=1)
            # 成功
            return TestConnectionResponse(
                success=True,
                message="图像服务连接成功",
                details=f"提供商: {settings.image_provider}, 模型: {settings.image_model}",
            )
        except Exception as e:
            # 检查是否是认证错误
            error_str = str(e).lower()
            if "401" in error_str or "unauthorized" in error_str or "authentication" in error_str:
                return TestConnectionResponse(
                    success=False,
                    message="认证失败",
                    details=f"API Key 无效或已过期: {str(e)[:200]}",
                )
            elif "403" in error_str or "forbidden" in error_str:
                return TestConnectionResponse(
                    success=False, message="认证失败", details=f"权限不足: {str(e)[:200]}"
                )
            elif "404" in error_str or "not found" in error_str:
                return TestConnectionResponse(
                    success=False,
                    message="API 端点不存在",
                    details=f"请检查 IMAGE_BASE_URL 和 IMAGE_ENDPOINT 配置: {str(e)[:200]}",
                )
            else:
                # 其他错误也返回失败
                return TestConnectionResponse(
                    success=False, message="连接失败", details=str(e)[:200]
                )
    except Exception as e:
        return TestConnectionResponse(success=False, message="连接失败", details=str(e)[:200])


async def _test_video_connection(settings) -> TestConnectionResponse:
    """测试视频生成服务连接（使用实际服务类）"""
    try:
        from app.services.video_factory import create_video_service

        # 获取实际使用的视频服务
        service = create_video_service(settings)

        # 尝试发送最小请求
        try:
            # 根据服务类型调用不同的方法
            if settings.video_provider == "doubao":
                # 豆包服务使用 generate_url 方法
                await service.generate_url(prompt="test", duration=5, ratio="16:9")
            else:
                # OpenAI 兼容服务优先走 generate 方法。
                # 这里只做连通性探测，依赖服务默认最小时长即可，避免把
                # 具体 provider 参数约束耦合进测试连接逻辑。
                service_any: Any = service
                if callable(getattr(service_any, "generate", None)):
                    await service_any.generate(prompt="test")
                else:
                    await service.generate_url(prompt="test")

            # 成功
            return TestConnectionResponse(
                success=True,
                message="视频服务连接成功",
                details=f"提供商: {settings.video_provider}, 模型: {settings.doubao_video_model if settings.video_provider == 'doubao' else settings.video_model}",
            )
        except Exception as e:
            # 检查是否是认证错误
            error_str = str(e).lower()
            if "401" in error_str or "unauthorized" in error_str or "authentication" in error_str:
                return TestConnectionResponse(
                    success=False,
                    message="认证失败",
                    details=f"API Key 无效或已过期: {str(e)[:200]}",
                )
            elif "403" in error_str or "forbidden" in error_str:
                return TestConnectionResponse(
                    success=False, message="认证失败", details=f"权限不足: {str(e)[:200]}"
                )
            elif "404" in error_str or "not found" in error_str:
                return TestConnectionResponse(
                    success=False,
                    message="API 端点不存在",
                    details=f"请检查视频服务配置: {str(e)[:200]}",
                )
            else:
                # 其他错误也返回失败
                return TestConnectionResponse(
                    success=False, message="连接失败", details=str(e)[:200]
                )
    except Exception as e:
        return TestConnectionResponse(success=False, message="连接失败", details=str(e)[:200])
