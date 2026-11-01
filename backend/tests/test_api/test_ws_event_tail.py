"""WebSocket replay and tail of durable engine events, on a real sandbox SQLite table."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import pytest
import pytest_asyncio
from sqlalchemy import text
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.services.db_change_notifier import db_change_notifier
from tests.test_api.test_websocket import _FakeManager, _patch_ws_app, _ws_handler


class _ScriptedSocket:
    """Stays connected until each step's condition holds, then sends the step's message."""

    def __init__(self, query: dict[str, str], steps: list[tuple[Callable[[], Awaitable[bool]], dict | None]]):
        self.query_params = query
        self.steps = steps
        self.client_state = WebSocketState.CONNECTED

    async def accept(self) -> None:
        return None

    async def receive_json(self) -> dict[str, Any]:
        while self.steps:
            ready, message = self.steps.pop(0)
            for _ in range(150):
                if await ready():
                    break
                await asyncio.sleep(0.02)
            else:
                raise AssertionError("condition never held")
            if message is not None:
                return message
        raise WebSocketDisconnect(code=1000)


@pytest_asyncio.fixture
async def events_db(monkeypatch, test_session, shared_session_maker):
    await test_session.execute(
        text(
            "CREATE TABLE engine_run_events (seq INTEGER PRIMARY KEY, project_id INTEGER, "
            "run_id INTEGER, type TEXT, payload TEXT)"
        )
    )
    await test_session.commit()
    monkeypatch.setattr("app.db.session.async_session_maker", shared_session_maker)
    monkeypatch.setattr(db_change_notifier, "_active", False, raising=False)

    async def add(seq: int, etype: str, payload: Any, project_id: int = 1) -> None:
        body = payload if isinstance(payload, str) else json.dumps(payload)
        await test_session.execute(
            text("INSERT INTO engine_run_events VALUES (:s, :p, 7, :t, :b)"),
            {"s": seq, "p": project_id, "t": etype, "b": body},
        )
        await test_session.commit()

    return add


def _durable(manager: _FakeManager) -> list[tuple[int, str]]:
    return [(e["event_id"], e["type"]) for _, e in manager.events if "event_id" in e]


@pytest.mark.asyncio
async def test_replays_after_the_cursor_and_skips_internal_and_broken_rows(monkeypatch, events_db):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    await events_db(1, "shot_updated", {"shot": {"id": 1}})
    await events_db(2, "shot_updated", {"shot": {"id": 2}})
    await events_db(3, "agent_start", {"agent": "x"})
    await events_db(4, "run_progress", "{not json")
    await events_db(5, "shot_updated", {"shot": {"id": 9}}, project_id=2)
    await events_db(6, "run_progress", {"progress": 0.5})

    async def got_seq6() -> bool:
        return (6, "run_progress") in _durable(manager)

    await _ws_handler()(_ScriptedSocket({"after": "1"}, [(got_seq6, None)]), 1)

    assert _durable(manager) == [(2, "shot_updated"), (6, "run_progress")]
    replayed = next(e for _, e in manager.events if e.get("event_id") == 2)
    assert replayed["data"] == {"shot": {"id": 2}}
    assert manager.events[-1] == (1, {"type": "disconnected", "data": {}})


@pytest.mark.asyncio
async def test_a_new_connection_starts_at_the_head_and_tails_new_rows(monkeypatch, events_db):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    await events_db(1, "shot_updated", {"shot": {"id": 1}})

    async def connected() -> bool:
        if any(e["type"] == "connected" for _, e in manager.events):
            await events_db(2, "shot_updated", {"shot": {"id": 2}})
            return True
        return False

    async def got_seq2() -> bool:
        return bool(_durable(manager))

    await _ws_handler()(_ScriptedSocket({}, [(connected, None), (got_seq2, None)]), 1)

    assert _durable(manager) == [(2, "shot_updated")]


@pytest.mark.asyncio
async def test_a_cursor_past_the_head_is_clamped(monkeypatch, events_db):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    await events_db(1, "shot_updated", {"shot": {"id": 1}})

    async def connected() -> bool:
        if any(e["type"] == "connected" for _, e in manager.events):
            await events_db(2, "shot_updated", {"shot": {"id": 2}})
            return True
        return False

    async def got_seq2() -> bool:
        return bool(_durable(manager))

    # A stale tab that remembers seq 99 from an older database must still see seq 2.
    await _ws_handler()(_ScriptedSocket({"after": "99"}, [(connected, None), (got_seq2, None)]), 1)

    assert _durable(manager) == [(2, "shot_updated")]


@pytest.mark.asyncio
async def test_bad_cursor_and_unhandled_message_report_an_error(monkeypatch, events_db):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)

    async def always() -> bool:
        return True

    class Boom(dict):
        def get(self, *_args, **_kwargs):
            raise ValueError("bad frame")

    await _ws_handler()(_ScriptedSocket({"after": "abc"}, [(always, Boom())]), 1)

    errors = [e for _, e in manager.events if e["type"] == "error"]
    assert errors == [{"type": "error", "data": {"code": "WS_MESSAGE_ERROR", "message": "消息处理失败"}}]


@pytest.mark.asyncio
async def test_missing_events_table_still_connects(monkeypatch, shared_session_maker, caplog):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    monkeypatch.setattr("app.db.session.async_session_maker", shared_session_maker)

    async def connected() -> bool:
        return any(e["type"] == "connected" for _, e in manager.events)

    await _ws_handler()(_ScriptedSocket({}, [(connected, {"type": "ping"})]), 1)

    assert (1, {"type": "pong", "data": {}}) in manager.events
    assert "event watermark unavailable" in caplog.text
