from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Any, get_args, get_origin

from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, apply_settings_overrides as apply_settings_overrides_to_runtime
from app.db.utils import utcnow
from app.models.config_item import ConfigItem

MASK_VALUE = "******"
SENSITIVE_KEY_PARTS = (
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private",
    "database_url",
)
RESTART_REQUIRED_KEYS = {
    "APP_NAME",
    "ENVIRONMENT",
    "LOG_LEVEL",
    "API_V1_PREFIX",
    "CORS_ORIGINS",
    "DATABASE_URL",
    "DB_ECHO",
    "PUBLIC_BASE_URL",
}
RESTART_REQUIRED_PREFIXES = ("DATABASE_",)

SETTINGS_ENV_FIELD_MAP = {name.upper(): name for name in Settings.model_fields}
SETTINGS_DEFAULTS = Settings()
PROVIDER_CONFIG_PREFIXES = (
    "ANTHROPIC_",
    "TEXT_",
    "FAKE_TEXT_",
    "IMAGE_",
    "FAKE_IMAGE_",
    "VIDEO_",
    "DOUBAO_",
    "FAKE_VIDEO_",
)
PROVIDER_CONFIG_KEYS = {
    "ENABLE_IMAGE_TO_IMAGE",
    "ENABLE_IMAGE_TO_VIDEO",
    "TTS_ENABLED",
    "TTS_DEFAULT_VOICE",
    "TTS_VOLUME",
    "BGM_ENABLED",
    "BGM_VOLUME",
    "BGM_DIRECTORY",
}


def _resolve_env_path() -> Path:
    return Path(os.getenv("ENV_FILE", ".env"))


def _strip_inline_comment(value: str) -> str:
    in_single = False
    in_double = False
    for idx, ch in enumerate(value):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            if idx == 0 or value[idx - 1].isspace():
                return value[:idx].rstrip()
    return value


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _load_env_file() -> dict[str, str]:
    path = _resolve_env_path()
    if not path.exists():
        return {}
    data: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = _strip_inline_comment(value.strip())
        value = _unquote(value.strip())
        data[key] = value
    return data




def _load_process_env_values() -> dict[str, str]:
    """Return runtime process env values for known Settings fields only.

    ConfigService historically read .env but ignored variables passed to the
    running process (for example TEXT_PROVIDER=fake uvicorn ...). That made the
    settings UI display stale defaults and test-connection overrides could then
    accidentally blank out an effective runtime value.
    """
    data: dict[str, str] = {}
    for env_key in SETTINGS_ENV_FIELD_MAP:
        value = os.getenv(env_key)
        if value is not None:
            data[env_key] = value
    return data


def _load_effective_env_values() -> dict[str, str]:
    values = _load_env_file()
    values.update(_load_process_env_values())
    return values

def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    if lowered.endswith(("_key", "_token", "_secret", "_password")):
        return True
    return any(part in lowered for part in SENSITIVE_KEY_PARTS)


def mask_value(value: str | None) -> str:
    if not value:
        return MASK_VALUE
    trimmed = value.strip()
    if len(trimmed) <= 8:
        return MASK_VALUE
    return f"{trimmed[:4]}{MASK_VALUE}{trimmed[-4:]}"


def _is_masked_input(value: str, existing_value: str | None) -> bool:
    if value and all(ch == "*" for ch in value):
        return True
    if existing_value:
        return value == mask_value(existing_value)
    return False


def _allows_none(field_type: Any) -> bool:
    return type(None) in get_args(field_type)


def _parse_value(raw: str, field_type: Any) -> Any:
    if raw == "" and _allows_none(field_type):
        return None
    origin = get_origin(field_type)
    if isinstance(raw, str) and origin in (list, dict, set, tuple):
        stripped = raw.strip()
        if stripped:
            try:
                return TypeAdapter(field_type).validate_python(json.loads(stripped))
            except (json.JSONDecodeError, ValueError, TypeError):
                return raw
    adapter = TypeAdapter(field_type)
    try:
        return adapter.validate_python(raw)
    except (ValueError, TypeError):
        pass  # 验证失败，尝试其他解析方式
    if isinstance(raw, str):
        stripped = raw.strip()
        if (stripped.startswith("[") and stripped.endswith("]")) or (
            stripped.startswith("{") and stripped.endswith("}")
        ):
            try:
                return adapter.validate_python(json.loads(stripped))
            except (json.JSONDecodeError, ValueError, TypeError):
                return raw
    return raw


def _requires_restart(key: str) -> bool:
    upper = key.upper()
    if upper in RESTART_REQUIRED_KEYS:
        return True
    return upper.startswith(RESTART_REQUIRED_PREFIXES)


def _is_provider_config_key(key: str) -> bool:
    upper = key.upper()
    return upper in PROVIDER_CONFIG_KEYS or upper.startswith(PROVIDER_CONFIG_PREFIXES)


def _serialize_config_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict, set, tuple)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


@dataclass(slots=True)
class ConfigUpdateResult:
    updated: int
    skipped: int
    restart_keys: list[str]


class ConfigService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def ensure_initialized(self) -> int:
        # Process env wins over .env file (mirrors pydantic-settings precedence
        # in get_settings), so runtime overrides are what gets seeded/persisted.
        env_values = _load_effective_env_values()
        if not env_values:
            return 0
        res = await self.session.execute(select(ConfigItem))
        items = res.scalars().all()
        existing = {item.key: item for item in items}
        created = 0
        for key, value in env_values.items():
            if key in existing:
                continue
            item = ConfigItem(
                key=key,
                value=value,
                is_sensitive=is_sensitive_key(key),
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            self.session.add(item)
            created += 1
        if created:
            await self.session.commit()
        return created

    async def ensure_provider_configs_initialized(self) -> int:
        """Persist reusable generation-provider interface settings into DB.

        Keep the scope to text/image/video/TTS/BGM provider settings. Database,
        Redis, admin and deployment settings stay environment-owned unless the
        user explicitly saves them.
        """
        env_values = _load_effective_env_values()
        res = await self.session.execute(select(ConfigItem))
        existing = {item.key.upper() for item in res.scalars().all()}
        created = 0

        for key in sorted(SETTINGS_ENV_FIELD_MAP):
            if not _is_provider_config_key(key) or key in existing:
                continue

            value = env_values.get(key)
            if value is None:
                field_name = SETTINGS_ENV_FIELD_MAP.get(key)
                default_value = getattr(SETTINGS_DEFAULTS, field_name, None) if field_name else None
                if default_value is None:
                    continue
                value = _serialize_config_value(default_value)

            if value == "":
                continue

            self.session.add(
                ConfigItem(
                    key=key,
                    value=value,
                    is_sensitive=is_sensitive_key(key),
                    created_at=utcnow(),
                    updated_at=utcnow(),
                )
            )
            created += 1

        if created:
            await self.session.commit()
        return created

    async def list_effective(self) -> list[dict[str, Any]]:
        env_values = _load_effective_env_values()
        res = await self.session.execute(select(ConfigItem))
        items = res.scalars().all()
        db_map = {item.key: item for item in items}
        # Include keys from .env, database, AND Settings model defaults
        # so that fields like TEXT_PROVIDER (with a code default but no .env entry)
        # still appear in the config list for the frontend to render.
        settings_keys = set(SETTINGS_ENV_FIELD_MAP.keys())
        keys = sorted(set(env_values) | set(db_map) | settings_keys, key=str.lower)
        results: list[dict[str, Any]] = []
        for key in keys:
            item = db_map.get(key)
            value: str | None
            if item:
                value = item.value
                is_sensitive = item.is_sensitive or is_sensitive_key(key)
                source = "db"
            elif key in env_values:
                value = env_values.get(key)
                is_sensitive = is_sensitive_key(key)
                source = "env"
            else:
                # Fall back to Settings model default
                field_name = SETTINGS_ENV_FIELD_MAP.get(key)
                default_val = getattr(SETTINGS_DEFAULTS, field_name, None) if field_name else None
                value = str(default_val) if default_val is not None else None
                is_sensitive = is_sensitive_key(key)
                source = "default"
            if is_sensitive and value is not None:
                display_value: str | None = mask_value(value)
                is_masked = True
            else:
                display_value = value
                is_masked = False
            results.append(
                {
                    "key": key,
                    "value": display_value,
                    "is_sensitive": is_sensitive,
                    "is_masked": is_masked,
                    "source": source,
                }
            )
        return results

    async def get_raw_value(self, key: str) -> str | None:
        """获取配置项的原始值（未脱敏）"""
        # 先从数据库查找
        res = await self.session.execute(select(ConfigItem).where(ConfigItem.key == key))
        item = res.scalar_one_or_none()
        if item:
            return item.value

        # 回退到 .env 文件
        env_values = _load_effective_env_values()
        return env_values.get(key.upper()) or env_values.get(key)

    async def build_settings_overrides(self) -> dict[str, Any]:
        res = await self.session.execute(select(ConfigItem))
        items = res.scalars().all()
        overrides: dict[str, Any] = {}
        for item in items:
            field_name = SETTINGS_ENV_FIELD_MAP.get(item.key.upper())
            if not field_name:
                continue
            field = Settings.model_fields[field_name]
            overrides[field_name] = _parse_value(item.value, field.annotation)
        return overrides

    async def apply_settings_overrides(self) -> None:
        overrides = await self.build_settings_overrides()
        if overrides:
            apply_settings_overrides_to_runtime(overrides)

    async def upsert_configs(self, configs: dict[str, str | None]) -> ConfigUpdateResult:
        if not configs:
            return ConfigUpdateResult(updated=0, skipped=0, restart_keys=[])
        env_values = _load_env_file()
        keys = [key.strip() for key in configs.keys() if key and key.strip()]
        existing_items: dict[str, ConfigItem] = {}
        if keys:
            res = await self.session.execute(select(ConfigItem).where(ConfigItem.key.in_(keys)))
            existing_items = {item.key: item for item in res.scalars().all()}
        updated_keys: list[str] = []
        deleted_keys: list[str] = []
        skipped = 0
        for raw_key, raw_value in configs.items():
            key = (raw_key or "").strip()
            if not key:
                skipped += 1
                continue
            if raw_value is None:
                skipped += 1
                continue
            value = str(raw_value)
            existing_item = existing_items.get(key)
            effective_value = existing_item.value if existing_item else env_values.get(key)
            is_sensitive = (
                existing_item.is_sensitive if existing_item else False
            ) or is_sensitive_key(key)
            if is_sensitive and _is_masked_input(value, effective_value):
                skipped += 1
                continue
            # 空字符串 → 删除 DB 行（回退到 .env 值或彻底移除）
            if not value and existing_item:
                await self.session.delete(existing_item)
                deleted_keys.append(key)
                continue
            if existing_item:
                existing_item.value = value
                existing_item.is_sensitive = existing_item.is_sensitive or is_sensitive
                existing_item.updated_at = utcnow()
                self.session.add(existing_item)
            else:
                # 空字符串且 DB 无记录 → 跳过（不创建空记录）
                if not value:
                    skipped += 1
                    continue
                self.session.add(
                    ConfigItem(
                        key=key,
                        value=value,
                        is_sensitive=is_sensitive,
                        created_at=utcnow(),
                        updated_at=utcnow(),
                    )
                )
            updated_keys.append(key)
        if updated_keys or deleted_keys:
            await self.session.commit()
        all_changed = updated_keys + deleted_keys
        restart_keys = [key for key in all_changed if _requires_restart(key)]
        return ConfigUpdateResult(
            updated=len(updated_keys) + len(deleted_keys),
            skipped=skipped,
            restart_keys=restart_keys,
        )
