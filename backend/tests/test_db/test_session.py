from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.db import session as session_module


def test_build_engine_uses_current_settings(monkeypatch):
    fake_settings = SimpleNamespace(database_url="sqlite+aiosqlite:///:memory:", db_echo=True)
    monkeypatch.setattr(session_module, "get_settings", lambda: fake_settings)

    engine = session_module._build_engine()

    assert str(engine.url) == "sqlite+aiosqlite:///:memory:"


@pytest.mark.asyncio
async def test_init_db_runs_schema_check_and_config(monkeypatch):
    calls = {
        "alembic_upgrade": False,
        "ensure_initialized": False,
        "ensure_provider_configs": False,
        "apply_overrides": False,
    }

    class FakeConfigService:
        def __init__(self, session):
            self.session = session

        async def ensure_initialized(self):
            calls["ensure_initialized"] = True

        async def ensure_provider_configs_initialized(self):
            calls["ensure_provider_configs"] = True

        async def apply_settings_overrides(self):
            calls["apply_overrides"] = True

    class FakeResult:
        def scalar_one_or_none(self):
            return None  # No existing templates

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, *args, **kwargs):
            return FakeResult()

        async def commit(self):
            return None

        def add(self, obj):
            pass

    monkeypatch.setattr(session_module, "async_session_maker", lambda: FakeSessionCtx())
    monkeypatch.setattr(session_module, "get_settings", lambda: SimpleNamespace(database_url="sqlite+aiosqlite:///:memory:"))
    monkeypatch.setattr("app.services.config_service.ConfigService", FakeConfigService)
    def fake_alembic_upgrade():
        calls["alembic_upgrade"] = True
    monkeypatch.setattr(session_module, "_run_alembic_upgrade", fake_alembic_upgrade)
    await session_module.init_db()

    assert calls == {
        "alembic_upgrade": True,
        "ensure_initialized": True,
        "ensure_provider_configs": True,
        "apply_overrides": True,
    }


@pytest.mark.asyncio
async def test_get_session_yields_async_session():
    async for session in session_module.get_session():
        assert session is not None
        break
