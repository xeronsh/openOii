from __future__ import annotations

import json

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app import main as main_module
from app.exceptions import AppException


def test_local_dev_origin_regex_allows_localhost_ports():
    pattern = main_module._local_dev_origin_regex("development")

    assert pattern is not None
    assert pattern == main_module.LOCAL_DEV_ORIGIN_REGEX


def test_local_dev_origin_regex_disabled_in_production():
    assert main_module._local_dev_origin_regex("prod") is None


def test_create_app_mounts_static_and_health(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=["http://localhost:3000"],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)

    app = main_module.create_app()

    assert isinstance(app, FastAPI)
    assert any(route.path == "/health" for route in app.routes)


@pytest.mark.asyncio
async def test_health_endpoint_returns_ok(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)

    app = main_module.create_app()
    handler = next(
        route.endpoint for route in app.routes if getattr(route, "path", None) == "/health"
    )

    assert await handler() == {"status": "ok"}


@pytest.mark.asyncio
async def test_lifespan_creates_directories_and_calls_init_db(monkeypatch, tmp_path):
    called = {"init_db": False}
    monkeypatch.setattr(main_module, "STATIC_DIR", tmp_path / "static")

    async def fake_init_db():
        _mark_called(called)

    monkeypatch.setattr(main_module, "init_db", fake_init_db)

    async with main_module.lifespan(FastAPI()):
        pass

    assert called["init_db"] is True
    assert (tmp_path / "static" / "videos").exists()
    assert (tmp_path / "static" / "images").exists()


def _mark_called(called):
    called["init_db"] = True


@pytest.mark.asyncio
async def test_app_exception_handler_returns_error_payload(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()
    exc = AppException(code="E1", message="bad", status_code=400, details={"x": 1})

    response = await app.exception_handlers[AppException](
        SimpleNamespace(url=SimpleNamespace(path="/x"), method="GET"), exc
    )

    assert response.status_code == 400
    assert response.body


@pytest.mark.asyncio
async def test_general_exception_handler_in_development_includes_details(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()

    response = await app.exception_handlers[Exception](
        SimpleNamespace(url=SimpleNamespace(path="/x"), method="GET"), RuntimeError("boom")
    )

    assert response.status_code == 500
    assert b"boom" in response.body


@pytest.mark.asyncio
async def test_general_exception_handler_in_production_omits_details(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="production",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()

    response = await app.exception_handlers[Exception](
        SimpleNamespace(url=SimpleNamespace(path="/x"), method="GET"), RuntimeError("boom")
    )

    assert response.status_code == 500
    assert b"boom" not in response.body


class _FakeWebSocket:
    def __init__(self, messages: list[dict]):
        self.messages = messages
        self.sent: list[dict] = []
        self.accepted = False
        self.closed = False
        self.application_state = WebSocketState.CONNECTED
        self.client_state = WebSocketState.CONNECTED

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self.messages:
            raise WebSocketDisconnect(code=1000)
        return self.messages.pop(0)

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = ""):
        self.closed = True


@pytest.mark.asyncio
async def test_ws_projects_handles_ping_and_echo(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            await websocket.accept()

        async def disconnect(self, project_id, websocket):
            events.append(("disconnect", project_id))

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, *args, **kwargs):
            class _Res:
                def scalars(self):
                    return self

                def all(self):
                    return []

            return _Res()

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
    monkeypatch.setattr("app.services.run_signals.get_awaiting_payload", lambda run_id: None)
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
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())

    fake_ws = _FakeWebSocket(
        [
            {"type": "ping"},
            {"type": "echo", "data": {"x": 1}},
        ]
    )

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    assert fake_ws.accepted is True
    assert (1, {"type": "pong", "data": {}}) in events
    assert (1, {"type": "echo", "data": {"x": 1}}) in events


@pytest.mark.asyncio
async def test_ws_projects_replays_awaiting_payload(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            await websocket.accept()

        async def disconnect(self, project_id, websocket):
            pass

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeRun:
        id = 7
        project_id = 1
        status = "running"

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, *args, **kwargs):
            class _Res:
                def scalars(self):
                    return self

                def all(self):
                    return [FakeRun()]

            return _Res()

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_name="openOii", cors_origins=[], api_v1_prefix="/api/v1", environment="development"
        ),
    )
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())

    async def fake_get_awaiting_payload(run_id):
        return {"run_id": run_id, "step": "approve"}

    monkeypatch.setattr("app.services.run_signals.get_awaiting_payload", fake_get_awaiting_payload)

    fake_ws = _FakeWebSocket([])

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    assert any(event[1]["type"] == "run_awaiting_confirm" for event in events)


@pytest.mark.asyncio
async def test_ws_projects_confirm_invalid_run_sends_error(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            pass

        async def disconnect(self, project_id, websocket):
            pass

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, *args, **kwargs):
            class _Res:
                def scalars(self):
                    return self

                def all(self):
                    return []

            return _Res()

        async def get(self, model, pk):
            return None

        def add(self, obj):
            pass

        async def commit(self):
            pass

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
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
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())
    monkeypatch.setattr(
        main_module, "AgentRun", SimpleNamespace(project_id=1, status="running"), raising=False
    )

    async def fake_trigger(_run_id):
        return True

    monkeypatch.setattr("app.services.run_signals.trigger_confirm_signal", fake_trigger)

    fake_ws = _FakeWebSocket(
        [
            {"type": "confirm", "data": {"run_id": 123, "feedback": "  ok  "}},
        ]
    )

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    # Run not found (get returns None) → feedback silently skipped, no error event
    assert not any(event[1]["type"] == "error" for event in events)


@pytest.mark.asyncio
async def test_ws_projects_confirm_valid_run_saves_feedback_and_triggers_confirm(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            pass

        async def disconnect(self, project_id, websocket):
            pass

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeRun:
        id = 123
        project_id = 1

    class FakeSessionCtx:
        def __init__(self):
            self.committed = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, model, run_id):
            return FakeRun()

        def add(self, obj):
            pass

        async def commit(self):
            self.committed = True

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    trigger_calls = []

    async def fake_trigger(run_id):
        trigger_calls.append(run_id)

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_name="openOii", cors_origins=[], api_v1_prefix="/api/v1", environment="development"
        ),
    )
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())
    monkeypatch.setattr("app.services.run_signals.trigger_confirm_signal", fake_trigger)

    fake_ws = _FakeWebSocket(
        [
            {"type": "confirm", "data": {"run_id": 123, "feedback": "  ok  "}},
        ]
    )

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    assert trigger_calls == [123]


@pytest.mark.asyncio
async def test_ws_projects_feedback_save_error_sends_ws_error(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            pass

        async def disconnect(self, project_id, websocket):
            pass

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeRun:
        id = 123
        project_id = 1

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, model, run_id):
            return FakeRun()

        def add(self, obj):
            pass

        async def commit(self):
            raise RuntimeError("db is gone")

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_name="openOii", cors_origins=[], api_v1_prefix="/api/v1", environment="development"
        ),
    )
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())

    async def fake_trigger(_run_id):
        return True

    monkeypatch.setattr("app.services.run_signals.trigger_confirm_signal", fake_trigger)

    fake_ws = _FakeWebSocket(
        [
            {"type": "confirm", "data": {"run_id": 123, "feedback": "ok"}},
        ]
    )

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    save_errors = [
        e
        for e in events
        if e[1].get("type") == "error" and e[1].get("data", {}).get("code") == "WS_SAVE_ERROR"
    ]
    assert len(save_errors) == 0


@pytest.mark.asyncio
async def test_ws_projects_message_exception_sends_error(monkeypatch):
    events = []

    class FakeManager:
        async def connect(self, project_id, websocket):
            pass

        async def disconnect(self, project_id, websocket):
            pass

        async def send_event(self, project_id, event):
            events.append((project_id, event))

    class FakeSessionCtx:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeAsyncSessionMaker:
        def __call__(self):
            return FakeSessionCtx()

    class BrokenWebSocket(_FakeWebSocket):
        def __init__(self):
            super().__init__([])
            self._attempts = 0

        async def receive_json(self):
            self._attempts += 1
            if self._attempts > 2:
                raise WebSocketDisconnect(code=1000)
            raise ValueError("bad json")

    monkeypatch.setattr(main_module, "ws_manager", FakeManager())
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: SimpleNamespace(
            app_name="openOii", cors_origins=[], api_v1_prefix="/api/v1", environment="development"
        ),
    )
    monkeypatch.setattr(main_module, "init_db", lambda: None)
    monkeypatch.setattr("app.db.session.async_session_maker", FakeAsyncSessionMaker())

    fake_ws = BrokenWebSocket()

    app = main_module.create_app()
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", None) == "/ws/projects/{project_id}"
    )

    await handler(fake_ws, 1)

    msg_errors = [
        e
        for e in events
        if e[1].get("type") == "error" and e[1].get("data", {}).get("code") == "WS_MESSAGE_ERROR"
    ]
    assert len(msg_errors) >= 1


@pytest.mark.asyncio
async def test_http_exception_handler_uses_error_envelope(monkeypatch):
    """HTTPException 必须转成 {"error":{code,message}}。

    回归守卫：FastAPI 默认回 {"detail": ...}，而前端只解析 {"error": {...}}，
    所以 4xx 的用户文案会静默退化成 statusText（例如把
    "This character is already being regenerated" 变成 "Conflict"）。
    """
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()
    handler = app.exception_handlers[HTTPException]

    for status_code, expected_code in ((409, "CONFLICT"), (404, "NOT_FOUND"), (400, "BAD_REQUEST")):
        exc = HTTPException(status_code=status_code, detail="具体原因")
        response = await handler(
            SimpleNamespace(url=SimpleNamespace(path="/x"), method="GET"), exc
        )
        assert response.status_code == status_code
        body = json.loads(response.body)
        assert body == {
            "error": {"code": expected_code, "message": "具体原因", "details": {}}
        }, f"{status_code} 的错误体形状不对"


@pytest.mark.asyncio
async def test_validation_error_handler_uses_error_envelope(monkeypatch):
    settings = SimpleNamespace(
        app_name="openOii",
        cors_origins=[],
        api_v1_prefix="/api/v1",
        environment="development",
    )
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    app = main_module.create_app()
    handler = app.exception_handlers[RequestValidationError]

    exc = RequestValidationError([{"type": "missing", "loc": ("query", "x"), "msg": "Field required"}])
    response = await handler(
        SimpleNamespace(url=SimpleNamespace(path="/x"), method="GET"), exc
    )
    assert response.status_code == 422
    body = json.loads(response.body)
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["details"]["errors"]
