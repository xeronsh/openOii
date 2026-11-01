from __future__ import annotations

import httpx
import pytest

import app.services.text as text_module
from app.config import Settings
from app.services.llm import LLMResponse
from app.services.text import (
    TextService,
    TextServiceAuthError,
    TextServiceError,
    TextServiceRateLimitError,
    TextServiceServerError,
)


class StubResponse:
    def __init__(self, lines: list[str], *, status_code: int = 200):
        self.status_code = status_code
        self._lines = lines

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class StubStream:
    def __init__(self, response: StubResponse):
        self._response = response

    async def __aenter__(self) -> StubResponse:
        return self._response

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False


class StubAsyncClient:
    def __init__(self, response: StubResponse):
        self._response = response
        self.last_method: str | None = None
        self.last_url: str | None = None
        self.last_headers: dict[str, str] | None = None
        self.last_json: dict | None = None

    async def __aenter__(self) -> "StubAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    def stream(self, method: str, url: str, *, headers: dict[str, str] | None = None, json=None):
        self.last_method = method
        self.last_url = url
        self.last_headers = headers
        self.last_json = json
        return StubStream(self._response)


def make_settings(**overrides):
    base = dict(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    base.update(overrides)
    return Settings(**base)


def test_build_url():
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com/",
        text_endpoint="chat/completions",
    )
    service = TextService(settings)
    assert service._build_url() == "https://text.example.com/chat/completions"


@pytest.mark.asyncio
async def test_stream_chat_completions_sse(monkeypatch):
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    service = TextService(settings)

    lines = [
        "event: message",
        "",
        "data: {not json}",
        'data: {"choices":[{"delta":{}}]}',
        'data: {"choices":[{"delta":{"content":"he"}}]}',
        'data: {"choices":[{"delta":{"content":"llo"}}]}',
        "data: [DONE]",
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    parts: list[str] = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"
    assert client.last_json is not None
    assert client.last_json["messages"] == [{"role": "user", "content": "hi"}]
    assert client.last_json["stream"] is True


@pytest.mark.asyncio
async def test_stream_completions_sse(monkeypatch):
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    service = TextService(settings)

    lines = [
        "data: {not json}",
        'data: {"choices":[{"text":"he"}]}',
        'data: {"choices":[{"text":"llo"}]}',
        "data: [DONE]",
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    parts: list[str] = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"
    assert client.last_json is not None
    assert client.last_json["prompt"] == "hi"
    assert client.last_json["stream"] is True


@pytest.mark.asyncio
async def test_probe_marks_provider_degraded_when_stream_is_unavailable(monkeypatch):
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    service = TextService(settings)

    async def fake_post(_url, _payload):
        return {"choices": [{"message": {"content": ""}}]}

    async def fake_stream_native_events(payload):
        raise TextServiceError("stream unavailable")
        yield payload  # pragma: no cover

    monkeypatch.setattr(service, "_post_json_with_retry", fake_post)
    monkeypatch.setattr(service, "_stream_native_events", fake_stream_native_events)

    result = await service.probe()

    assert result.status == "degraded"
    assert result.generate is True
    assert result.stream is False
    assert result.reason_code == "provider_stream_unavailable"


@pytest.mark.asyncio
async def test_probe_retries_transient_generate_failure_before_marking_invalid(monkeypatch):
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    service = TextService(settings, max_retries=0)
    calls = {"post": 0}

    async def fake_post(_url, _payload):
        calls["post"] += 1
        if calls["post"] == 1:
            raise TextServiceError("Text generation request failed after 0 retries")
        return {"choices": [{"message": {"content": ""}}]}

    async def fake_stream_native_events(payload):
        raise TextServiceError("Text generation stream failed after 0 retries")
        yield payload  # pragma: no cover

    monkeypatch.setattr(service, "_post_json_with_retry", fake_post)
    monkeypatch.setattr(service, "_stream_native_events", fake_stream_native_events)

    result = await service.probe()

    assert calls["post"] == 2
    assert result.status == "degraded"
    assert result.generate is True
    assert result.stream is False


@pytest.mark.asyncio
async def test_probe_accepts_openai_compatible_reasoning_response_without_content(monkeypatch):
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
        text_api_key="test",
        text_model="gpt-test",
    )
    service = TextService(settings)

    async def fake_post(_url, _payload):
        return {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "reasoning_content": "thinking...",
                    }
                }
            ]
        }

    async def fake_stream_native_events(_payload):
        yield {"type": "text", "text": "OK"}
        yield {"type": "final", "response": LLMResponse(text="OK", tool_calls=[], raw=None)}

    monkeypatch.setattr(service, "_post_json_with_retry", fake_post)
    monkeypatch.setattr(service, "_stream_native_events", fake_stream_native_events)

    result = await service.probe()

    assert result.status == "valid"
    assert result.generate is True
    assert result.stream is True


# ============================================
# 错误处理测试
# ============================================


@pytest.mark.asyncio
async def test_stream_error_in_chunk(monkeypatch):
    """测试流式响应中的错误"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings)

    lines = [
        'data: {"error": {"message": "something went wrong"}}',
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    with pytest.raises(TextServiceError, match="Stream error"):
        async for _ in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
            pass


# ============================================
# 边界条件测试
# ============================================


@pytest.mark.asyncio
async def test_sse_done_with_whitespace(monkeypatch):
    """测试 [DONE] 带空格"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
    )
    service = TextService(settings)

    lines = [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        "data: [DONE]  ",  # 带尾随空格
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    parts: list[str] = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"


# ============================================
# 配置测试
# ============================================


def test_build_url_without_leading_slash():
    """测试端点没有前导斜杠"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="chat/completions",
    )
    service = TextService(settings)
    assert service._build_url() == "https://text.example.com/chat/completions"


def test_build_url_with_trailing_slash():
    """测试 base_url 有尾随斜杠"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com/",
        text_endpoint="/chat/completions",
    )
    service = TextService(settings)
    assert service._build_url() == "https://text.example.com/chat/completions"


def test_text_headers_without_api_key():
    """测试没有 API key 的请求头"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_api_key=None,
    )
    headers = settings.text_headers()
    assert "Authorization" not in headers
    assert headers["User-Agent"] == "openOii-backend"


def test_text_headers_with_api_key():
    """测试有 API key 的请求头"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_api_key="test-key",
    )
    headers = settings.text_headers()
    assert headers["Authorization"] == "Bearer test-key"


def test_is_chat_endpoint():
    """测试端点类型判断"""
    settings_chat = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_endpoint="/chat/completions",
    )
    service_chat = TextService(settings_chat)
    assert service_chat._is_chat_endpoint() is True

    settings_completions = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_endpoint="/completions",
    )
    service_completions = TextService(settings_completions)
    assert service_completions._is_chat_endpoint() is False


def test_is_retryable_status():
    """测试可重试状态码判断"""
    settings = Settings(database_url="sqlite+aiosqlite:///:memory:")
    service = TextService(settings)

    assert service._is_retryable_status(429) is True
    assert service._is_retryable_status(500) is True
    assert service._is_retryable_status(502) is True
    assert service._is_retryable_status(503) is True
    assert service._is_retryable_status(504) is True

    assert service._is_retryable_status(400) is False
    assert service._is_retryable_status(401) is False
    assert service._is_retryable_status(404) is False


# ============================================
# 重试逻辑测试
# ============================================


class MockResponse:
    def __init__(self, status_code: int, json_data: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("HTTP Error", request=None, response=self)


class MockAsyncClient:
    def __init__(self, responses: list[MockResponse]):
        self.responses = responses
        self.call_count = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, json=None):
        response = self.responses[self.call_count]
        self.call_count += 1
        return response

    def stream(self, method, url, headers=None, json=None):
        return MockStream(self.responses[self.call_count])


class MockStream:
    def __init__(self, response: MockResponse):
        self.response = response
        self._lines = []

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


@pytest.mark.asyncio
async def test_retry_on_429(monkeypatch):
    """测试 429 状态码重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 第一次 429，第二次成功
    responses = [
        MockResponse(429, text="Rate limited"),
        MockResponse(200, json_data={"choices": [{"message": {"content": "success"}}]}),
    ]
    client = MockAsyncClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    result = await service._post_json_with_retry("https://text.example.com/chat/completions", {})
    assert result == {"choices": [{"message": {"content": "success"}}]}
    assert client.call_count == 2


@pytest.mark.asyncio
async def test_retry_on_500(monkeypatch):
    """测试 500 状态码重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 第一次 500，第二次成功
    responses = [
        MockResponse(500, text="Server error"),
        MockResponse(200, json_data={"choices": [{"message": {"content": "success"}}]}),
    ]
    client = MockAsyncClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    result = await service._post_json_with_retry("https://text.example.com/chat/completions", {})
    assert result == {"choices": [{"message": {"content": "success"}}]}
    assert client.call_count == 2


@pytest.mark.asyncio
async def test_no_retry_on_401(monkeypatch):
    """测试 401 不重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 401 不应该重试
    responses = [
        MockResponse(401, text="Unauthorized"),
        MockResponse(200, json_data={"choices": [{"message": {"content": "success"}}]}),
    ]
    client = MockAsyncClient(responses)

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    with pytest.raises(TextServiceAuthError) as exc_info:
        await service._post_json_with_retry("https://text.example.com/chat/completions", {})

    assert exc_info.value.status_code == 401
    assert client.call_count == 1  # 只调用一次，不重试


@pytest.mark.asyncio
async def test_retry_exhausted_429(monkeypatch):
    """测试 429 重试耗尽"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 全部返回 429
    responses = [
        MockResponse(429, text="Rate limited"),
        MockResponse(429, text="Rate limited"),
        MockResponse(429, text="Rate limited"),
    ]
    client = MockAsyncClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    with pytest.raises(TextServiceRateLimitError) as exc_info:
        await service._post_json_with_retry("https://text.example.com/chat/completions", {})

    assert exc_info.value.status_code == 429
    assert client.call_count == 3  # max_retries=2 means 3 attempts total


@pytest.mark.asyncio
async def test_retry_exhausted_500(monkeypatch):
    """测试 500 重试耗尽"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 全部返回 500
    responses = [
        MockResponse(500, text="Server error"),
        MockResponse(500, text="Server error"),
        MockResponse(500, text="Server error"),
    ]
    client = MockAsyncClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    with pytest.raises(TextServiceServerError) as exc_info:
        await service._post_json_with_retry("https://text.example.com/chat/completions", {})

    assert exc_info.value.status_code == 500
    assert client.call_count == 3


@pytest.mark.asyncio
async def test_network_error_retry(monkeypatch):
    """测试网络错误重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise httpx.NetworkError("Connection failed")
            return MockResponse(200, json_data={"choices": [{"message": {"content": "success"}}]})

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: FailingClient())
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    result = await service._post_json_with_retry("https://text.example.com/chat/completions", {})
    assert result == {"choices": [{"message": {"content": "success"}}]}
    assert call_count == 2


@pytest.mark.asyncio
async def test_network_error_exhausted(monkeypatch):
    """测试网络错误重试耗尽"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            raise httpx.NetworkError("Connection failed")

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: FailingClient())
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    with pytest.raises(TextServiceError) as exc_info:
        await service._post_json_with_retry("https://text.example.com/chat/completions", {})

    assert call_count == 3
    assert "failed after 2 retries" in str(exc_info.value)


# ============================================
# 流式重试逻辑测试
# ============================================


class MockStreamResponse:
    def __init__(
        self, status_code: int, lines: list[str] | None = None, headers: dict | None = None
    ):
        self.status_code = status_code
        self._lines = lines or []
        self.headers = headers or {}
        self.text = "error body"

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("HTTP Error", request=None, response=self)

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class MockStreamClient:
    def __init__(self, responses: list[MockStreamResponse]):
        self.responses = responses
        self.call_count = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, method, url, headers=None, json=None):
        response = self.responses[self.call_count]
        self.call_count += 1
        return MockStreamContext(response)


class MockStreamContext:
    def __init__(self, response: MockStreamResponse):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


@pytest.mark.asyncio
async def test_stream_retry_on_429(monkeypatch):
    """测试流式 429 重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 第一次 429，第二次成功
    responses = [
        MockStreamResponse(429),
        MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}']),
    ]
    client = MockStreamClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    async for chunk in service._post_stream_with_retry(
        "https://text.example.com/chat/completions", {}
    ):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert client.call_count == 2


@pytest.mark.asyncio
async def test_stream_retry_with_retry_after_header(monkeypatch):
    """测试流式 Retry-After 头"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    sleep_times = []

    async def mock_sleep(duration):
        sleep_times.append(duration)

    # 第一次 429 with Retry-After，第二次成功
    responses = [
        MockStreamResponse(429, headers={"Retry-After": "2.5"}),
        MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}']),
    ]
    client = MockStreamClient(responses)

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    async for chunk in service._post_stream_with_retry(
        "https://text.example.com/chat/completions", {}
    ):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert client.call_count == 2
    # Retry-After 2.5 + jitter (2.5 * 0.2 * 0) = 2.5
    assert len(sleep_times) == 1
    assert 2.0 <= sleep_times[0] <= 3.0  # 2.5 ± jitter


@pytest.mark.asyncio
async def test_stream_retry_invalid_retry_after(monkeypatch):
    """测试流式无效 Retry-After 头"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 第一次 429 with invalid Retry-After，第二次成功
    responses = [
        MockStreamResponse(429, headers={"Retry-After": "invalid"}),
        MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}']),
    ]
    client = MockStreamClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    async for chunk in service._post_stream_with_retry(
        "https://text.example.com/chat/completions", {}
    ):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert client.call_count == 2


@pytest.mark.asyncio
async def test_stream_no_retry_after_partial_emission(monkeypatch):
    """测试流式部分发送后不重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class PartialEmitClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # 第一次：发送一些数据后失败
                return PartialEmitContext()
            return MockStreamContext(
                MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"world"}}]}'])
            )

    class PartialEmitContext:
        async def __aenter__(self):
            return PartialEmitResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class PartialEmitResponse:
        status_code = 200
        text = "error"

        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            raise httpx.NetworkError("Connection lost")

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: PartialEmitClient()
    )

    chunks = []
    with pytest.raises(TextServiceError):
        async for chunk in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            chunks.append(chunk)

    # 应该只调用一次，因为已经发送了数据
    assert call_count == 1
    assert len(chunks) == 1  # 已经收到一个 chunk


@pytest.mark.asyncio
async def test_stream_retry_exhausted_500(monkeypatch):
    """测试流式 500 重试耗尽"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 全部返回 500
    responses = [
        MockStreamResponse(500),
        MockStreamResponse(500),
        MockStreamResponse(500),
    ]
    client = MockStreamClient(responses)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    with pytest.raises(TextServiceServerError) as exc_info:
        async for _ in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            pass

    assert exc_info.value.status_code == 500
    assert client.call_count == 3


@pytest.mark.asyncio
async def test_stream_no_retry_on_403(monkeypatch):
    """测试流式 403 不重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    # 403 不应该重试
    responses = [
        MockStreamResponse(403),
        MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}']),
    ]
    client = MockStreamClient(responses)

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    with pytest.raises(TextServiceAuthError) as exc_info:
        async for _ in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            pass

    assert exc_info.value.status_code == 403
    assert client.call_count == 1  # 只调用一次，不重试


@pytest.mark.asyncio
async def test_stream_network_error_retry(monkeypatch):
    """测试流式网络错误重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class NetworkErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                return NetworkErrorContext()
            return MockStreamContext(
                MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}'])
            )

    class NetworkErrorContext:
        async def __aenter__(self):
            raise httpx.NetworkError("Connection failed")

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: NetworkErrorClient()
    )

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    async for chunk in service._post_stream_with_retry(
        "https://text.example.com/chat/completions", {}
    ):
        chunks.append(chunk)

    assert len(chunks) == 1
    assert call_count == 2


@pytest.mark.asyncio
async def test_response_text_exception(monkeypatch):
    """测试响应体读取异常"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=0)

    class BrokenResponse:
        status_code = 500

        @property
        def text(self):
            raise RuntimeError("Cannot read response body")

        def json(self):
            return {}

        def raise_for_status(self):
            raise httpx.HTTPStatusError("HTTP Error", request=None, response=self)

    class BrokenClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers=None, json=None):
            return BrokenResponse()

    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: BrokenClient())

    with pytest.raises(TextServiceServerError) as exc_info:
        await service._post_json_with_retry("https://text.example.com/chat/completions", {})

    assert exc_info.value.status_code == 500
    assert exc_info.value.response_body is None  # Should be None due to exception


@pytest.mark.asyncio
async def test_stream_response_text_exception(monkeypatch):
    """测试流式响应体读取异常"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=0)

    class BrokenStreamResponse:
        status_code = 500
        headers = {}

        @property
        def text(self):
            raise RuntimeError("Cannot read response body")

        def raise_for_status(self):
            raise httpx.HTTPStatusError("HTTP Error", request=None, response=self)

        async def aiter_lines(self):
            return
            yield  # pragma: no cover

    class BrokenStreamClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            return BrokenStreamContext()

    class BrokenStreamContext:
        async def __aenter__(self):
            return BrokenStreamResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: BrokenStreamClient()
    )

    with pytest.raises(TextServiceServerError) as exc_info:
        async for _ in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            pass

    assert exc_info.value.status_code == 500
    assert exc_info.value.response_body is None  # Should be None due to exception


@pytest.mark.asyncio
async def test_stream_emitted_then_http_error(monkeypatch):
    """测试流式发送数据后遇到 HTTP 错误不重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class PartialThenErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            return PartialThenErrorContext()

    class PartialThenErrorContext:
        async def __aenter__(self):
            return PartialThenErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class PartialThenErrorResponse:
        status_code = 200
        text = "error"

        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            # 模拟在发送数据后遇到 HTTP 错误
            raise httpx.HTTPStatusError("HTTP Error", request=None, response=ErrorResponse())

    class ErrorResponse:
        status_code = 500
        text = "Server error"

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: PartialThenErrorClient()
    )

    chunks = []
    with pytest.raises(TextServiceError):
        async for chunk in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            chunks.append(chunk)

    # 应该只调用一次，因为已经发送了数据
    assert call_count == 1
    assert len(chunks) == 1


@pytest.mark.asyncio
async def test_stream_with_temperature(monkeypatch):
    """测试带 temperature 参数的流式生成"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
    )
    service = TextService(settings)

    async def fake_stream(url, payload):
        assert payload["temperature"] == 0.8
        yield {"choices": [{"delta": {"content": "hello"}}]}

    monkeypatch.setattr(service, "_post_stream_with_retry", fake_stream)

    parts = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", temperature=0.8, stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"


@pytest.mark.asyncio
async def test_stream_chunk_empty_choices(monkeypatch):
    """测试流式 chunk 空 choices"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
    )
    service = TextService(settings)

    lines = [
        'data: {"choices":[]}',  # 空 choices
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    parts = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"


@pytest.mark.asyncio
async def test_stream_chunk_not_list_choices(monkeypatch):
    """测试流式 chunk choices 不是列表"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
        text_endpoint="/chat/completions",
    )
    service = TextService(settings)

    lines = [
        'data: {"choices":"not a list"}',  # choices 不是列表
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
    ]

    client = StubAsyncClient(StubResponse(lines))
    monkeypatch.setattr(text_module.httpx, "AsyncClient", lambda *args, **kwargs: client)

    parts = []
    async for part in service._stream_native_events(service._build_payload(prompt="hi", stream=True)):
        parts.append(
            part.get("text", "") if isinstance(part, dict) and part.get("type") == "text" else ""
        )

    assert "".join(parts) == "hello"


@pytest.mark.asyncio
async def test_stream_http_error_after_emit_with_retry(monkeypatch):
    """测试流式发送后 HTTP 错误重试逻辑"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class EmitThenRetryableErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            return EmitThenRetryableErrorContext()

    class EmitThenRetryableErrorContext:
        async def __aenter__(self):
            return EmitThenRetryableErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class EmitThenRetryableErrorResponse:
        status_code = 200
        text = "error"

        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            # 模拟在发送数据后遇到可重试的 HTTP 错误（但不应该重试）
            raise httpx.HTTPStatusError(
                "HTTP Error", request=None, response=RetryableErrorResponse()
            )

    class RetryableErrorResponse:
        status_code = 429  # 可重试状态码
        text = "Rate limited"

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: EmitThenRetryableErrorClient()
    )
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    with pytest.raises(TextServiceError):
        async for chunk in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            chunks.append(chunk)

    # 应该只调用一次，因为已经发送了数据（emitted_any=True）
    assert call_count == 1
    assert len(chunks) == 1


@pytest.mark.asyncio
async def test_stream_network_error_after_emit(monkeypatch):
    """测试流式发送后网络错误不重试"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class EmitThenNetworkErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            return EmitThenNetworkErrorContext()

    class EmitThenNetworkErrorContext:
        async def __aenter__(self):
            return EmitThenNetworkErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class EmitThenNetworkErrorResponse:
        status_code = 200
        text = "error"

        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            raise httpx.NetworkError("Connection lost")

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: EmitThenNetworkErrorClient()
    )

    chunks = []
    with pytest.raises(TextServiceError):
        async for chunk in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            chunks.append(chunk)

    # 应该只调用一次，因为已经发送了数据
    assert call_count == 1
    assert len(chunks) == 1


@pytest.mark.asyncio
async def test_stream_http_error_retry_with_sleep(monkeypatch):
    """测试流式 HTTP 错误重试（触发 sleep 逻辑）"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0
    sleep_called = []

    class RetryableHTTPErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                return RetryableHTTPErrorContext()
            return MockStreamContext(
                MockStreamResponse(200, lines=['data: {"choices":[{"delta":{"content":"hello"}}]}'])
            )

    class RetryableHTTPErrorContext:
        async def __aenter__(self):
            return RetryableHTTPErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class RetryableHTTPErrorResponse:
        status_code = 200
        text = "error"
        headers = {}

        def raise_for_status(self):
            pass

        def aiter_lines(self):
            async def _gen():
                raise httpx.HTTPStatusError("HTTP Error", request=None, response=ErrorResponse())
                yield  # pragma: no cover

            return _gen()

    class ErrorResponse:
        status_code = 500
        text = "Server error"

    async def mock_sleep(duration):
        sleep_called.append(duration)

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: RetryableHTTPErrorClient()
    )
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    chunks = []
    async for chunk in service._post_stream_with_retry(
        "https://text.example.com/chat/completions", {}
    ):
        chunks.append(chunk)

    assert call_count == 2
    assert len(chunks) == 1
    assert len(sleep_called) == 1


@pytest.mark.asyncio
async def test_stream_network_error_exhausted(monkeypatch):
    """测试流式网络错误重试耗尽"""
    settings = Settings(
        database_url="sqlite+aiosqlite:///:memory:",
        text_base_url="https://text.example.com",
    )
    service = TextService(settings, max_retries=2)

    call_count = 0

    class NetworkErrorClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, headers=None, json=None):
            nonlocal call_count
            call_count += 1
            return NetworkErrorContext()

    class NetworkErrorContext:
        async def __aenter__(self):
            return NetworkErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class NetworkErrorResponse:
        status_code = 200
        text = "error"
        headers = {}

        def raise_for_status(self):
            pass

        def aiter_lines(self):
            async def _gen():
                raise httpx.NetworkError("Connection failed")
                yield  # pragma: no cover

            return _gen()

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(
        text_module.httpx, "AsyncClient", lambda *args, **kwargs: NetworkErrorClient()
    )
    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)
    monkeypatch.setattr(text_module.random, "random", lambda: 0.5)

    with pytest.raises(TextServiceError):
        async for _ in service._post_stream_with_retry(
            "https://text.example.com/chat/completions", {}
        ):
            pass


# --- _build_payload branches ---


def test_build_payload_sends_reasoning_effort_but_no_enable_thinking():
    """The probe mirrors the engine: reasoning effort is the only thinking knob."""
    settings = make_settings(text_enable_thinking=True, text_reasoning_effort="low")
    svc = TextService(settings)
    payload = svc._build_payload(prompt="hi", max_tokens=10, stream=False)
    assert payload["reasoning_effort"] == "low"
    assert "enable_thinking" not in payload


def test_build_payload_messages_win_over_prompt_and_temperature_is_optional():
    svc = TextService(make_settings())
    messages = [{"role": "system", "content": "You are helpful"}, {"role": "user", "content": "hi"}]
    payload = svc._build_payload(prompt="ignored", messages=messages, stream=False)
    assert payload["messages"] == messages
    assert "temperature" not in payload


def test_build_payload_temperature():
    settings = make_settings()
    svc = TextService(settings)
    payload = svc._build_payload(prompt="hi", max_tokens=10, stream=False, temperature=0.5)
    assert payload["temperature"] == 0.5


def test_build_payload_gpt5_uses_max_completion_tokens():
    settings = make_settings(text_model="gpt-5-mini")
    svc = TextService(settings)
    payload = svc._build_payload(prompt="hi", max_tokens=10, stream=False)
    assert payload["max_completion_tokens"] == 10
    assert "max_tokens" not in payload


def test_build_payload_chat_system_with_messages():
    settings = make_settings()
    svc = TextService(settings)
    payload = svc._build_payload(
        messages=[{"role": "user", "content": "hi"}],
        system="be polite",
        max_tokens=10,
        stream=False,
    )
    assert payload["messages"][0] == {"role": "system", "content": "be polite"}


def test_build_payload_chat_system_with_prompt():
    settings = make_settings()
    svc = TextService(settings)
    payload = svc._build_payload(prompt="hi", system="be polite", max_tokens=10, stream=False)
    assert payload["messages"][0] == {"role": "system", "content": "be polite"}


def test_build_payload_chat_neither_messages_nor_prompt():
    settings = make_settings()
    svc = TextService(settings)
    with pytest.raises(ValueError, match="Either messages or prompt"):
        svc._build_payload(max_tokens=10, stream=False)


def test_build_payload_non_chat_messages_with_system():
    settings = make_settings(text_endpoint="/v1/completions")
    svc = TextService(settings)
    payload = svc._build_payload(
        messages=[{"role": "user", "content": "hi"}],
        system="be polite",
        max_tokens=10,
        stream=False,
    )
    assert "System: be polite" in payload["prompt"]


def test_build_payload_non_chat_prompt_with_system():
    settings = make_settings(text_endpoint="/v1/completions")
    svc = TextService(settings)
    payload = svc._build_payload(prompt="hi", system="be polite", max_tokens=10, stream=False)
    assert "System: be polite" in payload["prompt"]


def test_build_payload_non_chat_neither():
    settings = make_settings(text_endpoint="/v1/completions")
    svc = TextService(settings)
    with pytest.raises(ValueError, match="Either messages or prompt"):
        svc._build_payload(max_tokens=10, stream=False)


# --- _stream_fallback_message ---


def test_stream_fallback_message_with_detail():
    svc = TextService(make_settings())
    msg = svc._stream_fallback_message(Exception("timeout"))
    assert "timeout" in msg


def test_stream_fallback_message_empty_detail():
    svc = TextService(make_settings())
    msg = svc._stream_fallback_message(Exception(""))
    assert "已自动回退" in msg


# --- _is_retryable_probe_generate_error ---


def test_is_retryable_probe_non_text_service_error():
    svc = TextService(make_settings())
    assert svc._is_retryable_probe_generate_error(ValueError("x")) is False


def test_is_retryable_probe_no_status_code():
    svc = TextService(make_settings())
    assert svc._is_retryable_probe_generate_error(TextServiceError("x")) is True


def test_is_retryable_probe_retryable_status():
    svc = TextService(make_settings())
    assert svc._is_retryable_probe_generate_error(TextServiceError("x", status_code=503)) is True


def test_is_retryable_probe_non_retryable_status():
    svc = TextService(make_settings())
    assert svc._is_retryable_probe_generate_error(TextServiceError("x", status_code=400)) is False


# --- _probe_generate_capability ---


@pytest.mark.asyncio
async def test_probe_generate_capability_retries_on_retryable_error(monkeypatch):
    """First attempt fails with retryable error, second succeeds."""
    svc = TextService(make_settings())
    call_count = 0

    async def fake_post_json(self_inner, url, payload):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise TextServiceError("transient", status_code=503)
        return {"choices": [{"text": "OK"}]}

    monkeypatch.setattr(TextService, "_post_json_with_retry", fake_post_json)

    async def mock_sleep(duration):
        pass

    monkeypatch.setattr(text_module.asyncio, "sleep", mock_sleep)

    await svc._probe_generate_capability(messages=[{"role": "user", "content": "hi"}])
    assert call_count == 2


@pytest.mark.asyncio
async def test_probe_generate_capability_raises_on_non_retryable_error(monkeypatch):
    """Non-retryable error raises immediately without retry."""
    svc = TextService(make_settings())

    async def fake_post_json(self_inner, url, payload):
        raise TextServiceAuthError("auth fail", status_code=401)

    monkeypatch.setattr(TextService, "_post_json_with_retry", fake_post_json)

    with pytest.raises(TextServiceAuthError):
        await svc._probe_generate_capability(messages=[{"role": "user", "content": "hi"}])


# --- probe() ---


@pytest.mark.asyncio
async def test_probe_returns_invalid_when_generate_fails(monkeypatch):
    """probe() returns invalid capability when generate probe fails."""
    svc = TextService(make_settings())

    async def fake_probe(self_inner, messages):
        raise TextServiceError("provider down")

    monkeypatch.setattr(TextService, "_probe_generate_capability", fake_probe)

    result = await svc.probe()
    assert result.status == "invalid"
    assert result.generate is False
    assert result.stream is False
    assert result.reason_code == "provider_generate_unavailable"



