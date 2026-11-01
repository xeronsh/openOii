"""Background-music providers: request shape, error mapping, and the read-only probe."""

from __future__ import annotations

import json

import httpx
import pytest

from app.services import bgm_providers as bgm
from app.services.bgm_providers import BGMConfig, BGMProviderError

KEY = "bgm-secret-key"


@pytest.fixture
def mock_http(monkeypatch):
    real_client = httpx.AsyncClient
    calls: list[httpx.Request] = []
    state: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return state["respond"](request)

    monkeypatch.setattr(
        bgm.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )

    def use(respond):
        state["respond"] = respond
        return calls

    return use


def cfg(provider: str, **kw) -> BGMConfig:
    return BGMConfig.build(provider, kw.get("base_url"), kw.get("api_key", KEY), kw.get("model"))


def test_build_and_prompt():
    assert BGMConfig.build(None, None, None, None) == BGMConfig("library", "", "", "")
    assert BGMConfig.build("MiniMax", "https://x.example/v1/", "k", None).base_url == "https://x.example/v1"
    assert "cheerful" in bgm.music_prompt("happy", None) and "animated short film" in bgm.music_prompt("happy", None)
    assert "calm" in bgm.music_prompt("unknown", "noir") and "noir animated short" in bgm.music_prompt("x", "noir")


async def test_generate_needs_key_and_known_provider(mock_http):
    with pytest.raises(BGMProviderError, match="BGM_API_KEY"):
        await bgm.generate(cfg("stability", api_key=""), "p", 10)
    mock_http(lambda r: httpx.Response(200))
    with pytest.raises(BGMProviderError, match="不支持"):
        await bgm.generate(cfg("library"), "p", 10)


async def test_minimax_hex_audio_and_status_codes(mock_http):
    bodies = iter(
        [
            {"base_resp": {"status_code": 0}, "data": {"audio": b"song".hex()}},
            {"base_resp": {"status_code": 1004}},
            {"base_resp": {"status_code": 2049, "status_msg": "busy"}},
            {"data": {}},
        ]
    )
    calls = mock_http(lambda r: httpx.Response(200, json=next(bodies)))
    assert await bgm.generate(cfg("minimax"), "p", 10) == b"song"
    assert json.loads(calls[0].content)["is_instrumental"] is True
    assert calls[0].headers["authorization"] == f"Bearer {KEY}"
    for match in ("1004", "busy", "没有返回音频"):
        with pytest.raises(BGMProviderError, match=match):
            await bgm.generate(cfg("minimax"), "p", 10)


async def test_stability_clamps_duration_and_maps_errors(mock_http):
    calls = mock_http(lambda r: httpx.Response(200, content=b"audio"))
    assert await bgm.generate(cfg("stability"), "p", 500.2) == b"audio"
    assert b'name="duration"\r\n\r\n190' in calls[0].content
    await bgm.generate(cfg("stability"), "p", 0)
    assert b'name="duration"\r\n\r\n1' in calls[1].content

    mock_http(lambda r: httpx.Response(200, content=b""))
    with pytest.raises(BGMProviderError, match="没有返回音频"):
        await bgm.generate(cfg("stability"), "p", 5)
    for status, match in ((403, "拒绝了密钥"), (502, "HTTP 502")):
        mock_http(lambda r, s=status: httpx.Response(s, text="nope"))
        with pytest.raises(BGMProviderError, match=match) as exc:
            await bgm.generate(cfg("stability"), "p", 5)
        assert KEY not in str(exc.value)


async def test_suno_gateway_shapes(mock_http):
    with pytest.raises(BGMProviderError, match="BGM_BASE_URL"):
        mock_http(lambda r: httpx.Response(200))
        await bgm.generate(cfg("suno"), "p", 5)

    def respond_with(body):
        def respond(request: httpx.Request) -> httpx.Response:
            if request.url.host == "cdn.example":
                return httpx.Response(200, content=b"suno")
            return httpx.Response(200, json=body)

        return respond

    clip = {"audio_url": "https://cdn.example/a.mp3"}
    for body in ([{"id": 1}, clip], {"data": [clip]}, {"clips": [clip]}):
        calls = mock_http(respond_with(body))
        assert await bgm.generate(cfg("suno", base_url="https://gw.example"), "p", 5) == b"suno"
    assert calls[-2].headers["authorization"] == f"Bearer {KEY}"

    calls = mock_http(respond_with([clip]))
    await bgm.generate(cfg("suno", base_url="https://gw.example", api_key=""), "p", 5)
    assert "authorization" not in calls[-2].headers

    mock_http(respond_with({"data": []}))
    with pytest.raises(BGMProviderError, match="audio_url"):
        await bgm.generate(cfg("suno", base_url="https://gw.example"), "p", 5)


async def test_probe_library_missing_key_and_unknown():
    lib = await bgm.probe(cfg("library"), 7)
    assert lib.success and "7 首" in lib.details
    assert (await bgm.probe(cfg("minimax", api_key=""), 0)).message == "缺少 API Key"
    assert (await bgm.probe(cfg("suno"), 0)).message == "缺少接口地址"
    assert (await bgm.probe(cfg("mystery"), 0)).message == "不支持的背景音乐服务商"


async def test_probe_endpoints_and_outcomes(mock_http):
    calls = mock_http(lambda r: httpx.Response(200, json={"base_resp": {"status_code": 0}}))
    assert (await bgm.probe(cfg("minimax"), 0)).status == "degraded"
    assert (calls[-1].method, calls[-1].url.path) == ("POST", "/v1/get_voice")
    assert (await bgm.probe(cfg("stability"), 0)).status == "valid"
    assert calls[-1].url.path == "/v1/user/balance"
    assert (await bgm.probe(cfg("suno", base_url="https://gw.example"), 0)).status == "valid"
    assert calls[-1].url.path == "/api/get_limit"
    await bgm.probe(cfg("suno", base_url="https://gw.example", api_key=""), 0)
    assert "authorization" not in calls[-1].headers

    mock_http(lambda r: httpx.Response(200, json={"base_resp": {"status_code": 1004}}))
    assert (await bgm.probe(cfg("minimax"), 0)).message == "MiniMax 拒绝了请求"
    mock_http(lambda r: httpx.Response(200, text="html"))
    assert (await bgm.probe(cfg("minimax"), 0)).status == "degraded"
    mock_http(lambda r: httpx.Response(401))
    assert (await bgm.probe(cfg("stability"), 0)).success is False

    def boom(request):
        raise httpx.ConnectTimeout("slow")

    mock_http(boom)
    assert (await bgm.probe(cfg("stability"), 0)).status == "invalid"
