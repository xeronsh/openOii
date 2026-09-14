from __future__ import annotations

import pytest

from app.models.config_item import ConfigItem
from app.services.config_service import (
    ConfigService,
    MASK_VALUE,
    _load_env_file,
    _is_masked_input,
    _parse_value,
    _requires_restart,
    is_sensitive_key,
    mask_value,
)
from tests.factories import create_config_item


def test_mask_value_and_sensitive_detection():
    assert mask_value(None) == MASK_VALUE
    assert mask_value("") == MASK_VALUE
    assert mask_value("12345678") == MASK_VALUE
    assert mask_value("abcdefghijk") == f"abcd{MASK_VALUE}hijk"

    assert is_sensitive_key("API_KEY") is True
    assert is_sensitive_key("database_url") is True
    assert is_sensitive_key("public_name") is False


def test_masked_input_detection():
    assert _is_masked_input("******", "secret123") is True
    assert _is_masked_input(mask_value("secret123"), "secret123") is True
    assert _is_masked_input("plain", "secret123") is False
    assert _is_masked_input("******", None) is True


def test_requires_restart_detection():
    assert _requires_restart("DATABASE_URL") is True
    assert _requires_restart("database_url") is True
    assert _requires_restart("PUBLIC_BASE_URL") is True
    assert _requires_restart("IMAGE_API_KEY") is False


def test_parse_value_handles_scalar_and_json():
    assert _parse_value("true", bool) is True
    assert _parse_value("123", int) == 123
    assert _parse_value('["a", "b"]', list[str]) == ["a", "b"]
    assert _parse_value("{bad json", list[str]) == "{bad json"
    assert _parse_value("", int | None) is None
    assert _parse_value("not-int", int) == "not-int"
    assert _parse_value("   ", int) == "   "


def test_parse_value_falls_back_on_json_decode_error_for_container_types():
    assert _parse_value("[invalid", list[str]) == "[invalid"
    assert _parse_value("{invalid", dict[str, str]) == "{invalid"
    assert _parse_value('{"bad":', dict[str, str]) == '{"bad":'
    assert _parse_value("[1, 2,", list[int]) == "[1, 2,"


def test_load_env_file_parses_comments_export_and_quotes(monkeypatch, tmp_path):
    env_path = tmp_path / "provider.env"
    env_path.write_text(
        """
        # comment
        export TEXT_API_KEY='quoted-key' # inline comment
        PUBLIC_BASE_URL=https://example.com
        INVALID_LINE
        SPACED = spaced-value
        """.strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("ENV_FILE", str(env_path))

    data = _load_env_file()

    assert data["TEXT_API_KEY"] == "quoted-key"
    assert data["PUBLIC_BASE_URL"] == "https://example.com"
    assert data["SPACED"] == "spaced-value"
    assert "INVALID_LINE" not in data


def test_load_env_file_returns_empty_when_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "missing.env"))

    assert _load_env_file() == {}


def test_load_env_file_skips_blank_keys(monkeypatch, tmp_path):
    env_path = tmp_path / "provider.env"
    env_path.write_text("=missing-key\nVALID=value\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_path))

    data = _load_env_file()

    assert "" not in data
    assert data["VALID"] == "value"


@pytest.mark.asyncio
async def test_config_service_list_effective_and_get_raw_value(test_session, monkeypatch, tmp_path):
    monkeypatch.setenv("ENV_FILE", str(tmp_path / ".env"))
    (tmp_path / ".env").write_text(
        "PUBLIC_BASE_URL=https://env.example.com\nTEXT_API_KEY=env-key\n", encoding="utf-8"
    )
    await create_config_item(test_session, key="TEXT_API_KEY", value="db-key", is_sensitive=True)
    await create_config_item(test_session, key="TEXT_MODEL", value="db-model")

    service = ConfigService(test_session)
    items = await service.list_effective()
    data = {item["key"]: item for item in items}

    assert data["TEXT_API_KEY"]["source"] == "db"
    assert data["TEXT_API_KEY"]["is_sensitive"] is True
    assert data["TEXT_API_KEY"]["is_masked"] is True
    assert data["TEXT_MODEL"]["source"] == "db"
    assert data["PUBLIC_BASE_URL"]["source"] == "env"

    assert await service.get_raw_value("TEXT_API_KEY") == "db-key"
    assert await service.get_raw_value("PUBLIC_BASE_URL") == "https://env.example.com"


@pytest.mark.asyncio
async def test_config_service_build_and_apply_overrides(test_session, monkeypatch):
    await create_config_item(test_session, key="TEXT_API_KEY", value="db-key", is_sensitive=True)
    await create_config_item(test_session, key="TEXT_MODEL", value="deepseek-v4-flash")

    captured = {}

    def fake_apply(overrides):
        captured.update(overrides)

    monkeypatch.setattr(
        "app.services.config_service.apply_settings_overrides_to_runtime", fake_apply
    )

    service = ConfigService(test_session)
    overrides = await service.build_settings_overrides()
    assert overrides["text_api_key"] == "db-key"
    assert overrides["text_model"] == "deepseek-v4-flash"

    await service.apply_settings_overrides()
    assert captured["text_api_key"] == "db-key"
    assert captured["text_model"] == "deepseek-v4-flash"


@pytest.mark.asyncio
async def test_config_service_ensure_initialized_creates_env_items(
    test_session, monkeypatch, tmp_path
):
    monkeypatch.setattr(
        "app.services.config_service._load_process_env_values", dict
    )
    env_path = tmp_path / "provider.env"
    env_path.write_text(
        "TEXT_API_KEY=env-key\nPUBLIC_BASE_URL=https://env.example.com\n", encoding="utf-8"
    )
    monkeypatch.setenv("ENV_FILE", str(env_path))

    service = ConfigService(test_session)
    created = await service.ensure_initialized()

    assert created == 2
    assert await test_session.get(ConfigItem, "TEXT_API_KEY") is not None
    assert await test_session.get(ConfigItem, "PUBLIC_BASE_URL") is not None


@pytest.mark.asyncio
async def test_config_service_ensure_initialized_skips_existing_items(
    test_session, monkeypatch, tmp_path
):
    monkeypatch.setattr(
        "app.services.config_service._load_process_env_values", dict
    )
    env_path = tmp_path / "provider.env"
    env_path.write_text("TEXT_API_KEY=env-key\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_path))
    await create_config_item(test_session, key="TEXT_API_KEY", value="db-key", is_sensitive=True)

    service = ConfigService(test_session)
    created = await service.ensure_initialized()

    assert created == 0


@pytest.mark.asyncio
async def test_config_service_ensure_initialized_returns_zero_when_env_missing(
    test_session, monkeypatch, tmp_path
):
    monkeypatch.setattr(
        "app.services.config_service._load_process_env_values", dict
    )
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "missing.env"))

    service = ConfigService(test_session)
    created = await service.ensure_initialized()

    assert created == 0


@pytest.mark.asyncio
async def test_config_service_ensure_initialized_process_env_beats_env_file(
    test_session, monkeypatch, tmp_path
):
    """进程 env 优先于 .env 文件（与 get_settings 的 pydantic 优先级一致）。"""
    env_path = tmp_path / "provider.env"
    env_path.write_text("TEXT_API_KEY=file-key\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_path))
    monkeypatch.setattr(
        "app.services.config_service._load_process_env_values",
        lambda: {"TEXT_API_KEY": "process-key"},
    )

    service = ConfigService(test_session)
    created = await service.ensure_initialized()

    assert created == 1
    item = await test_session.get(ConfigItem, "TEXT_API_KEY")
    assert item is not None and item.value == "process-key"


@pytest.mark.asyncio
async def test_config_service_ensure_initialized_returns_zero_when_env_empty(
    test_session, monkeypatch, tmp_path
):
    monkeypatch.setattr(
        "app.services.config_service._load_process_env_values", dict
    )
    env_path = tmp_path / "provider.env"
    env_path.write_text("# only comments\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_path))

    service = ConfigService(test_session)
    created = await service.ensure_initialized()

    assert created == 0


@pytest.mark.asyncio
async def test_config_service_persists_default_provider_configs(
    test_session, monkeypatch, tmp_path
):
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.delenv("TEXT_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_API_KEY", raising=False)

    service = ConfigService(test_session)
    created = await service.ensure_provider_configs_initialized()

    assert created > 0
    text_provider = await test_session.get(ConfigItem, "TEXT_PROVIDER")
    text_model = await test_session.get(ConfigItem, "TEXT_MODEL")
    image_provider = await test_session.get(ConfigItem, "IMAGE_PROVIDER")
    image_base_url = await test_session.get(ConfigItem, "IMAGE_BASE_URL")
    image_model = await test_session.get(ConfigItem, "IMAGE_MODEL")
    image_endpoint = await test_session.get(ConfigItem, "IMAGE_ENDPOINT")
    enable_i2i = await test_session.get(ConfigItem, "ENABLE_IMAGE_TO_IMAGE")
    video_provider = await test_session.get(ConfigItem, "VIDEO_PROVIDER")
    video_model = await test_session.get(ConfigItem, "VIDEO_MODEL")
    doubao_model = await test_session.get(ConfigItem, "DOUBAO_VIDEO_MODEL")
    tts_enabled = await test_session.get(ConfigItem, "TTS_ENABLED")
    bgm_enabled = await test_session.get(ConfigItem, "BGM_ENABLED")
    database_url = await test_session.get(ConfigItem, "DATABASE_URL")

    assert text_provider is not None
    assert text_provider.value == "anthropic"
    assert text_model is not None
    assert text_model.value == "deepseek-v4-flash"
    assert image_provider is not None
    assert image_provider.value == "modelscope"
    assert image_base_url is not None
    assert image_base_url.value == "https://api-inference.modelscope.cn"
    assert image_model is not None
    assert image_model.value == "Tongyi-MAI/Z-Image-Turbo"
    assert image_endpoint is not None
    assert image_endpoint.value == "/v1/images/generations"
    assert enable_i2i is not None
    assert enable_i2i.value == "true"
    assert video_provider is not None
    assert video_provider.value == "openai"
    assert video_model is not None
    assert video_model.value == "video-gen-1"
    assert doubao_model is not None
    assert doubao_model.value == "doubao-seedance-1-5-pro-251215"
    assert tts_enabled is not None
    assert tts_enabled.value == "true"
    assert bgm_enabled is not None
    assert bgm_enabled.value == "true"
    assert database_url is None


@pytest.mark.asyncio
async def test_config_service_persists_env_provider_configs(
    test_session, monkeypatch, tmp_path
):
    env_path = tmp_path / "provider.env"
    env_path.write_text(
        "TEXT_API_KEY=env-text-key\nVIDEO_MODEL=grok-video-3-10s\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ENV_FILE", str(env_path))

    service = ConfigService(test_session)
    await service.ensure_provider_configs_initialized()

    text_key = await test_session.get(ConfigItem, "TEXT_API_KEY")
    video_model = await test_session.get(ConfigItem, "VIDEO_MODEL")

    assert text_key is not None
    assert text_key.value == "env-text-key"
    assert text_key.is_sensitive is True
    assert video_model is not None
    assert video_model.value == "grok-video-3-10s"


@pytest.mark.asyncio
async def test_config_service_persists_modelscope_image_interface_from_env(
    test_session, monkeypatch, tmp_path
):
    env_path = tmp_path / "provider.env"
    env_path.write_text(
        "\n".join(
            [
                "IMAGE_PROVIDER=modelscope",
                "IMAGE_BASE_URL=https://api-inference.modelscope.cn",
                "IMAGE_API_KEY=ms-test-key",
                "IMAGE_MODEL=Tongyi-MAI/Z-Image-Turbo",
                "IMAGE_ENDPOINT=/v1/images/generations",
                "ENABLE_IMAGE_TO_IMAGE=true",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ENV_FILE", str(env_path))

    service = ConfigService(test_session)
    await service.ensure_provider_configs_initialized()

    expected_values = {
        "IMAGE_PROVIDER": ("modelscope", False),
        "IMAGE_BASE_URL": ("https://api-inference.modelscope.cn", False),
        "IMAGE_API_KEY": ("ms-test-key", True),
        "IMAGE_MODEL": ("Tongyi-MAI/Z-Image-Turbo", False),
        "IMAGE_ENDPOINT": ("/v1/images/generations", False),
        "ENABLE_IMAGE_TO_IMAGE": ("true", False),
    }
    for key, (value, is_sensitive) in expected_values.items():
        item = await test_session.get(ConfigItem, key)
        assert item is not None
        assert item.value == value
        assert item.is_sensitive is is_sensitive


@pytest.mark.asyncio
async def test_config_service_provider_persistence_keeps_existing_db_values(
    test_session, monkeypatch, tmp_path
):
    env_path = tmp_path / "provider.env"
    env_path.write_text("VIDEO_MODEL=env-video-model\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(env_path))
    await create_config_item(test_session, key="VIDEO_MODEL", value="db-video-model")

    service = ConfigService(test_session)
    await service.ensure_provider_configs_initialized()

    video_model = await test_session.get(ConfigItem, "VIDEO_MODEL")
    assert video_model is not None
    assert video_model.value == "db-video-model"


@pytest.mark.asyncio
async def test_config_service_build_settings_overrides_ignores_unknown_keys(test_session):
    await create_config_item(test_session, key="UNKNOWN_KEY", value="value")

    service = ConfigService(test_session)
    overrides = await service.build_settings_overrides()

    assert overrides == {}


@pytest.mark.asyncio
async def test_config_service_upsert_configs_update_skip_and_restart(test_session):
    await create_config_item(test_session, key="IMAGE_API_KEY", value="old", is_sensitive=True)

    service = ConfigService(test_session)
    result = await service.upsert_configs(
        {
            "IMAGE_API_KEY": "new-key",
            "DATABASE_URL": "postgresql://example",
            "SENSITIVE_KEY": "******",
            "": "ignored",
            "NULL_KEY": None,
        }
    )

    assert result.updated == 2
    assert result.skipped == 3
    assert "DATABASE_URL" in result.restart_keys
    assert "IMAGE_API_KEY" not in result.restart_keys

    updated = await test_session.get(ConfigItem, "IMAGE_API_KEY")
    assert updated is not None
    assert updated.value == "new-key"


@pytest.mark.asyncio
async def test_config_service_upsert_configs_from_existing_masked_value_skips_update(test_session):
    await create_config_item(
        test_session, key="SECRET_KEY", value="secret123456", is_sensitive=True
    )

    service = ConfigService(test_session)
    result = await service.upsert_configs({"SECRET_KEY": "secr******3456"})

    assert result.updated == 0
    assert result.skipped == 1


@pytest.mark.asyncio
async def test_upsert_configs_empty_value_deletes_db_row(test_session):
    """空字符串应删除 DB 行（让用户“清除”敏感配置）"""
    await create_config_item(test_session, key="IMAGE_API_KEY", value="old-key", is_sensitive=True)

    service = ConfigService(test_session)
    result = await service.upsert_configs({"IMAGE_API_KEY": ""})

    assert result.updated == 1
    assert result.skipped == 0

    # 验证 DB 行已删除
    item = await test_session.get(ConfigItem, "IMAGE_API_KEY")
    assert item is None


@pytest.mark.asyncio
async def test_upsert_configs_empty_value_no_existing_row_skips(test_session):
    """空字符串且 DB 无记录时应跳过（不创建空记录）"""
    service = ConfigService(test_session)
    result = await service.upsert_configs({"NEW_KEY": ""})

    assert result.updated == 0
    assert result.skipped == 1

    # 验证没有创建记录
    item = await test_session.get(ConfigItem, "NEW_KEY")
    assert item is None
