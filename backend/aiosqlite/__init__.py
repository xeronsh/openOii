"""
Minimal aiosqlite-compatible shim.

This environment runs Python 3.14 and the upstream aiosqlite build available
here can deadlock under asyncio. To keep `sqlite+aiosqlite` usable for tests,
we provide a small subset of the aiosqlite API that SQLAlchemy relies on.

Implementation notes:
- Raw sqlite3 calls run in worker threads via `asyncio.to_thread` so a
  `busy_timeout` wait never blocks the event loop (a blocking busy-wait on the
  loop thread self-deadlocks: the lock holder can never run to release it).
- Connections are opened with check_same_thread=False accordingly.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

# Re-export DBAPI attributes expected by SQLAlchemy's aiosqlite dialect.
DatabaseError = sqlite3.DatabaseError
Error = sqlite3.Error
IntegrityError = sqlite3.IntegrityError
NotSupportedError = sqlite3.NotSupportedError
OperationalError = sqlite3.OperationalError
ProgrammingError = sqlite3.ProgrammingError
sqlite_version = sqlite3.sqlite_version
sqlite_version_info = sqlite3.sqlite_version_info


class Cursor:
    def __init__(self, conn: "Connection", _pending: tuple | None = None) -> None:
        self._conn = conn
        self._cursor: sqlite3.Cursor | None = None
        self._closed = False
        # Pending operation driven by __await__/__aenter__ (aiosqlite protocol:
        # Connection.cursor/execute/executescript are sync and return a proxy).
        self._pending = _pending

        self.arraysize = 1
        self.rowcount = -1
        self.lastrowid = -1
        self.description = None

    async def __aenter__(self) -> "Cursor":
        await self._run_pending()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    def __await__(self):
        return self._run_pending().__await__()

    async def _run_pending(self) -> "Cursor":
        await self._ensure_cursor()
        if self._pending is not None:
            kind = self._pending[0]
            if kind == "execute":
                _, operation, parameters = self._pending
                assert self._cursor is not None
                if parameters is None:
                    await asyncio.to_thread(self._cursor.execute, operation)
                else:
                    await asyncio.to_thread(self._cursor.execute, operation, parameters)
            elif kind == "executescript":
                _, script = self._pending
                assert self._cursor is not None
                await asyncio.to_thread(self._cursor.executescript, script)
            self._pending = None
            self.description = self._cursor.description
            self.rowcount = self._cursor.rowcount
            self.lastrowid = self._cursor.lastrowid
        return self

    async def _ensure_cursor(self) -> None:
        await self._conn._open()
        if self._cursor is None:
            assert self._conn._conn is not None
            self._cursor = await asyncio.to_thread(self._conn._conn.cursor)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._cursor is not None:
            cursor, self._cursor = self._cursor, None
            await asyncio.to_thread(cursor.close)

    async def execute(self, operation: Any, parameters: Optional[Sequence[Any]] = None) -> Any:
        await self._ensure_cursor()
        assert self._cursor is not None

        if parameters is None:
            await asyncio.to_thread(self._cursor.execute, operation)
        else:
            await asyncio.to_thread(self._cursor.execute, operation, parameters)

        self.description = self._cursor.description
        self.rowcount = self._cursor.rowcount
        self.lastrowid = self._cursor.lastrowid
        return self

    async def executemany(self, operation: Any, parameters: Iterable[Sequence[Any]]) -> Any:
        await self._ensure_cursor()
        assert self._cursor is not None

        await asyncio.to_thread(self._cursor.executemany, operation, list(parameters))
        self.description = self._cursor.description
        self.rowcount = self._cursor.rowcount
        self.lastrowid = self._cursor.lastrowid
        return self

    async def fetchone(self) -> Any:
        await self._ensure_cursor()
        assert self._cursor is not None
        return await asyncio.to_thread(self._cursor.fetchone)

    async def fetchmany(self, size: Optional[int] = None) -> list[Any]:
        await asyncio.sleep(0)
        await self._ensure_cursor()
        assert self._cursor is not None
        n = self.arraysize if size is None else size
        return await asyncio.to_thread(self._cursor.fetchmany, n)

    async def fetchall(self) -> list[Any]:
        await self._ensure_cursor()
        assert self._cursor is not None
        return await asyncio.to_thread(self._cursor.fetchall)

    async def setinputsizes(self, sizes: Sequence[Any]) -> None:
        await asyncio.sleep(0)
        return None

    def setoutputsize(self, size: Any, column: Any) -> None:
        return None

    async def callproc(self, procname: str, parameters: Sequence[Any] = ()) -> Any:
        raise NotSupportedError("callproc is not supported for sqlite")

    async def nextset(self) -> Optional[bool]:
        await asyncio.sleep(0)
        return None

    async def __aiter__(self):
        # sqlite3 results are already materialized client-side; expose them
        # through the async iteration protocol SQLAlchemy's async cursor relies on.
        await self._ensure_cursor()
        assert self._cursor is not None
        rows = await asyncio.to_thread(self._cursor.fetchall)
        for row in rows:
            yield row


class Connection:
    # SQLAlchemy sets this attribute on the object returned by connect().
    daemon: bool = False

    def __init__(self, connector) -> None:
        self._connector = connector
        self._conn: sqlite3.Connection | None = None

    def __await__(self):
        return self._open().__await__()

    async def __aenter__(self) -> "Connection":
        return await self._open()

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()

    async def _open(self) -> "Connection":
        if self._conn is None:
            self._conn = await asyncio.to_thread(self._connector)
        return self

    def cursor(self, *args: Any, **kwargs: Any) -> Cursor:
        # Sync per the aiosqlite protocol: the returned proxy runs lazily via
        # __await__/__aenter__ (SQLAlchemy's await_() and the engine's
        # `async with conn.cursor()` both work against this).
        return Cursor(self)

    def execute(self, operation: Any, parameters: Optional[Sequence[Any]] = None) -> Cursor:
        return Cursor(self, _pending=("execute", operation, parameters))

    def executescript(self, script: str) -> Cursor:
        return Cursor(self, _pending=("executescript", script))

    async def create_function(self, *args: Any, **kwargs: Any) -> None:
        await self._open()
        assert self._conn is not None
        await asyncio.to_thread(self._conn.create_function, *args, **kwargs)

    async def commit(self) -> None:
        await self._open()
        assert self._conn is not None
        await asyncio.to_thread(self._conn.commit)

    async def rollback(self) -> None:
        await self._open()
        assert self._conn is not None
        await asyncio.to_thread(self._conn.rollback)

    async def close(self) -> None:
        if self._conn is None:
            return
        conn, self._conn = self._conn, None
        await asyncio.to_thread(conn.close)

    def __getattr__(self, key: str) -> Any:
        if self._conn is None:
            raise AttributeError(key)
        return getattr(self._conn, key)


def connect(
    database: str | Path,
    *,
    iter_chunk_size: int = 64,  # kept for compatibility, unused
    loop: Any | None = None,  # kept for compatibility, unused
    **kwargs: Any,
) -> Connection:
    if isinstance(database, str):
        loc = database
    else:
        loc = str(database)

    def _connector() -> sqlite3.Connection:
        # Driver-level autocommit: transactions are explicit (SQLAlchemy emits
        # BEGIN IMMEDIATE; cross-process writes become short autocommit
        # statements). Avoids deferred read→write upgrades that fail instantly
        # with "database is locked" under concurrency.
        kwargs.setdefault("check_same_thread", False)
        return sqlite3.connect(loc, **kwargs)

    return Connection(_connector)


__all__ = [
    "connect",
    "Connection",
    "Cursor",
    "DatabaseError",
    "Error",
    "IntegrityError",
    "NotSupportedError",
    "OperationalError",
    "ProgrammingError",
    "sqlite_version",
    "sqlite_version_info",
]

