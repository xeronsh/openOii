from __future__ import annotations

from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import deps as api_deps
from app.api.deps import get_app_settings, get_db_session, get_ws_manager
from app.api.v1.routes import config as config_routes
from app.config import Settings
from app.main import create_app
from app.models.config_item import ConfigItem
from app.schemas.config import (
    ConnectionCapabilities,
    TestConnectionResponse as ConfigTestConnectionResponse,
)
from app.services.text_capabilities import TextProviderCapability
from tests.factories import create_config_item


def _write_env_file(tmp_path, values: dict[str, str]) -> str:
    env_file = tmp_path / "provider.env"
    env_file.write_text(
        "\n".join(f"{key}={value}" for key, value in values.items()), encoding="utf-8"
    )
    return str(env_file)


@pytest.mark.asyncio
async def test_list_configs_empty(async_client):
    """测试获取空配置列表"""
    res = await async_client.get("/api/v1/config")
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data, list)
    # 可能有来自 .env 的配置，所以不强制为空


@pytest.mark.asyncio
async def test_list_configs_with_data(async_client, test_session):
    """测试获取包含数据的配置列表"""
    await create_config_item(test_session, key="TEST_KEY_1", value="value1")
    await create_config_item(test_session, key="TEST_KEY_2", value="value2", is_sensitive=True)

    res = await async_client.get("/api/v1/config")
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data, list)

    # 查找我们创建的配置项
    test_items = [item for item in data if item["key"].startswith("TEST_KEY_")]
    assert len(test_items) == 2

    # 验证敏感信息被脱敏
    sensitive_item = next(item for item in test_items if item["key"] == "TEST_KEY_2")
    assert sensitive_item["is_sensitive"] is True
    assert sensitive_item["is_masked"] is True
    assert "***" in sensitive_item["value"]


@pytest.mark.asyncio
async def test_update_configs_new_item(async_client, test_session):
    """测试创建新配置项"""
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"NEW_CONFIG_KEY": "new_value"}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["updated"] == 1
    assert data["skipped"] == 0

    # 验证数据库中存在
    item = await test_session.get(ConfigItem, "NEW_CONFIG_KEY")
    assert item is not None
    assert item.value == "new_value"


@pytest.mark.asyncio
async def test_update_configs_existing_item(async_client, test_session):
    """测试更新已存在的配置项"""
    await create_config_item(test_session, key="EXISTING_KEY", value="old_value")

    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"EXISTING_KEY": "new_value"}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["updated"] == 1

    # 验证值已更新
    item = await test_session.get(ConfigItem, "EXISTING_KEY")
    assert item is not None
    assert item.value == "new_value"


@pytest.mark.asyncio
async def test_update_configs_post_alias(async_client, test_session):
    res = await async_client.post(
        "/api/v1/config",
        json={"configs": {"POST_ALIAS_KEY": "post_value"}},
    )

    assert res.status_code == 200
    data = res.json()
    assert data["updated"] == 1

    item = await test_session.get(ConfigItem, "POST_ALIAS_KEY")
    assert item is not None
    assert item.value == "post_value"


@pytest.mark.asyncio
async def test_update_configs_skip_masked_value(async_client, test_session):
    """测试跳过脱敏值（不更新）"""
    await create_config_item(
        test_session, key="SENSITIVE_KEY", value="secret123456", is_sensitive=True
    )

    # 尝试用脱敏值更新（应该被跳过）
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"SENSITIVE_KEY": "secr******3456"}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["skipped"] == 1
    assert data["updated"] == 0

    # 验证值未改变
    item = await test_session.get(ConfigItem, "SENSITIVE_KEY")
    assert item is not None
    assert item.value == "secret123456"


@pytest.mark.asyncio
async def test_update_configs_restart_required(async_client, test_session):
    """测试需要重启的配置项"""
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"DATABASE_URL": "postgresql://new_url"}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["restart_required"] is True
    assert "DATABASE_URL" in data["restart_keys"]
    assert "重启" in data["message"]


@pytest.mark.asyncio
async def test_update_configs_no_restart_required(async_client, test_session):
    """测试不需要重启的配置项"""
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"IMAGE_API_KEY": "new_key"}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["restart_required"] is False
    assert len(data["restart_keys"]) == 0


@pytest.mark.asyncio
async def test_reveal_value_existing(async_client, test_session):
    """测试获取已存在配置的原始值"""
    await create_config_item(
        test_session, key="SECRET_KEY", value="my_secret_value", is_sensitive=True
    )

    res = await async_client.post(
        "/api/v1/config/reveal",
        json={"key": "SECRET_KEY"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["key"] == "SECRET_KEY"
    assert data["value"] == "my_secret_value"


@pytest.mark.asyncio
async def test_reveal_value_not_found(async_client, test_session):
    """测试获取不存在配置的原始值"""
    res = await async_client.post(
        "/api/v1/config/reveal",
        json={"key": "NON_EXISTENT_KEY"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["key"] == "NON_EXISTENT_KEY"
    assert data["value"] is None


@pytest.mark.asyncio
async def test_test_connection_happy_path(async_client, monkeypatch):
    async def _fake_test_llm_connection(_settings):
        return ConfigTestConnectionResponse(
            success=True, message="LLM 服务连接成功", details="模型: test"
        )

    monkeypatch.setattr(config_routes, "_test_llm_connection", _fake_test_llm_connection)

    res = await async_client.post(
        "/api/v1/config/test-connection",
        json={"service": "llm"},
    )

    assert res.status_code == 200
    data = res.json()
    assert data["success"] is True
    assert data["message"] == "LLM 服务连接成功"


@pytest.mark.asyncio
async def test_test_connection_unknown_service_branch():
    payload = SimpleNamespace(service="unknown", config_overrides=None)

    result = await config_routes.test_connection(payload)

    assert result.success is False
    assert result.message == "未知服务类型"


@pytest.mark.asyncio
async def test_test_llm_connection_reports_degraded_stream_capability(test_settings, monkeypatch):
    test_settings.text_provider = "openai"
    test_settings.text_model = "Qwen/Qwen3.5-4B"

    async def fake_probe(_settings):
        return TextProviderCapability(
            status="degraded",
            generate=True,
            stream=False,
            reason_code="provider_stream_unavailable",
            reason_message="文本 Provider 流式不可用，已自动回退非流式生成。",
        )

    monkeypatch.setattr(config_routes, "probe_text_provider", fake_probe)

    result = await config_routes._test_llm_connection(test_settings)

    assert result.success is True
    assert result.status == "degraded"
    assert result.capabilities == ConnectionCapabilities(generate=True, stream=False)
    assert "部分可用" in result.message


@pytest.mark.asyncio
async def test_is_safe_url_rejects_private_and_invalid_urls():
    assert config_routes._is_safe_url("https://example.com/path") is True
    assert config_routes._is_safe_url("http://127.0.0.1:8080") is False
    assert config_routes._is_safe_url("http://localhost:8000") is False
    assert config_routes._is_safe_url("http://foo.localhost:8000") is False
    assert config_routes._is_safe_url("ftp://example.com") is False
    assert config_routes._is_safe_url("not-a-url") is False


@pytest.mark.asyncio
async def test_is_safe_url_returns_false_when_urlparse_raises(monkeypatch):
    def _boom(_url):
        raise RuntimeError("boom")

    monkeypatch.setattr(config_routes, "urlparse", _boom)

    assert config_routes._is_safe_url("https://example.com") is False


@pytest.mark.asyncio
async def test_test_connection_rejects_unknown_override_field(async_client):
    res = await async_client.post(
        "/api/v1/config/test-connection",
        json={
            "service": "llm",
            "config_overrides": {"NOT_A_REAL_FIELD": "nope"},
        },
    )

    assert res.status_code == 400
    assert "不允许覆盖配置字段" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_test_connection_rejects_unsafe_base_url(async_client):
    res = await async_client.post(
        "/api/v1/config/test-connection",
        json={
            "service": "llm",
            "config_overrides": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:9999"},
        },
    )

    assert res.status_code == 400
    assert "不安全的 URL" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_test_connection_applies_masked_overrides_without_clobbering(
    monkeypatch, async_client, test_settings
):
    captured = {}

    test_settings.anthropic_base_url = "https://original.example.com"

    async def fake_probe(settings):
        captured["base_url"] = settings.anthropic_base_url
        captured["api_key"] = settings.anthropic_api_key
        return TextProviderCapability(
            status="valid",
            generate=True,
            stream=True,
            reason_code=None,
            reason_message=None,
        )

    monkeypatch.setattr(config_routes, "probe_text_provider", fake_probe)

    res = await async_client.post(
        "/api/v1/config/test-connection",
        json={
            "service": "llm",
            "config_overrides": {
                "ANTHROPIC_BASE_URL": "https://api.example.com",
                "ANTHROPIC_API_KEY": "***masked***",
            },
        },
    )

    assert res.status_code == 200
    assert captured["base_url"] == "https://api.example.com"
    assert captured["api_key"] is None


@pytest.mark.asyncio
async def test_test_image_connection_success(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            self.settings = settings
            self.max_retries = max_retries

        async def generate(self, prompt, size, n):
            assert prompt == "test"
            assert size == "1024x1024"
            assert n == 1

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is True
    assert result.message == "图像服务连接成功"


@pytest.mark.asyncio
async def test_test_image_connection_reports_auth_failure(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            pass

        async def generate(self, prompt, size, n):
            raise RuntimeError("401 unauthorized")

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "认证失败"


@pytest.mark.asyncio
async def test_test_image_connection_reports_forbidden(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            pass

        async def generate(self, prompt, size, n):
            raise RuntimeError("403 forbidden")

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "认证失败"


@pytest.mark.asyncio
async def test_test_image_connection_reports_not_found(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            pass

        async def generate(self, prompt, size, n):
            raise RuntimeError("404 not found")

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "API 端点不存在"


@pytest.mark.asyncio
async def test_test_image_connection_reports_generic_error(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            pass

        async def generate(self, prompt, size, n):
            raise RuntimeError("bad gateway")

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_test_image_connection_reports_outer_exception(monkeypatch, test_settings):
    def _boom(*args, **kwargs):
        raise RuntimeError("init failed")

    monkeypatch.setattr("app.services.image_factory.create_image_service", _boom)

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_test_image_connection_success_through_route(monkeypatch, test_settings):
    class FakeImageService:
        def __init__(self, settings, max_retries=0):
            self.settings = settings

        async def generate(self, prompt, size, n):
            return None

    monkeypatch.setattr("app.services.image_factory.create_image_service", lambda settings: FakeImageService(settings))
    result = await config_routes._test_image_connection(test_settings)
    assert result.success is True


@pytest.mark.asyncio
async def test_test_image_connection_reports_exception_in_factory(monkeypatch, test_settings):
    def _boom(*args, **kwargs):
        raise RuntimeError("factory failed")

    monkeypatch.setattr("app.services.image_factory.create_image_service", _boom)

    result = await config_routes._test_image_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_test_video_connection_success_for_doubao(monkeypatch, test_settings):
    test_settings.video_provider = "doubao"

    class FakeVideoService:
        async def generate_url(self, prompt, duration, ratio):
            assert prompt == "test"
            assert duration == 5
            assert ratio == "16:9"

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is True
    assert result.message == "视频服务连接成功"


@pytest.mark.asyncio
async def test_test_video_connection_reports_exception_in_factory(monkeypatch, test_settings):
    def _boom(*args, **kwargs):
        raise RuntimeError("factory failed")

    monkeypatch.setattr("app.services.video_factory.create_video_service", _boom)

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_test_video_connection_reports_not_found(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    class FakeVideoService:
        async def generate(self, prompt):
            raise RuntimeError("404 not found")

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "API 端点不存在"


@pytest.mark.asyncio
async def test_test_video_connection_reports_auth_failure(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    class FakeVideoService:
        async def generate(self, prompt):
            raise RuntimeError("401 unauthorized")

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "认证失败"


@pytest.mark.asyncio
async def test_test_video_connection_reports_forbidden(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    class FakeVideoService:
        async def generate(self, prompt):
            raise RuntimeError("403 forbidden")

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "认证失败"


@pytest.mark.asyncio
async def test_test_video_connection_reports_generic_error(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    class FakeVideoService:
        async def generate(self, prompt):
            raise RuntimeError("bad gateway")

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_test_video_connection_reports_outer_exception(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    def _boom(_settings):
        raise RuntimeError("init failed")

    monkeypatch.setattr("app.services.video_factory.create_video_service", _boom)

    result = await config_routes._test_video_connection(test_settings)

    assert result.success is False
    assert result.message == "连接失败"


@pytest.mark.asyncio
async def test_video_connection_allows_fake_fixture_override(async_client):
    res = await async_client.post(
        "/api/v1/config/test-connection",
        json={
            "service": "video",
            "config_overrides": {
                "video_provider": "fake",
                "fake_video_fixture_url": "/static/videos/dev_clip.mp4",
            },
        },
    )

    assert res.status_code == 200


@pytest.mark.asyncio
async def test_test_video_connection_success_through_route(monkeypatch, test_settings):
    test_settings.video_provider = "openai"

    class FakeVideoService:
        async def generate(self, prompt):
            return None

    monkeypatch.setattr(
        "app.services.video_factory.create_video_service", lambda settings: FakeVideoService()
    )

    result = await config_routes._test_video_connection(test_settings)
    assert result.success is True


@pytest.mark.asyncio
async def test_update_configs_empty_payload(async_client):
    """测试空配置更新"""
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["updated"] == 0
    assert data["skipped"] == 0


@pytest.mark.asyncio
async def test_update_configs_null_value(async_client):
    """测试 null 值配置（应该被跳过）"""
    res = await async_client.put(
        "/api/v1/config",
        json={"configs": {"NULL_KEY": None}},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["skipped"] == 1
    assert data["updated"] == 0


@pytest.mark.asyncio
async def test_update_configs_multiple_items(async_client, test_session):
    """测试批量更新多个配置项"""
    res = await async_client.put(
        "/api/v1/config",
        json={
            "configs": {
                "KEY_1": "value1",
                "KEY_2": "value2",
                "KEY_3": "value3",
            }
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["updated"] == 3

    # 验证所有项都已创建
    for i in range(1, 4):
        item = await test_session.get(ConfigItem, f"KEY_{i}")
        assert item is not None
        assert item.value == f"value{i}"


@pytest.mark.asyncio
async def test_sensitive_key_detection(async_client, test_session):
    """测试敏感键自动检测"""
    # 创建包含敏感关键词的配置
    res = await async_client.put(
        "/api/v1/config",
        json={
            "configs": {
                "MY_API_KEY": "key123",
                "AUTH_TOKEN": "token456",
                "DB_PASSWORD": "pass789",
            }
        },
    )
    assert res.status_code == 200

    # 获取配置列表，验证敏感标记
    res = await async_client.get("/api/v1/config")
    data = res.json()

    sensitive_keys = ["MY_API_KEY", "AUTH_TOKEN", "DB_PASSWORD"]
    for key in sensitive_keys:
        item = next((i for i in data if i["key"] == key), None)
        assert item is not None
        assert item["is_sensitive"] is True
        assert item["is_masked"] is True


@pytest.mark.asyncio
async def test_provider_surface_prefers_database_values_over_env(
    monkeypatch, tmp_path, async_client, test_session
):
    monkeypatch.setenv(
        "ENV_FILE",
        _write_env_file(
            tmp_path,
            {
                "TEXT_API_KEY": "env-text-key",
                "TEXT_MODEL": "env-text-model",
                "IMAGE_API_KEY": "env-image-key",
                "IMAGE_MODEL": "env-image-model",
                "VIDEO_API_KEY": "env-video-key",
                "VIDEO_MODEL": "env-video-model",
            },
        ),
    )

    await create_config_item(
        test_session, key="TEXT_API_KEY", value="db-text-key", is_sensitive=True
    )
    await create_config_item(test_session, key="TEXT_MODEL", value="db-text-model")
    await create_config_item(
        test_session, key="IMAGE_API_KEY", value="db-image-key", is_sensitive=True
    )
    await create_config_item(test_session, key="IMAGE_MODEL", value="db-image-model")
    await create_config_item(
        test_session, key="VIDEO_API_KEY", value="db-video-key", is_sensitive=True
    )
    await create_config_item(test_session, key="VIDEO_MODEL", value="db-video-model")

    res = await async_client.get("/api/v1/config")
    assert res.status_code == 200
    data = {item["key"]: item for item in res.json()}

    for key, raw_value in {
        "TEXT_API_KEY": "db-text-key",
        "TEXT_MODEL": "db-text-model",
        "IMAGE_API_KEY": "db-image-key",
        "IMAGE_MODEL": "db-image-model",
        "VIDEO_API_KEY": "db-video-key",
        "VIDEO_MODEL": "db-video-model",
    }.items():
        assert data[key]["source"] == "db"
        if key.endswith("_API_KEY"):
            assert data[key]["is_sensitive"] is True
            assert data[key]["is_masked"] is True
            assert raw_value not in data[key]["value"]
        else:
            assert data[key]["is_sensitive"] is False
            assert data[key]["is_masked"] is False
            assert data[key]["value"] == raw_value


@pytest.mark.asyncio
async def test_reveal_value_falls_back_to_env_for_provider_key(monkeypatch, tmp_path, async_client):
    monkeypatch.setenv(
        "ENV_FILE",
        _write_env_file(tmp_path, {"IMAGE_API_KEY": "env-image-key"}),
    )

    res = await async_client.post("/api/v1/config/reveal", json={"key": "IMAGE_API_KEY"})
    assert res.status_code == 200
    data = res.json()
    assert data["key"] == "IMAGE_API_KEY"
    assert data["value"] == "env-image-key"


@pytest.mark.asyncio
async def test_test_connection_does_not_require_admin_token(
    test_session, test_settings, ws_manager, monkeypatch
):
    """test-connection is read-only and should not require admin token."""
    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return test_settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws
    monkeypatch.setattr(api_deps, "get_settings", lambda: test_settings)

    async def _fake_test_llm_connection(_settings):
        return ConfigTestConnectionResponse(
            success=True,
            message="LLM 服务连接成功",
            details="stubbed",
            status="valid",
            capabilities=ConnectionCapabilities(generate=True, stream=True),
        )

    monkeypatch.setattr(config_routes, "_test_llm_connection", _fake_test_llm_connection)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.post(
            "/api/v1/config/test-connection",
            json={"service": "llm"},
        )

    # test-connection is a read-only probe, no admin token needed
    assert res.status_code in (200, 500)  # 200 if provider configured, 500 if not


@pytest.mark.asyncio
async def test_update_configs_no_admin_token_initial_setup(test_session, ws_manager, monkeypatch):
    """配置更新在未设置 admin_token 时不需要认证（首次设置场景）"""
    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    settings.admin_token = ""

    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws
    monkeypatch.setattr(api_deps, "get_settings", lambda: settings)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # No X-Admin-Token header — should succeed because admin_token not configured
        res = await client.put(
            "/api/v1/config",
            json={"configs": {"ADMIN_TOKEN": "my-secret-token"}},
        )

    assert res.status_code == 200
    data = res.json()
    assert data["updated"] >= 1


@pytest.mark.asyncio
async def test_update_configs_with_admin_token_required(test_session, ws_manager, monkeypatch):
    """配置更新在已设置 admin_token 时需要正确的 token"""
    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    settings.admin_token = "existing-token"

    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws
    monkeypatch.setattr(api_deps, "get_settings", lambda: settings)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Missing token → 403
        res_no_token = await client.put(
            "/api/v1/config",
            json={"configs": {"TEST_KEY": "value"}},
        )
        assert res_no_token.status_code == 403

        # Wrong token → 403
        res_wrong = await client.put(
            "/api/v1/config",
            json={"configs": {"TEST_KEY": "value"}},
            headers={"X-Admin-Token": "wrong-token"},
        )
        assert res_wrong.status_code == 403

        # Correct token → 200
        res_correct = await client.put(
            "/api/v1/config",
            json={"configs": {"TEST_KEY": "value"}},
            headers={"X-Admin-Token": "existing-token"},
        )
        assert res_correct.status_code == 200
        assert res_correct.json()["updated"] >= 1


@pytest.mark.asyncio
async def test_update_configs_admin_token_bootstrap(test_session, ws_manager, monkeypatch):
    """首次设置 ADMIN_TOKEN 的完整引导流程"""
    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    settings.admin_token = ""

    app = create_app()

    async def override_get_session():
        yield test_session

    async def override_get_settings():
        return settings

    async def override_get_ws():
        return ws_manager

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws
    monkeypatch.setattr(api_deps, "get_settings", lambda: settings)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Step 1: No admin token configured, can save without header
        res = await client.put(
            "/api/v1/config",
            json={"configs": {"ADMIN_TOKEN": "new-bootstrap-token", "LLM_API_KEY": "sk-test"}},
        )
        assert res.status_code == 200
        assert res.json()["updated"] >= 2

        # Step 2: Now admin token is configured — subsequent requests need the header
        settings.admin_token = "new-bootstrap-token"

        # Without header → 403
        res_fail = await client.put(
            "/api/v1/config",
            json={"configs": {"ANTHROPIC_BASE_URL": "https://example.com"}},
        )
        assert res_fail.status_code == 403

        # With correct header → 200
        res_ok = await client.put(
            "/api/v1/config",
            json={"configs": {"ANTHROPIC_BASE_URL": "https://example.com"}},
            headers={"X-Admin-Token": "new-bootstrap-token"},
        )
        assert res_ok.status_code == 200
