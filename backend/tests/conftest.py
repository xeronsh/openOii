from __future__ import annotations

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

import pytest  # noqa: E402
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


@pytest.fixture(scope="session")
def test_settings() -> Settings:
    return Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_provider="anthropic",
        image_provider="openai",
        video_provider="openai",
        anthropic_api_key="test-key",
        image_api_key="test-key",
        video_api_key="test-key",
    )


class StubWsManager:
    def __init__(self) -> None:
        self.events: list[tuple[int, dict]] = []

    async def send_event(self, project_id: int, event: dict) -> None:
        self.events.append((project_id, event))


@pytest_asyncio.fixture(scope="function")
async def test_db_engine_sessionmaker(
    tmp_path: Path,
) -> AsyncGenerator[tuple, None]:
    """Function-scoped sqlite engine + sessionmaker.

    Shared between test_session (for direct DB writes) and closure_app
    (for route-level async_session_maker patching) so both layers see the
    same data.
    """
    db_path = tmp_path / "test.db"
    database_url = f"sqlite+aiosqlite:///{db_path}"
    engine = create_async_engine(database_url, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        yield engine, session_maker
    finally:
        await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def test_session(test_db_engine_sessionmaker) -> AsyncGenerator[AsyncSession, None]:
    _, session_maker = test_db_engine_sessionmaker
    async with session_maker() as session:
        yield session


@pytest.fixture()
def shared_session_maker(test_db_engine_sessionmaker):
    """Sessionmaker shared with test_session.

    Used by closure_app fixture to patch route-level async_session_maker
    so route _task() closures hit the same sqlite db as test_session.
    """
    _, session_maker = test_db_engine_sessionmaker
    return session_maker


@pytest_asyncio.fixture(scope="function")
async def checkpoint_sessionmaker(
    tmp_path: Path,
) -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    database_url = os.environ.get("TEST_CHECKPOINT_DATABASE_URL")
    if not database_url:
        database_url = f"sqlite+aiosqlite:///{tmp_path / 'checkpoint.db'}"

    engine = create_async_engine(database_url, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        yield session_maker
    finally:
        await engine.dispose()


@pytest.fixture()
def ws_manager() -> StubWsManager:
    return StubWsManager()


@pytest.fixture(autouse=True)
def _no_real_engine(monkeypatch):
    """测试绝不允许真的拉起 pi 引擎 sidecar（子进程 + 真 LLM + 真媒体）。

    路由现在总是经 loopback HTTP 派发；默认把它们换成 no-op stub，
    需要验证派发契约的测试可在自己的 fixture 里覆盖。
    """
    from app.api.v1.routes import generation as generation_routes

    async def _ensure(base_url, database_url, static_dir):
        return None

    async def _start(base_url, **kwargs):
        return {"status": "running"}

    async def _resume(base_url, **kwargs):
        return {"status": "running"}

    async def _cancel(base_url, run_id):
        return None

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _ensure)
    monkeypatch.setattr(generation_routes, "engine_start_run", _start)
    monkeypatch.setattr(generation_routes, "engine_resume_run", _resume)
    monkeypatch.setattr(generation_routes, "engine_cancel_run", _cancel)


@pytest_asyncio.fixture(scope="function")
async def app(test_session: AsyncSession, test_settings: Settings, ws_manager: StubWsManager):
    app = create_app()

    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield test_session

    async def override_get_settings() -> Settings:
        return test_settings

    async def override_get_ws() -> StubWsManager:
        return ws_manager

    async def override_require_admin() -> None:
        return None

    app.dependency_overrides[get_db_session] = override_get_session
    app.dependency_overrides[get_app_settings] = override_get_settings
    app.dependency_overrides[get_ws_manager] = override_get_ws
    app.dependency_overrides[require_admin] = override_require_admin
    return app


@pytest_asyncio.fixture(scope="function")
async def async_client(app):
    transport = ASGITransport(app=app)

    class _AsyncClientWithYield(AsyncClient):
        async def request(self, *args, **kwargs):
            loop = asyncio.get_running_loop()
            task = loop.create_task(super().request(*args, **kwargs))
            # ASGITransport + body-carrying requests can deadlock on this runtime
            # unless the request coroutine gets at least one scheduling slice.
            await asyncio.sleep(0.01)
            return await task

    async with _AsyncClientWithYield(transport=transport, base_url="http://test") as client:
        yield client


@asynccontextmanager
async def _no_lifespan(_: object):
    yield


@pytest.fixture()
def ws_client(app):
    app.router.lifespan_context = _no_lifespan
    return TestClient(app)
