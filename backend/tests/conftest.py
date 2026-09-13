from __future__ import annotations

# The test database URL must be injected before importing app.db.session because
# that module constructs its global engine/maker at import time.
# ruff: noqa: E402

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

# Must run before any app.db.session import: the global engine/maker is built
# from Settings(.env) at import time. Without this, unpatched production paths
# (WS replay, export cache, run confirm signal) would open the real
# data/openoii.db from tests and leak handles.
_TEST_GLOBAL_DB = Path(__file__).resolve().parent / "test-global-sandbox.db"
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TEST_GLOBAL_DB}")

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

from app.api.deps import get_app_settings, get_db_session, get_ws_manager, require_admin
from app.config import Settings
from app.main import create_app
from app.models import agent_run, artifact, message, project, run, stage, style_template  # noqa: F401


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
def _cleanup_global_sandbox_db():
    yield
    _TEST_GLOBAL_DB.unlink(missing_ok=True)


@pytest_asyncio.fixture
async def db_session(tmp_path: Path) -> AsyncGenerator[AsyncSession, None]:
    db_path = tmp_path / "test.db"
    test_engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        yield session
    await test_engine.dispose()


class _DummyWsManager:
    def __init__(self) -> None:
        self.events: list[tuple[int, dict]] = []

    async def send_event(self, project_id: int, event: dict) -> None:
        self.events.append((project_id, event))

    async def send_event_to(self, _websocket, event: dict) -> None:
        self.events.append((-1, event))


@pytest.fixture
def ws_manager() -> _DummyWsManager:
    return _DummyWsManager()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'app.db'}",
        text_provider="fake",
        image_provider="fake",
        video_provider="fake",
        tts_enabled=False,
        bgm_enabled=False,
    )


@pytest.fixture
def app(db_session: AsyncSession, settings: Settings, ws_manager: _DummyWsManager):
    application = create_app()

    async def _get_session_override():
        yield db_session

    application.dependency_overrides[get_db_session] = _get_session_override
    application.dependency_overrides[get_app_settings] = lambda: settings
    application.dependency_overrides[get_ws_manager] = lambda: ws_manager
    application.dependency_overrides[require_admin] = lambda: None
    return application


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


@pytest_asyncio.fixture
async def async_client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
