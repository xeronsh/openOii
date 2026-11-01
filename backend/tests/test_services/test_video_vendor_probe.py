"""服务商原生视频接口的「测试连接」：只读 / 只鉴权，不提交任务，不泄露密钥。"""

from __future__ import annotations

import httpx
import pytest

from app.services.provider_resolution import VIDEO_PROVIDER_KEYS
from app.services.video_vendor_probe import probe_video_vendor

KEY = "vendor-secret-key-123"


def _transport(status: int, body: object, seen: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


async def _probe(provider: str, base: str, status: int, body: object, model: str | None = None):
    seen: list[httpx.Request] = []
    outcome = await probe_video_vendor(
        provider=provider,
        base_url=base,
        api_key=KEY,
        model=model,
        transport=_transport(status, body, seen),
    )
    assert KEY not in outcome.message and KEY not in outcome.details
    return outcome, seen


@pytest.mark.asyncio
async def test_kling_reads_account_costs():
    outcome, seen = await _probe("kling", "https://api-beijing.klingai.com", 200, {"code": 0, "data": {}})
    assert outcome.success is True
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/account/costs"
    assert "start_time" in seen[0].url.params
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"


@pytest.mark.asyncio
async def test_kling_business_auth_code_is_invalid():
    outcome, _ = await _probe("kling", "https://api-beijing.klingai.com", 200, {"code": 1002, "message": "bad"})
    assert outcome.success is False
    assert outcome.message == "API Key 无效"


@pytest.mark.asyncio
async def test_vidu_lists_tasks_with_token_auth():
    outcome, seen = await _probe("vidu", "https://api.vidu.cn", 200, {"tasks": []})
    assert outcome.success is True
    assert seen[0].url.path == "/ent/v2/tasks"
    assert seen[0].headers["authorization"] == f"Token {KEY}"


@pytest.mark.asyncio
async def test_zhipu_missing_task_means_authenticated():
    outcome, seen = await _probe("zhipu", "https://open.bigmodel.cn/api/paas/v4", 404, {"error": {"code": "1214"}})
    assert outcome.success is True
    assert seen[0].url.path.startswith("/api/paas/v4/async-result/")


@pytest.mark.asyncio
async def test_zhipu_401_is_invalid():
    outcome, _ = await _probe("zhipu", "https://open.bigmodel.cn/api/paas/v4", 401, {})
    assert outcome.success is False
    assert outcome.message == "API Key 无效"


@pytest.mark.asyncio
async def test_minimax_base_resp_auth_failure():
    outcome, seen = await _probe(
        "minimax", "https://api.minimaxi.com/v1", 200, {"base_resp": {"status_code": 2049, "status_msg": "invalid api key"}}
    )
    assert outcome.success is False
    assert outcome.message == "API Key 无效"
    assert seen[0].url.path == "/v1/query/video_generation"


@pytest.mark.asyncio
async def test_minimax_unknown_task_is_ok():
    outcome, _ = await _probe("minimax", "https://api.minimaxi.com/v1", 200, {"base_resp": {"status_code": 2013}})
    assert outcome.success is True


@pytest.mark.asyncio
async def test_dashscope_unknown_task_is_ok():
    outcome, seen = await _probe(
        "dashscope", "https://dashscope.aliyuncs.com/api/v1", 200, {"output": {"task_status": "UNKNOWN"}}
    )
    assert outcome.success is True
    assert seen[0].url.path.startswith("/api/v1/tasks/")


@pytest.mark.asyncio
async def test_veo_fetch_operation_uses_api_key_header():
    outcome, seen = await _probe(
        "veo", "https://aiplatform.googleapis.com/v1", 404, {"error": {"status": "NOT_FOUND"}}, model="veo-3.1-generate-001"
    )
    assert outcome.success is True
    assert "实验性" in outcome.details
    assert seen[0].method == "POST"
    assert seen[0].url.path.endswith("veo-3.1-generate-001:fetchPredictOperation")
    assert seen[0].headers["x-goog-api-key"] == KEY


@pytest.mark.asyncio
async def test_veo_invalid_key_400_is_invalid():
    outcome, _ = await _probe(
        "veo", "https://aiplatform.googleapis.com/v1", 400, {"error": {"message": "API key not valid. Please pass a valid API key."}}
    )
    assert outcome.success is False
    assert outcome.message == "API Key 无效"


@pytest.mark.asyncio
async def test_missing_key_or_base_url():
    no_key = await probe_video_vendor(provider="kling", base_url="https://x", api_key=None, model=None)
    assert no_key.message == "缺少 API Key"
    no_base = await probe_video_vendor(provider="kling", base_url="", api_key=KEY, model=None)
    assert no_base.message == "缺少 Base URL"


def test_vendor_keys_are_supported():
    for key in ("kling", "vidu", "zhipu", "minimax", "dashscope", "veo"):
        assert key in VIDEO_PROVIDER_KEYS


@pytest.mark.asyncio
async def test_snapshot_pins_vendor_ratio_and_video_api_key(test_session, test_settings):
    from app.services.provider_resolution import resolve_project_provider_settings
    from app.services.run_context import build_run_context_snapshot
    from tests.factories import create_project

    settings = test_settings.model_copy(
        update={
            "video_provider": "kling",
            "video_api_key": KEY,
            "video_ratio": "9:16",
            "video_base_url": "https://api-beijing.klingai.com",
            "video_model": "kling-3.0",
        }
    )
    project = await create_project(test_session)
    resolution = resolve_project_provider_settings(project, settings)
    assert resolution.video.resolved_key == "kling"
    snapshot = await build_run_context_snapshot(
        session=test_session, settings=settings, project=project, provider_resolution=resolution
    )
    video = snapshot["providers"]["video"] if "providers" in snapshot else snapshot["video"]
    assert video["provider"] == "kling"
    assert video["ratio"] == "9:16"
    assert video["credential_keys"] == ["VIDEO_API_KEY"]
    assert KEY not in str(snapshot)
