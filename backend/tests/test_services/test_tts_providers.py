"""TTS providers: request shape per vendor, error mapping, and the read-only probe."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from app.services import tts_providers as tts
from app.services.tts_providers import TTSConfig, TTSProviderError

KEY = "tts-secret-key"


@pytest.fixture
def mock_http(monkeypatch):
    """Route every httpx.AsyncClient in the module through a scripted handler."""
    real_client = httpx.AsyncClient
    calls: list[httpx.Request] = []
    state: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return state["respond"](request)

    def factory(**kwargs):
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(tts.httpx, "AsyncClient", factory)

    def use(respond):
        state["respond"] = respond
        return calls

    return use


def cfg(provider: str, **kw) -> TTSConfig:
    return TTSConfig.build(provider, kw.get("base_url"), kw.get("api_key", KEY), kw.get("model"))


def test_build_fills_defaults_and_strips_slash():
    c = TTSConfig.build("OpenAI", "https://proxy.example/v1/", None, None)
    assert c == TTSConfig("openai", "https://proxy.example/v1", "", "gpt-4o-mini-tts")
    assert TTSConfig.build("", None, None, None).provider == "edge"
    assert TTSConfig.build("unknown", None, "k", None).base_url == ""
    assert tts.default_voice("azure") == "zh-CN-XiaoxiaoNeural"
    assert tts.default_voice("nope") == tts.DEFAULTS["edge"]["voice"]


async def test_synthesize_needs_a_key_except_edge():
    with pytest.raises(TTSProviderError, match="TTS_API_KEY"):
        await tts.synthesize(cfg("openai", api_key=""), "hi", "marin")


async def test_synthesize_rejects_unknown_provider(mock_http):
    mock_http(lambda r: httpx.Response(200))
    with pytest.raises(TTSProviderError, match="不支持"):
        await tts.synthesize(cfg("mystery"), "hi", "v")


@pytest.mark.parametrize(
    ("provider", "path", "header", "value"),
    [
        ("openai", "/v1/audio/speech", "authorization", f"Bearer {KEY}"),
        ("elevenlabs", "/v1/text-to-speech/voice-1", "xi-api-key", KEY),
        ("azure", "/cognitiveservices/v1", "ocp-apim-subscription-key", KEY),
    ],
)
async def test_simple_vendors_post_text_and_return_audio(mock_http, provider, path, header, value):
    calls = mock_http(lambda r: httpx.Response(200, content=b"mp3"))
    voice = "zh-CN-Yunxi<Neural>" if provider == "azure" else "voice-1"
    assert await tts.synthesize(cfg(provider), "你好 & <hi>", voice) == b"mp3"
    (req,) = calls
    assert req.url.path == path
    assert req.headers[header] == value
    if provider == "azure":
        body = req.content.decode()
        assert "xml:lang='zh-CN'" in body and "&lt;hi&gt;" in body and "&amp;" in body
    else:
        assert "你好" in req.content.decode()


@pytest.mark.parametrize(("status", "message"), [(401, "拒绝了密钥"), (403, "拒绝了密钥"), (500, "HTTP 500")])
async def test_http_errors_are_mapped_without_the_key(mock_http, status, message):
    mock_http(lambda r: httpx.Response(status, text="upstream broke"))
    with pytest.raises(TTSProviderError, match=message) as exc:
        await tts.synthesize(cfg("openai"), "hi", "marin")
    assert KEY not in str(exc.value)


async def test_minimax_decodes_hex_audio_and_maps_status_codes(mock_http):
    bodies = iter(
        [
            {"base_resp": {"status_code": 0}, "data": {"audio": b"ok".hex()}},
            {"base_resp": {"status_code": 1004}},
            {"base_resp": {"status_code": 2013, "status_msg": "bad voice"}},
            {"base_resp": {}, "data": {}},
        ]
    )
    calls = mock_http(lambda r: httpx.Response(200, json=next(bodies)))
    assert await tts.synthesize(cfg("minimax"), "hi", "v") == b"ok"
    assert json.loads(calls[0].content)["voice_setting"]["voice_id"] == "v"
    with pytest.raises(TTSProviderError, match="1004"):
        await tts.synthesize(cfg("minimax"), "hi", "v")
    with pytest.raises(TTSProviderError, match="bad voice"):
        await tts.synthesize(cfg("minimax"), "hi", "v")
    with pytest.raises(TTSProviderError, match="没有返回音频"):
        await tts.synthesize(cfg("minimax"), "hi", "v")


async def test_cosyvoice_downloads_the_returned_url(mock_http):
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.host == "oss.example":
            return httpx.Response(200, content=b"cosy")
        return httpx.Response(200, json={"output": {"audio": {"url": "https://oss.example/a.mp3"}}})

    calls = mock_http(respond)
    assert await tts.synthesize(cfg("cosyvoice"), "hi", "longanyang") == b"cosy"
    assert [c.url.host for c in calls] == ["dashscope.aliyuncs.com", "oss.example"]

    mock_http(lambda r: httpx.Response(200, json={"code": "InvalidParameter"}))
    with pytest.raises(TTSProviderError, match="InvalidParameter"):
        await tts.synthesize(cfg("cosyvoice"), "hi", "longanyang")


async def test_doubao_joins_streamed_chunks_and_stops_on_error(mock_http):
    lines = "\n".join(
        [
            json.dumps({"code": 0, "data": base64.b64encode(b"ab").decode()}),
            "",
            "not json",
            json.dumps({"code": 0, "data": base64.b64encode(b"cd").decode()}),
            json.dumps({"code": 20000000}),
        ]
    )
    calls = mock_http(lambda r: httpx.Response(200, text=lines))
    assert await tts.synthesize(cfg("doubao"), "hi", "spk") == b"abcd"
    assert calls[0].headers["x-api-key"] == KEY

    mock_http(lambda r: httpx.Response(200, text=json.dumps({"code": 45000001, "message": "quota"})))
    with pytest.raises(TTSProviderError, match="quota"):
        await tts.synthesize(cfg("doubao"), "hi", "spk")

    mock_http(lambda r: httpx.Response(200, text=json.dumps({"code": 20000000})))
    with pytest.raises(TTSProviderError, match="没有返回音频"):
        await tts.synthesize(cfg("doubao"), "hi", "spk")

    mock_http(lambda r: httpx.Response(401, text="no"))
    with pytest.raises(TTSProviderError, match="拒绝了密钥"):
        await tts.synthesize(cfg("doubao"), "hi", "spk")


async def test_probe_edge_lists_voices(monkeypatch):
    import edge_tts

    async def voices():
        return [{"ShortName": "zh-CN-XiaoxiaoNeural"}, {"ShortName": "en-US-AriaNeural"}]

    monkeypatch.setattr(edge_tts, "list_voices", voices)
    ok = await tts.probe(cfg("edge"), "zh-CN-XiaoxiaoNeural")
    assert (ok.success, ok.status) == (True, "valid") and "2 个音色" in ok.details
    missing = await tts.probe(cfg("edge"), "zh-CN-Nobody")
    assert missing.status == "degraded"

    async def broken():
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(edge_tts, "list_voices", broken)
    assert (await tts.probe(cfg("edge"), "x")).status == "invalid"


async def test_probe_without_key_or_for_unknown_or_doubao():
    assert (await tts.probe(cfg("azure", api_key=""), "v")).message == "缺少 API Key"
    assert (await tts.probe(cfg("mystery"), "v")).message == "不支持的配音服务商"
    assert (await tts.probe(cfg("doubao"), "v")).status == "degraded"


async def test_probe_openai_uses_the_shared_compatible_probe(monkeypatch):
    seen = {}

    async def fake_probe(**kwargs):
        seen.update(kwargs)
        return "probed"

    monkeypatch.setattr("app.services.connection_probe.probe_openai_compatible", fake_probe)
    assert await tts.probe(cfg("openai"), "marin") == "probed"
    assert seen["endpoint"] == "/audio/speech" and seen["label"] == "配音"


@pytest.mark.parametrize(
    ("provider", "method", "path"),
    [
        ("elevenlabs", "GET", "/v1/voices"),
        ("azure", "GET", "/cognitiveservices/voices/list"),
        ("minimax", "POST", "/v1/get_voice"),
        ("cosyvoice", "GET", "/compatible-mode/v1/models"),
    ],
)
async def test_probe_read_only_endpoints(mock_http, provider, method, path):
    calls = mock_http(lambda r: httpx.Response(200, json={"base_resp": {"status_code": 0}}))
    result = await tts.probe(cfg(provider), "v")
    assert (result.success, result.status) == (True, "valid")
    assert (calls[0].method, calls[0].url.path) == (method, path)


async def test_probe_maps_failures(mock_http):
    mock_http(lambda r: httpx.Response(401))
    assert (await tts.probe(cfg("azure"), "v")).status == "invalid"

    mock_http(lambda r: httpx.Response(200, json={"base_resp": {"status_code": 1004}}))
    assert (await tts.probe(cfg("minimax"), "v")).message == "MiniMax 拒绝了请求"

    mock_http(lambda r: httpx.Response(200, text="not json"))
    assert (await tts.probe(cfg("minimax"), "v")).status == "valid"

    def boom(request):
        raise httpx.ConnectError("refused")

    mock_http(boom)
    assert (await tts.probe(cfg("elevenlabs"), "v")).success is False
