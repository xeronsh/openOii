from __future__ import annotations

import pytest

from app.config import Settings
from app.services.video import VideoService


def make_settings(**overrides):
    base = dict(
        video_base_url="https://video.example.com",
        video_endpoint="/v1/generate",
        video_model="video-model",
        request_timeout_s=5,
        video_api_key="token",
        video_api_secret="secret",
    )
    base.update(overrides)
    return Settings(database_url="sqlite+aiosqlite:///:memory:", **base)


def test_build_url_and_retryable_status():
    svc = VideoService(make_settings(video_endpoint="chat/completions"))
    assert svc._build_url() == "https://video.example.com/chat/completions"
    assert svc._is_retryable_status(429) is True
    assert svc._is_retryable_status(401) is False


def test_build_url_joins_slashes():
    svc = VideoService(
        make_settings(video_base_url="https://video.example.com/", video_endpoint="videos/generations")
    )
    assert svc._build_url() == "https://video.example.com/videos/generations"


def test_build_poll_url_for_yunwu_video_create():
    svc = VideoService(
        make_settings(video_base_url="https://yunwu.ai/v1", video_endpoint="/video/create")
    )
    assert svc._build_poll_url("task_abc") == "https://yunwu.ai/v1/video/query?id=task_abc"


def test_extract_url_returns_none_for_invalid_inputs():
    svc = VideoService(make_settings())
    assert svc._extract_url_from_text("") is None
    assert svc._extract_url_from_text(None) is None


def test_extract_url_from_text_and_sanitize():
    svc = VideoService(make_settings())
    assert svc._sanitize_url(" https://a.com/x.mp4). ") == "https://a.com/x.mp4"
    assert svc._extract_url_from_text("https://a.com/x.mp4).") == "https://a.com/x.mp4"
    assert svc._extract_url_from_text("prefix https://a.com/x.mp4 end") == "https://a.com/x.mp4"
    assert svc._extract_url_from_text("data:abc") == "data:abc"


@pytest.mark.asyncio
async def test_generate_uses_standard_payload(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/generate"))

    async def fake_post(url, payload):
        assert payload["prompt"] == "make a video"
        assert payload["duration"] == 7.5
        return {"ok": True}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)

    result = await svc.generate(prompt="make a video", duration=7.5, style="cinematic")

    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_generate_uses_grok_payload_with_string_seconds(monkeypatch):
    svc = VideoService(
        make_settings(
            video_base_url="https://yunwu.ai/v1",
            video_endpoint="/video/create",
            video_model="grok-video-3-10s",
        )
    )

    async def fake_post(url, payload):
        assert url == "https://yunwu.ai/v1/video/create"
        assert payload == {
            "model": "grok-video-3-10s",
            "prompt": "make a video",
            "seconds": "10",
            "size": "16:9",
        }
        return {"id": "task_abc", "status": "processing"}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)

    result = await svc.generate(prompt="make a video", duration=10)

    assert result == {"id": "task_abc", "status": "processing"}


@pytest.mark.asyncio
async def test_generate_uses_ltx_payload_without_model(monkeypatch):
    svc = VideoService(
        make_settings(
            video_base_url="https://l0veyou.com",
            video_endpoint="/api/generate/ltx-video",
            video_model="ltx-video",
        )
    )

    async def fake_post(url, payload):
        assert url == "https://l0veyou.com/api/generate/ltx-video"
        assert payload == {
            "client_task_id": "ltx-video-demo",
            "prompt": "make a video",
            "duration": 10,
            "aspect_ratio": "16:9",
            "style": "cinematic",
        }
        assert "model" not in payload
        return {"task_id": "ltx-video-demo", "status": "queued"}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)

    result = await svc.generate(
        prompt="make a video",
        duration=10,
        client_task_id="ltx-video-demo",
        aspect_ratio="16:9",
        style="cinematic",
    )

    assert result == {"task_id": "ltx-video-demo", "status": "queued"}


@pytest.mark.asyncio
async def test_generate_uses_chat_payload(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"))

    async def fake_post(url, payload):
        assert payload["messages"][0]["content"] == "make a video"
        assert payload["stream"] is False
        return {"ok": True}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)

    result = await svc.generate(prompt="make a video")

    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_generate_url_chat_stream_extracts_first_url(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"))

    async def fake_stream(url, payload):
        assert payload["stream"] is True
        return "video url: https://cdn.example.com/a.mp4"

    monkeypatch.setattr(svc, "_post_stream_with_retry", fake_stream)

    result = await svc.generate_url(prompt="make a video")

    assert result == "https://cdn.example.com/a.mp4"


@pytest.mark.asyncio
async def test_generate_url_standard_mode_returns_first_item(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/generate"))

    async def fake_generate(prompt, **kwargs):
        return {"data": [{"url": " https://cdn.example.com/a.mp4). "}]}

    monkeypatch.setattr(svc, "generate", fake_generate)

    result = await svc.generate_url(prompt="make a video")

    assert result == "https://cdn.example.com/a.mp4"


@pytest.mark.asyncio
async def test_generate_url_i2v_standard_mode(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/generate"))

    async def fake_post(url, payload):
        assert payload["image"] == "aW1n"
        return {"data": [{"url": "https://cdn.example.com/a.mp4"}]}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    result = await svc.generate_url(prompt="make a video", image_bytes=b"img")

    assert result == "https://cdn.example.com/a.mp4"


@pytest.mark.asyncio
async def test_generate_url_standard_mode_polls_async_task(monkeypatch):
    svc = VideoService(
        make_settings(
            video_base_url="https://yunwu.ai/v1",
            video_endpoint="/video/create",
            video_model="veo3.1-fast-components",
        )
    )

    async def fake_generate(prompt, **kwargs):
        return {"id": "task_abc", "status": "queued", "progress": 0}

    async def fake_poll(task_id, *, poll_interval_s=5.0, max_polls=120):
        assert task_id == "task_abc"
        return {
            "id": "task_abc",
            "status": "completed",
            "video_url": "https://cdn.example.com/out.mp4",
        }

    monkeypatch.setattr(svc, "generate", fake_generate)
    monkeypatch.setattr(svc, "_poll_task_until_done", fake_poll)

    result = await svc.generate_url(prompt="make a video")

    assert result == "https://cdn.example.com/out.mp4"


@pytest.mark.asyncio
async def test_generate_url_i2v_standard_mode_polls_async_task(monkeypatch):
    svc = VideoService(
        make_settings(
            video_base_url="https://yunwu.ai/v1",
            video_endpoint="/video/create",
            video_model="veo3.1-fast-components",
        )
    )

    async def fake_post(url, payload):
        assert payload["image"] == "aW1n"
        return {"task_id": "task_xyz", "status": "processing", "progress": 0}

    async def fake_poll(task_id, *, poll_interval_s=5.0, max_polls=120):
        assert task_id == "task_xyz"
        return {"status": "completed", "data": [{"url": "https://cdn.example.com/i2v.mp4"}]}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)
    monkeypatch.setattr(svc, "_poll_task_until_done", fake_poll)
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    result = await svc.generate_url(prompt="make a video", image_bytes=b"img")

    assert result == "https://cdn.example.com/i2v.mp4"


@pytest.mark.asyncio
async def test_generate_url_i2v_grok_payload_includes_reference_and_seconds(monkeypatch):
    svc = VideoService(
        make_settings(
            video_base_url="https://yunwu.ai/v1",
            video_endpoint="/video/create",
            video_model="grok-video-3-10s",
        )
    )

    async def fake_post(url, payload):
        assert url == "https://yunwu.ai/v1/video/create"
        assert payload == {
            "model": "grok-video-3-10s",
            "prompt": "make a video",
            "seconds": "10",
            "size": "16:9",
            "image": "aW1n",
        }
        return {"status": "completed", "video_url": "https://cdn.example.com/i2v.mp4"}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    result = await svc.generate_url(prompt="make a video", image_bytes=b"img", duration=10)

    assert result == "https://cdn.example.com/i2v.mp4"


@pytest.mark.asyncio
async def test_merge_urls_requires_videos():
    svc = VideoService(make_settings())
    with pytest.raises(RuntimeError, match="No video URLs"):
        await svc.merge_urls([])


@pytest.mark.asyncio
async def test_generate_url_raises_when_response_missing_url(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/generate"))

    async def fake_generate(prompt, **kwargs):
        return {"data": [{}]}

    monkeypatch.setattr(svc, "generate", fake_generate)

    with pytest.raises(RuntimeError, match="missing URL"):
        await svc.generate_url(prompt="make a video")


@pytest.mark.asyncio
async def test_generate_url_chat_stream_missing_url_raises(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"))

    async def fake_stream(url, payload):
        return "no url text"

    monkeypatch.setattr(svc, "_post_stream_with_retry", fake_stream)

    with pytest.raises(RuntimeError, match="missing URL"):
        await svc.generate_url(prompt="make a video")


@pytest.mark.asyncio
async def test_post_json_with_retry_returns_json_on_success(monkeypatch):
    svc = VideoService(make_settings(), max_retries=1)

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            return FakeResponse()

    monkeypatch.setattr(
        "app.services.video.httpx.AsyncClient", lambda *args, **kwargs: FakeClient()
    )

    assert await svc._post_json_with_retry("https://example.com", {"prompt": "x"}) == {"ok": True}


@pytest.mark.asyncio
async def test_post_stream_with_retry_collects_chunks(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=1)

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield 'data: {"choices": [{"delta": {"content": "https://cdn.example.com/a"}}]}'
            yield 'data: {"choices": [{"delta": {"content": ".mp4"}}]}'
            yield "data: [DONE]"

    class FakeStream:
        async def __aenter__(self):
            return FakeResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return FakeStream()

    monkeypatch.setattr(
        "app.services.video.httpx.AsyncClient", lambda *args, **kwargs: FakeClient()
    )

    assert (
        await svc._post_stream_with_retry("https://example.com", {"stream": True})
        == "https://cdn.example.com/a.mp4"
    )


@pytest.mark.asyncio
async def test_generate_url_uses_i2v_stream_path(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"))
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    async def fake_stream(url, payload):
        return "video url: https://cdn.example.com/a.mp4"

    monkeypatch.setattr(svc, "_post_stream_with_retry", fake_stream)

    assert (
        await svc.generate_url(prompt="make", image_bytes=b"img") == "https://cdn.example.com/a.mp4"
    )


@pytest.mark.asyncio
async def test_post_stream_with_retry_collects_reasoning_content(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=1)

    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield 'data: {"choices": [{"delta": {"content": "https://cdn.example.com/a"}}]}'
            yield 'data: {"choices": [{"delta": {"content": ".mp4"}}]}'
            yield 'data: {"choices": [{"delta": {"content": ""}}]}'
            yield "data: [DONE]"

    class FakeStream:
        async def __aenter__(self):
            return FakeResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return FakeStream()

    monkeypatch.setattr(
        "app.services.video.httpx.AsyncClient", lambda *args, **kwargs: FakeClient()
    )

    assert (
        await svc._post_stream_with_retry("https://example.com", {"stream": True})
        == "https://cdn.example.com/a.mp4"
    )


@pytest.mark.asyncio
async def test_merge_urls_delegates_to_video_merger(monkeypatch):
    from app.services import video_merger

    svc = VideoService(make_settings())

    class StubMerger:
        async def merge_videos(self, urls):
            assert urls == ["https://cdn.example.com/1.mp4", "https://cdn.example.com/2.mp4"]
            return "/static/videos/merged.mp4"

    monkeypatch.setattr(video_merger, "get_video_merger_service", lambda: StubMerger())

    url = await svc.merge_urls(["https://cdn.example.com/1.mp4", "https://cdn.example.com/2.mp4"])
    assert url == "/static/videos/merged.mp4"


# --- _post_json_with_retry error paths ---


@pytest.mark.asyncio
async def test_post_json_retries_on_retryable_status(monkeypatch):
    svc = VideoService(make_settings(), max_retries=1)
    call_count = {"n": 0}

    class RetryableResponse:
        status_code = 503

        def raise_for_status(self):
            import httpx

            raise httpx.HTTPStatusError("503", request=None, response=self)

        def json(self):
            return {}

    class OkResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return RetryableResponse()
            return OkResponse()

    async def noop_sleep(*a, **k):
        return None

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())
    monkeypatch.setattr("app.services.video.asyncio.sleep", noop_sleep)

    result = await svc._post_json_with_retry("https://example.com", {"prompt": "x"})
    assert result == {"ok": True}
    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_post_json_raises_on_non_retryable_status(monkeypatch):
    svc = VideoService(make_settings(), max_retries=2)

    class UnauthorizedResponse:
        status_code = 401

        def raise_for_status(self):
            import httpx

            raise httpx.HTTPStatusError("401", request=None, response=self)

        def json(self):
            return {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            return UnauthorizedResponse()

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    with pytest.raises(RuntimeError, match="request failed after retries"):
        await svc._post_json_with_retry("https://example.com", {"prompt": "x"})


@pytest.mark.asyncio
async def test_post_json_retries_on_network_error(monkeypatch):
    svc = VideoService(make_settings(), max_retries=1)
    call_count = {"n": 0}

    class OkResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            call_count["n"] += 1
            if call_count["n"] == 1:
                import httpx

                raise httpx.NetworkError("connection reset")
            return OkResponse()

    async def noop_sleep(*a, **k):
        return None

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())
    monkeypatch.setattr("app.services.video.asyncio.sleep", noop_sleep)

    result = await svc._post_json_with_retry("https://example.com", {"prompt": "x"})
    assert result == {"ok": True}


# --- _post_stream_with_retry error paths ---


@pytest.mark.asyncio
async def test_post_stream_retries_on_retryable_status(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=1)
    call_count = {"n": 0}

    class RetryableStreamResponse:
        status_code = 500

        def raise_for_status(self):
            import httpx

            raise httpx.HTTPStatusError("500", request=None, response=self)

        async def aiter_lines(self):
            if False:
                yield

    class OkStreamResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield 'data: {"choices": [{"delta": {"content": "https://cdn.example.com/a.mp4"}}]}'
            yield "data: [DONE]"

    class RetryableStream:
        async def __aenter__(self):
            return RetryableStreamResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class OkStream:
        async def __aenter__(self):
            return OkStreamResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return RetryableStream()
            return OkStream()

    async def noop_sleep(*a, **k):
        return None

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())
    monkeypatch.setattr("app.services.video.asyncio.sleep", noop_sleep)

    result = await svc._post_stream_with_retry("https://example.com", {"stream": True})
    assert result == "https://cdn.example.com/a.mp4"


@pytest.mark.asyncio
async def test_post_stream_raises_on_non_retryable_status(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=1)

    class UnauthorizedStreamResponse:
        status_code = 401

        def raise_for_status(self):
            import httpx

            raise httpx.HTTPStatusError("401", request=None, response=self)

        async def aiter_lines(self):
            if False:
                yield

    class UnauthorizedStream:
        async def __aenter__(self):
            return UnauthorizedStreamResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return UnauthorizedStream()

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    with pytest.raises(RuntimeError, match="stream failed after retries"):
        await svc._post_stream_with_retry("https://example.com", {"stream": True})


@pytest.mark.asyncio
async def test_post_stream_handles_error_in_stream_data(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=0)

    class ErrorResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield 'data: {"error": "rate limit exceeded"}'

    class ErrorStream:
        async def __aenter__(self):
            return ErrorResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return ErrorStream()

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    # RuntimeError from stream error propagates directly (not caught by retry logic)
    with pytest.raises(RuntimeError, match="Stream error"):
        await svc._post_stream_with_retry("https://example.com", {"stream": True})


@pytest.mark.asyncio
async def test_post_stream_skips_non_json_lines(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"), max_retries=0)

    class NoisyResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            yield "plain text line"
            yield 'data: {"choices": [{"delta": {"content": "https://cdn.example.com/v.mp4"}}]}'
            yield "data: [DONE]"

    class NoisyStream:
        async def __aenter__(self):
            return NoisyResponse()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def stream(self, *args, **kwargs):
            return NoisyStream()

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    result = await svc._post_stream_with_retry("https://example.com", {"stream": True})
    assert result == "https://cdn.example.com/v.mp4"


@pytest.mark.asyncio
async def test_post_json_raises_after_all_retries_exhausted(monkeypatch):
    svc = VideoService(make_settings(), max_retries=0)

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            import httpx

            raise httpx.TimeoutException("timeout")

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    with pytest.raises(RuntimeError, match="request failed after retries"):
        await svc._post_json_with_retry("https://example.com", {"prompt": "x"})


@pytest.mark.asyncio
async def test_post_json_breaks_on_non_retryable_http_error(monkeypatch):
    svc = VideoService(make_settings(), max_retries=2)
    call_count = {"n": 0}

    class ForbiddenResponse:
        status_code = 403

        def raise_for_status(self):
            import httpx

            raise httpx.HTTPStatusError("403", request=None, response=self)

        def json(self):
            return {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers, json):
            call_count["n"] += 1
            return ForbiddenResponse()

    monkeypatch.setattr("app.services.video.httpx.AsyncClient", lambda *a, **k: FakeClient())

    with pytest.raises(RuntimeError, match="request failed after retries"):
        await svc._post_json_with_retry("https://example.com", {"prompt": "x"})
    assert call_count["n"] == 1  # broke immediately on non-retryable


# --- i2v missing URL paths ---


@pytest.mark.asyncio
async def test_generate_url_i2v_stream_missing_url_raises(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/chat/completions"))
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    async def fake_stream(url, payload):
        return "no url text"

    monkeypatch.setattr(svc, "_post_stream_with_retry", fake_stream)

    with pytest.raises(RuntimeError, match="missing URL"):
        await svc.generate_url(prompt="make", image_bytes=b"img")


@pytest.mark.asyncio
async def test_generate_url_i2v_standard_missing_url_raises(monkeypatch):
    svc = VideoService(make_settings(video_endpoint="/v1/generate"))
    object.__setattr__(svc.settings, "use_i2v", lambda: True)

    async def fake_post(url, payload):
        return {"data": []}

    monkeypatch.setattr(svc, "_post_json_with_retry", fake_post)

    with pytest.raises(RuntimeError, match="missing URL"):
        await svc.generate_url(prompt="make", image_bytes=b"img")
