from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest
from fastapi import WebSocket
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, select
from starlette.websockets import WebSocketState

from app.agents.base import BaseAgent
from app.config import Settings
from app.services.llm import LLMResponse
from app.models import (  # noqa: F401
    agent_run,
    message,
    project as _project_models,
)
from app.models.message import Message
from app.ws.manager import ws_manager
from tests.agent_fixtures import make_context
from tests.factories import create_character, create_project, create_run, create_shot


class DummyAgent(BaseAgent):
    name = "dummy"


class _CapturingAgent(BaseAgent):
    name = "capturing"

    def __init__(self) -> None:
        self.messages: list[tuple[str, float | None, bool]] = []

    async def send_message(self, ctx, content: str, progress: float | None = None, is_loading: bool = False) -> None:
        self.messages.append((content, progress, is_loading))


class _FakeWebSocket:
    client_state = WebSocketState.CONNECTED

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_send_message_is_visible_to_other_sessions_immediately(tmp_path, test_settings):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'base-agent.db'}"
    engine = create_async_engine(database_url, echo=False)

    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with session_maker() as writer_session:
        ctx = await make_context(writer_session, test_settings)
        agent = DummyAgent()

        await agent.send_message(ctx, "第一条可见消息", progress=0.0, is_loading=True)

        async with session_maker() as reader_session:
            res = await reader_session.execute(select(Message).where(Message.project_id == ctx.project.id))
            messages = list(res.scalars().all())

        assert len(messages) == 1
        assert messages[0].content == "第一条可见消息"
        assert messages[0].agent == "dummy"
        assert messages[0].is_loading is True
        assert ctx.ws.events[-1][1]["type"] == "run_message"


@pytest.mark.asyncio
async def test_send_message_without_optional_fields(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)

    await DummyAgent().send_message(ctx, "plain text")

    event = ctx.ws.events[-1][1]
    assert event["type"] == "run_message"
    assert event["data"]["content"] == "plain text"
    assert "progress" not in event["data"]
    assert "isLoading" not in event["data"]


@pytest.mark.asyncio
async def test_send_character_event_emits_schema_complete_payload(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    character = await create_character(test_session, project_id=project.id, name="Hero")
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    ctx.ws = ws_manager

    fake_ws = _FakeWebSocket()
    ws_manager._conns.clear()
    ws_manager._conns[project.id].add(cast(WebSocket, cast(object, fake_ws)))

    await DummyAgent().send_character_event(ctx, character, "character_updated")

    payload = fake_ws.sent[-1]["data"]["character"]
    assert payload["approval_state"] == "draft"
    assert payload["approval_version"] == 0
    assert "approved_image_url" in payload


@pytest.mark.asyncio
async def test_send_shot_event_emits_schema_complete_payload(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    shot = await create_shot(test_session, project_id=project.id, description="Opening shot")
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    ctx.ws = ws_manager

    fake_ws = _FakeWebSocket()
    ws_manager._conns.clear()
    ws_manager._conns[project.id].add(cast(WebSocket, cast(object, fake_ws)))

    await DummyAgent().send_shot_event(ctx, shot, "shot_updated")

    payload = fake_ws.sent[-1]["data"]["shot"]
    assert payload["approval_state"] == "draft"
    assert payload["approval_version"] == 0
    assert payload["character_ids"] == []
    assert "approved_character_ids" in payload


@pytest.mark.asyncio
async def test_generate_and_cache_image_uses_timeout_and_cache(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    agent = DummyAgent()

    called = {}

    async def fake_generate_url(**kwargs):
        called.update(kwargs)
        return "http://external.test/image.png"

    async def fake_cache(url: str) -> str:
        return f"cached:{url}"

    monkeypatch.setattr(ctx.image, "generate_url", fake_generate_url)
    monkeypatch.setattr(ctx.image, "cache_external_image", fake_cache)

    result = await agent.generate_and_cache_image(ctx, prompt="a cat", image_bytes=b"123", timeout_s=1.0, style="anime")

    assert result == "cached:http://external.test/image.png"
    assert called["prompt"] == "a cat"
    assert called["image_bytes"] == b"123"
    assert called["style"] == "anime"


@pytest.mark.asyncio
async def test_generate_and_cache_image_without_timeout(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    agent = DummyAgent()

    calls = {}

    async def fake_generate_url(**kwargs):
        calls.update(kwargs)
        return "http://external.test/plain.png"

    async def fake_cache(url: str) -> str:
        return f"cached:{url}"

    monkeypatch.setattr(ctx.image, "generate_url", fake_generate_url)
    monkeypatch.setattr(ctx.image, "cache_external_image", fake_cache)

    result = await agent.generate_and_cache_image(ctx, prompt="plain", image_bytes=None)

    assert result == "cached:http://external.test/plain.png"
    assert calls["prompt"] == "plain"
    assert calls["image_bytes"] is None


@pytest.mark.asyncio
async def test_generate_and_cache_image_times_out(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    agent = DummyAgent()

    async def slow_generate_url(**kwargs):
        await asyncio.sleep(0.01)
        return "http://external.test/image.png"

    monkeypatch.setattr(ctx.image, "generate_url", slow_generate_url)

    with pytest.raises(RuntimeError, match="图片生成超时"):
        await agent.generate_and_cache_image(ctx, prompt="a cat", timeout_s=0.001)


@pytest.mark.asyncio
async def test_get_project_characters_returns_project_rows(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    await create_character(test_session, project_id=project.id, name="Hero")
    ctx = await make_context(test_session, test_settings, project=project, run=run)

    characters = await DummyAgent().get_project_characters(ctx)

    assert [character.name for character in characters] == ["Hero"]


@pytest.mark.asyncio
async def test_send_progress_batch_clamps_and_marks_loading(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    agent = _CapturingAgent()

    await agent.send_progress_batch(ctx, total=4, current=1, message="step")

    assert agent.messages == [("step", 0.5, True)]


@pytest.mark.asyncio
async def test_call_llm_streams_and_returns_final(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)

    class FakeLLM:
        async def stream(self, **kwargs):
            yield {"type": "text", "text": "hello"}
            yield {"type": "text", "text": " world"}
            yield {"type": "final", "response": LLMResponse(text="done", tool_calls=[], raw=None)}

    ctx.llm = FakeLLM()  # type: ignore[assignment]

    result = await DummyAgent().call_llm(ctx, system_prompt="sys", user_prompt="user", stream_to_ws=True)

    assert result.text == "done"
    assert ctx.ws.events[-1][1]["type"] == "run_message"
    assert ctx.ws.events[-1][1]["data"]["content"] == "hello world"


@pytest.mark.asyncio
async def test_call_llm_ignores_non_text_and_flushes_buffer(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)

    class FakeLLM:
        async def stream(self, **kwargs):
            yield {"type": "text", "text": 123}
            yield {"type": "text", "text": "hello"}
            yield {"type": "final", "response": LLMResponse(text="done", tool_calls=[], raw=None)}

    ctx.llm = FakeLLM()  # type: ignore[assignment]

    result = await DummyAgent().call_llm(ctx, system_prompt="sys", user_prompt="user", stream_to_ws=True)

    assert result.text == "done"
    assert ctx.ws.events[-1][1]["data"]["content"] == "hello"


@pytest.mark.asyncio
async def test_call_llm_requires_final_response(monkeypatch, test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)

    class FakeLLM:
        async def stream(self, **kwargs):
            yield {"type": "text", "text": "hello"}

    ctx.llm = FakeLLM()  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="without final response"):
        await DummyAgent().call_llm(ctx, system_prompt="sys", user_prompt="user")


@pytest.mark.asyncio
async def test_send_thinking_respects_enabled_flag(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    agent = DummyAgent()

    # Default: thinking_chain_enabled=True, detail_level=normal (decision + reviewing visible)
    initial_event_count = len(ctx.ws.events)
    await agent.send_thinking(ctx, phase="decision", content="test thinking")
    assert len(ctx.ws.events) > initial_event_count
    # Should send both agent_thinking and run_message events
    event_types = [e[1]["type"] for e in ctx.ws.events]
    assert "agent_thinking" in event_types
    assert "run_message" in event_types

    # planning phase should be filtered at normal level
    count_after_decision = len(ctx.ws.events)
    await agent.send_thinking(ctx, phase="planning", content="should be filtered")
    assert len(ctx.ws.events) == count_after_decision


@pytest.mark.asyncio
async def test_send_thinking_skips_when_disabled(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    # Disable thinking chain
    test_settings_thinking_off = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        thinking_chain_enabled=False,
    )
    ctx = await make_context(test_session, test_settings_thinking_off, project=project, run=run)
    agent = DummyAgent()

    initial_event_count = len(ctx.ws.events)
    await agent.send_thinking(ctx, phase="planning", content="should not appear")
    assert len(ctx.ws.events) == initial_event_count


@pytest.mark.asyncio
async def test_send_thinking_filters_by_detail_level(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    # minimal level: only decision phase should pass
    test_settings_minimal = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        thinking_chain_enabled=True,
        thinking_chain_detail_level="minimal",
    )
    ctx = await make_context(test_session, test_settings_minimal, project=project, run=run)
    agent = DummyAgent()

    # reasoning phase should be filtered out at minimal level
    initial_count = len(ctx.ws.events)
    await agent.send_thinking(ctx, phase="reasoning", content="should be filtered")
    assert len(ctx.ws.events) == initial_count

    # decision phase should pass at minimal level
    await agent.send_thinking(ctx, phase="decision", content="should appear")
    assert len(ctx.ws.events) > initial_count
