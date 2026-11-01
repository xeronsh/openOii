"""Chat routes proxy to the engine's chat agent (ADR 0011); the engine is mocked."""

from __future__ import annotations

import httpx
import pytest

from app.api.v1.routes import chat as chat_routes
from app.services import engine_client
from app.services.engine_client import EngineUnavailableError
from app.ws.manager import ConnectionManager
from tests.factories import create_project


@pytest.fixture
def engine(monkeypatch):
    calls: list[tuple[int, str, object]] = []
    replies: dict[str, tuple[int, dict]] = {}

    async def _ensure(base_url, database_url, static_dir):
        return None

    async def _chat(base_url, project_id, action="", body=None):
        calls.append((project_id, action, body))
        return replies.get(action, (200, {}))

    monkeypatch.setattr(chat_routes, "ensure_engine_running", _ensure)
    monkeypatch.setattr(chat_routes, "engine_chat", _chat)
    return calls, replies


@pytest.mark.asyncio
async def test_chat_routes_forward_to_the_engine(async_client, test_session, engine):
    calls, replies = engine
    project = await create_project(test_session, title="雨夜")
    pid = project.id
    replies[""] = (
        200,
        {
            "messages": [{"id": 1, "role": "user", "text": "重画第1镜"}],
            "busy": True,
            "text": "",
            "pending": {"tool_call_id": "t1", "tool": "重画分镜", "summary": "重新生成分镜 #21 的画面"},
        },
    )
    res = await async_client.get(f"/api/v1/projects/{pid}/chat")
    assert res.status_code == 200
    assert res.json()["pending"]["summary"] == "重新生成分镜 #21 的画面"

    replies[""] = (202, {"accepted": True})
    res = await async_client.post(f"/api/v1/projects/{pid}/chat", json={"content": "你好"})
    assert res.status_code == 202
    replies["confirm"] = (200, {"ok": True})
    res = await async_client.post(
        f"/api/v1/projects/{pid}/chat/confirm", json={"tool_call_id": "t1", "approved": True}
    )
    assert res.json() == {"ok": True}
    replies["abort"] = (200, {"aborted": True})
    assert (await async_client.post(f"/api/v1/projects/{pid}/chat/abort")).json() == {"aborted": True}
    assert calls[1:] == [
        (pid, "", {"content": "你好"}),
        (pid, "confirm", {"tool_call_id": "t1", "approved": True}),
        (pid, "abort", None),
    ]


@pytest.mark.asyncio
async def test_chat_routes_map_engine_errors(async_client, test_session, engine, monkeypatch):
    _, replies = engine
    pid = (await create_project(test_session)).id
    assert (await async_client.get("/api/v1/projects/999999/chat")).status_code == 404
    assert (await async_client.post(f"/api/v1/projects/{pid}/chat", json={"content": ""})).status_code == 422

    replies[""] = (409, {"error": {"code": "CHAT_BUSY", "message": "助手还在回答上一条消息"}})
    res = await async_client.post(f"/api/v1/projects/{pid}/chat", json={"content": "再来"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "CHAT_BUSY"
    replies["confirm"] = (404, {"error": {"code": "CHAT_CONFIRM_NOT_FOUND", "message": "这个确认已经失效"}})
    res = await async_client.post(
        f"/api/v1/projects/{pid}/chat/confirm", json={"tool_call_id": "gone", "approved": False}
    )
    assert res.status_code == 404
    replies["abort"] = (500, {})
    res = await async_client.post(f"/api/v1/projects/{pid}/chat/abort")
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "CHAT_FAILED"

    async def _down(*args, **kwargs):
        raise EngineUnavailableError("engine down")

    monkeypatch.setattr(chat_routes, "engine_chat", _down)
    res = await async_client.get(f"/api/v1/projects/{pid}/chat")
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "ENGINE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_engine_chat_client(monkeypatch):
    seen: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content))
        if request.url.path.endswith("/abort"):
            return httpx.Response(200, text="not json")
        return httpx.Response(200, json={"busy": False})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        engine_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    assert await engine_client.engine_chat("http://e", 3) == (200, {"busy": False})
    assert await engine_client.engine_chat("http://e", 3, "", {"content": "hi"}) == (200, {"busy": False})
    assert await engine_client.engine_chat("http://e", 3, "abort") == (200, {})
    assert [(m, p) for m, p, _ in seen] == [("GET", "/chat/3"), ("POST", "/chat/3"), ("POST", "/chat/3/abort")]

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(
        engine_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(broken), **kw)
    )
    with pytest.raises(EngineUnavailableError):
        await engine_client.engine_chat("http://e", 3)


def test_chat_events_are_part_of_the_ws_contract():
    message = ConnectionManager._validated_payload(
        {"type": "chat_message", "data": {"project_id": 1, "message": {"id": 4, "role": "tool", "tool": "读取项目", "ok": True}}}
    )
    assert message["data"]["message"]["text"] == ""
    status = ConnectionManager._validated_payload(
        {"type": "chat_status", "data": {"project_id": 1, "busy": True, "text": "正在", "pending": None}}
    )
    assert status["data"] == {"project_id": 1, "busy": True, "text": "正在", "pending": None}
    with pytest.raises(ValueError):
        ConnectionManager._validated_payload({"type": "chat_status", "data": {"busy": True}})
