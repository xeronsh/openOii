from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator
from urllib.parse import urlsplit, urlunsplit

import asyncpg
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver


logger = logging.getLogger(__name__)

_checkpointer_setup_states: dict[str, bool] = {}
_checkpointer_setup_locks: dict[str, asyncio.Lock] = {}

_BOOTSTRAP_STATEMENTS = (
    """CREATE TABLE IF NOT EXISTS checkpoint_migrations (
    v INTEGER PRIMARY KEY
);""",
    """CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);""",
    """CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);""",
    """CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);""",
    "ALTER TABLE checkpoint_blobs ALTER COLUMN blob DROP NOT NULL;",
    "ALTER TABLE checkpoint_writes ADD COLUMN IF NOT EXISTS task_path TEXT NOT NULL DEFAULT '';",
    "CREATE INDEX IF NOT EXISTS checkpoints_thread_id_idx ON checkpoints(thread_id);",
    "CREATE INDEX IF NOT EXISTS checkpoint_blobs_thread_id_idx ON checkpoint_blobs(thread_id);",
    "CREATE INDEX IF NOT EXISTS checkpoint_writes_thread_id_idx ON checkpoint_writes(thread_id);",
)


def _normalize_checkpointer_conn_string(database_url: str) -> str:
    if database_url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + database_url.removeprefix("postgresql+asyncpg://")
    if database_url.startswith("postgres+asyncpg://"):
        return "postgres://" + database_url.removeprefix("postgres+asyncpg://")
    return database_url


def redact_credentials(conn_str: str) -> str:
    """去掉连接串中的账号口令，避免凭据进入日志。"""
    parts = urlsplit(conn_str)
    if not parts.hostname:
        return conn_str
    netloc = parts.hostname
    if parts.username:
        netloc = f"{parts.username}:***@{netloc}"
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


async def ensure_postgres_checkpointer_setup(database_url: str) -> None:
    if not database_url.startswith(("postgres://", "postgresql://", "postgresql+")):
        return

    conn_str = _normalize_checkpointer_conn_string(database_url)
    if _checkpointer_setup_states.get(conn_str):
        return

    lock = _checkpointer_setup_locks.setdefault(conn_str, asyncio.Lock())
    async with lock:
        if _checkpointer_setup_states.get(conn_str):
            return

        logger.debug(
            "ensure_postgres_checkpointer_setup: connecting to %s",
            redact_credentials(conn_str),
        )
        conn = await asyncpg.connect(conn_str)
        try:
            for statement in _BOOTSTRAP_STATEMENTS:
                await conn.execute(statement)
        finally:
            await conn.close()

        _checkpointer_setup_states[conn_str] = True


@asynccontextmanager
async def build_postgres_checkpointer(database_url: str) -> AsyncIterator[object]:
    """Build a run-checkpointer for the configured database URL.

    - postgres URLs → AsyncPostgresSaver (bootstrap via ensure_postgres_checkpointer_setup)
    - sqlite URLs   → AsyncSqliteSaver on the file (checkpoints survive restarts,
      preserving resumability in the zero-container local dev mode)
    - anything else → InMemorySaver (tests / explicit fallback; state is lost on restart)
    """
    if database_url.startswith(("postgres://", "postgresql://", "postgresql+")):
        conn_str = _normalize_checkpointer_conn_string(database_url)
        async with AsyncPostgresSaver.from_conn_string(conn_str) as checkpointer:
            yield checkpointer
        return

    sqlite_path = _sqlite_path_from_url(database_url)
    if sqlite_path is not None:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        async with AsyncSqliteSaver.from_conn_string(sqlite_path) as checkpointer:
            await checkpointer.setup()
            # 与 app 引擎一致：saver 的写锁获取也走 busy_timeout 排队而非立即报错
            try:
                cursor = await checkpointer.conn.execute("PRAGMA busy_timeout=5000")
                await cursor.close()
            except Exception:  # noqa: BLE001 - pragma is best-effort
                logger.debug("sqlite checkpointer busy_timeout pragma failed", exc_info=True)
            yield checkpointer
        return

    yield InMemorySaver()


def _sqlite_path_from_url(database_url: str) -> str | None:
    """Extract the file path from sqlite / sqlite+aiosqlite URLs (None otherwise).

    Memory databases (``sqlite://``, ``:memory:``) intentionally return None so
    callers fall back to the in-memory checkpointer.
    """
    if not database_url.startswith("sqlite"):
        return None
    from sqlalchemy.engine import make_url

    database = make_url(database_url).database
    if not database or database == ":memory:":
        return None
    return database
