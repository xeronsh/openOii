from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import WebSocket
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app import main as main_module
from app.schemas.project import RecoverySummaryRead
from app.ws.manager import ws_manager


class _FakeWebSocket:
    client_state = WebSocketState.CONNECTED

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class _InboundWebSocket:
    def __init__(self, messages: list[dict[str, Any]]) -> None:
        self.messages = messages
        self.accepted = False
        self.client_state = WebSocketState.CONNECTED
        self.application_state = WebSocketState.CONNECTED

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> dict[str, Any]:
        if not self.messages:
            raise WebSocketDisconnect(code=1000)
        return self.messages.pop(0)

    async def send_json(self, _payload: dict[str, Any]) -> None:
        return None


class _FakeManager:
    def __init__(self) -> None:
        self.events: list[tuple[int, dict[str, Any]]] = []

    async def connect(self, project_id: int, websocket: _InboundWebSocket) -> None:
        await websocket.accept()

    async def disconnect(self, project_id: int, websocket: _InboundWebSocket) -> None:
        self.events.append((project_id, {"type": "disconnected", "data": {}}))

    async def send_event(self, project_id: int, event: dict[str, Any]) -> None:
        self.events.append((project_id, event))


class _Result:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def scalars(self) -> "_Result":
        return self

    def all(self) -> list[Any]:
        return self._rows


class _SessionContext:
    def __init__(self, rows: list[Any]) -> None:
        self._result = _Result(rows)

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def execute(self, _statement: Any) -> _Result:
        return self._result


def _patch_ws_app(monkeypatch: pytest.MonkeyPatch, manager: _FakeManager) -> None:
    monkeypatch.setattr(main_module, "ws_manager", manager)
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_name="openOii",
            cors_origins=[],
            api_v1_prefix="/api/v1",
            environment="development",
        ),
    )


def _ws_handler():
    app = main_module.create_app()
    return next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )


@pytest.mark.asyncio
async def test_websocket_ping_echo(monkeypatch):
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    monkeypatch.setattr("app.db.session.async_session_maker", lambda: _SessionContext([]))

    fake_ws = _InboundWebSocket(
        [{"type": "ping"}, {"type": "echo", "data": {"hello": "world"}}]
    )

    await _ws_handler()(fake_ws, 1)

    assert fake_ws.accepted is True
    assert (1, {"type": "connected", "data": {"project_id": 1}}) in manager.events
    assert (1, {"type": "pong", "data": {}}) in manager.events
    assert (1, {"type": "echo", "data": {"hello": "world"}}) in manager.events


@pytest.mark.asyncio
async def test_websocket_manager_enriches_recovery_payloads():
    fake_ws = _FakeWebSocket()
    ws_manager._conns.clear()
    ws_manager._conns[1].add(cast(WebSocket, cast(object, fake_ws)))

    await ws_manager.send_event(
        1,
        {
            "type": "run_awaiting_confirm",
            "data": {
                "run_id": 7,
                "project_id": 1,
                "agent": "plan",
                "gate": "plan",
                "current_stage": "script",
                "stage": "script",
                "next_stage": "character",
                "preserved_stages": ["ideate"],
                "recovery_summary": {
                    "project_id": 1,
                    "run_id": 7,
                    "thread_id": "agent-run-7",
                    "current_stage": "script",
                    "next_stage": "character",
                    "preserved_stages": ["ideate"],
                    "stage_history": [
                        {"name": "ideate", "status": "completed", "artifact_count": 2},
                        {"name": "script", "status": "current", "artifact_count": 1},
                        {"name": "character", "status": "pending", "artifact_count": 0},
                    ],
                    "resumable": True,
                },
                "message": "ready",
                "completed": "scriptwriter done",
                "next_step": "continue",
                "question": "continue?",
            },
        },
    )

    payload = fake_ws.sent[0]
    data = cast(dict[str, Any], payload["data"])
    recovery_summary = cast(dict[str, Any], data["recovery_summary"])
    assert payload["type"] == "run_awaiting_confirm"
    assert recovery_summary["next_stage"] == "character"
    assert data["current_stage"] == "script"


@pytest.mark.asyncio
async def test_websocket_connection_replays_awaiting_payload(monkeypatch):
    project_id = 1
    run_id = 42

    async def fake_get_awaiting_payload(candidate_run_id: int) -> dict[str, Any] | None:
        if candidate_run_id == run_id:
            return {
                "run_id": run_id,
                "project_id": project_id,
                "agent": "director",
                "gate": "director",
                "current_stage": "ideate",
                "recovery_summary": RecoverySummaryRead(
                    project_id=project_id,
                    run_id=run_id,
                    thread_id=f"agent-run-{run_id}",
                    current_stage="ideate",
                    next_stage="script",
                    preserved_stages=["ideate"],
                    stage_history=[],
                    resumable=True,
                ).model_dump(mode="json"),
            }
        return None

    monkeypatch.setattr("app.services.run_signals.get_awaiting_payload", fake_get_awaiting_payload)
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    monkeypatch.setattr(
        "app.db.session.async_session_maker",
        lambda: _SessionContext([type("Run", (), {"id": run_id, "project_id": project_id})()]),
    )

    await _ws_handler()(_InboundWebSocket([]), project_id)

    events = [event for _, event in manager.events]
    assert events[0]["type"] == "connected"
    assert events[1]["type"] == "run_awaiting_confirm"
    assert events[1]["data"]["run_id"] == run_id
    assert events[1]["data"]["gate"] == "director"


@pytest.mark.asyncio
async def test_websocket_connection_replays_run_progress_for_non_awaiting_run(monkeypatch):
    project_id = 2
    run_id = 99

    async def fake_get_awaiting_payload(candidate_run_id: int) -> dict[str, Any] | None:
        return None

    monkeypatch.setattr("app.services.run_signals.get_awaiting_payload", fake_get_awaiting_payload)
    manager = _FakeManager()
    _patch_ws_app(monkeypatch, manager)
    monkeypatch.setattr(
        "app.db.session.async_session_maker",
        lambda: _SessionContext(
            [
                type(
                    "Run",
                    (),
                    {
                        "id": run_id,
                        "project_id": project_id,
                        "current_agent": "character",
                        "progress": 0.65,
                    },
                )()
            ]
        ),
    )

    await _ws_handler()(_InboundWebSocket([]), project_id)

    events = [event for _, event in manager.events]
    assert events[0]["type"] == "connected"
    assert events[1]["type"] == "run_progress"
    assert events[1]["data"]["run_id"] == run_id
    assert events[1]["data"]["current_agent"] == "character"
    assert events[1]["data"]["progress"] == 0.65


@pytest.mark.asyncio
async def test_websocket_manager_scopes_project_updated_events_to_project_connections():
    fake_ws_1 = _FakeWebSocket()
    fake_ws_2 = _FakeWebSocket()
    ws_manager._conns.clear()
    ws_manager._conns[1].add(cast(WebSocket, cast(object, fake_ws_1)))
    ws_manager._conns[2].add(cast(WebSocket, cast(object, fake_ws_2)))

    await ws_manager.send_event(
        1,
        {
            "type": "project_updated",
            "data": {
                "project": {
                    "id": 1,
                    "title": "Realtime Story",
                    "video_url": "https://cdn.example.com/final.mp4",
                },
            },
        },
    )

    assert len(fake_ws_1.sent) == 1
    payload = fake_ws_1.sent[0]
    data = cast(dict[str, Any], payload["data"])
    project = cast(dict[str, Any], data["project"])
    assert payload["type"] == "project_updated"
    assert project["id"] == 1
    assert project["video_url"] == "https://cdn.example.com/final.mp4"
    assert fake_ws_2.sent == []


@pytest.mark.asyncio
async def test_websocket_manager_rejects_invalid_project_updated_payload():
    ws_manager._conns.clear()

    with pytest.raises(ValidationError):
        await ws_manager.send_event(
            1,
            {
                "type": "project_updated",
                "data": {
                    "project": {
                        "video_url": "https://cdn.example.com/final.mp4",
                    },
                },
            },
        )


@pytest.mark.asyncio
async def test_websocket_manager_rejects_invalid_outbound_payload():
    ws_manager._conns.clear()

    with pytest.raises(ValidationError):
        await ws_manager.send_event(
            1,
            {
                "type": "run_progress",
                "data": {
                    "run_id": 7,
                    "current_stage": "script",
                },
            },
        )
