from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import app.orchestration.persistence as persistence_module
from app.orchestration.persistence import (
    _normalize_checkpointer_conn_string,
    build_postgres_checkpointer,
    ensure_postgres_checkpointer_setup,
)


# --- _normalize_checkpointer_conn_string ---


def test_normalize_asyncpg_postgresql():
    url = "postgresql+asyncpg://user:pass@host:5432/db"
    assert _normalize_checkpointer_conn_string(url) == "postgresql://user:pass@host:5432/db"


def test_normalize_asyncpg_postgres():
    url = "postgres+asyncpg://user:pass@host:5432/db"
    assert _normalize_checkpointer_conn_string(url) == "postgres://user:pass@host:5432/db"


def test_normalize_non_asyncpg():
    url = "sqlite:///test.db"
    assert _normalize_checkpointer_conn_string(url) == "sqlite:///test.db"


def test_normalize_postgresql_no_asyncpg():
    url = "postgresql://user:pass@host:5432/db"
    assert _normalize_checkpointer_conn_string(url) == "postgresql://user:pass@host:5432/db"


# --- build_postgres_checkpointer ---


@pytest.mark.asyncio
async def test_build_postgres_checkpointer_sqlite_file(tmp_path):
    """File-backed sqlite URL yields a persistent AsyncSqliteSaver."""
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    db_path = tmp_path / "checkpoint.db"
    async with build_postgres_checkpointer(f"sqlite+aiosqlite:///{db_path}") as cp:
        assert isinstance(cp, AsyncSqliteSaver)
    assert db_path.exists()


@pytest.mark.asyncio
async def test_build_postgres_checkpointer_memory_urls_fall_back_to_in_memory(tmp_path):
    """Memory sqlite URLs and unknown schemes yield InMemorySaver."""
    from langgraph.checkpoint.memory import InMemorySaver

    async with build_postgres_checkpointer("sqlite://") as cp:
        assert isinstance(cp, InMemorySaver)
    async with build_postgres_checkpointer("redis://localhost:6379/0") as cp:
        assert isinstance(cp, InMemorySaver)


# --- ensure_postgres_checkpointer_setup ---


@pytest.mark.asyncio
async def test_ensure_postgres_checkpointer_setup_non_postgres():
    """Non-postgres URL should return early."""
    await ensure_postgres_checkpointer_setup("sqlite:///test.db")


@pytest.mark.asyncio
async def test_ensure_postgres_checkpointer_setup_already_done():
    """Should return early if already set up."""
    url = "postgresql://user:pass@host/db"
    persistence_module._checkpointer_setup_states[url] = True
    try:
        mock_connect = AsyncMock()
        with patch.object(persistence_module, "asyncpg") as mock_asyncpg:
            mock_asyncpg.connect = mock_connect
            await ensure_postgres_checkpointer_setup(url)
        mock_connect.assert_not_called()
    finally:
        del persistence_module._checkpointer_setup_states[url]


@pytest.mark.asyncio
async def test_ensure_postgres_checkpointer_setup_connects_and_bootstrap():
    """Should connect, run bootstrap, and mark done."""
    url = "postgresql://user:pass@host/testdb"
    # Clear any previous state
    persistence_module._checkpointer_setup_states.pop(url, None)

    mock_conn = AsyncMock()
    mock_asyncpg_module = SimpleNamespace(connect=AsyncMock(return_value=mock_conn))
    with patch.object(persistence_module, "asyncpg", mock_asyncpg_module):
        await ensure_postgres_checkpointer_setup(url)

    assert mock_asyncpg_module.connect.call_count == 1
    assert mock_conn.execute.call_count == len(persistence_module._BOOTSTRAP_STATEMENTS)
    mock_conn.close.assert_awaited_once()
    assert persistence_module._checkpointer_setup_states.get(url) is True
    # Cleanup
    del persistence_module._checkpointer_setup_states[url]
