"""Phase 0 migration tool: record a full fake-provider run's WS event stream.

Usage:
    python scripts/ws_snapshot.py --base-url http://127.0.0.1:18799 \
        --output docs/fixtures/ws-contract-snapshot.json

The backend must be started with fake providers so no external calls happen.
Answers every run_awaiting_confirm gate with an approval until the run
completes or fails, recording every WS frame as received.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import urllib.request
from typing import Any

import websockets


def _http_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    req = urllib.request.Request(
        base_url + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


async def capture(base_url: str, ws_base: str, global_timeout: float) -> dict[str, Any]:
    project = _http_json(
        base_url,
        "POST",
        "/api/v1/projects",
        {"title": "ws-contract-snapshot", "story": "主角在废弃灯塔中发现会说话的猫,一起揭开小镇的秘密。", "style": "anime"},
    )
    project_id = project["id"]
    print(f"project created id={project_id}")

    events: list[dict[str, Any]] = []
    run_id: int | None = None
    final_status = "timeout"
    ws_url = f"{ws_base}/ws/projects/{project_id}"

    async with websockets.connect(ws_url, max_size=None) as ws:
        print("ws connected")
        gen = _http_json(base_url, "POST", f"/api/v1/projects/{project_id}/generate", {})
        run_id = gen.get("run_id")
        print(f"generate accepted run_id={run_id}")

        deadline = time.monotonic() + global_timeout
        last_event_at = time.monotonic()
        while time.monotonic() < deadline:
            if time.monotonic() - last_event_at > 90:
                final_status = "stall"
                break
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
            except (asyncio.TimeoutError, TimeoutError):
                continue
            frame = json.loads(raw)
            events.append(frame)
            last_event_at = time.monotonic()
            etype = frame.get("type")
            data = frame.get("data") or {}
            print(f"  event: {etype}")
            if etype == "run_awaiting_confirm":
                confirm_run = data.get("run_id") or run_id
                # Approve = empty feedback; any non-empty feedback triggers a
                # revision loop (nodes.py: review_requested = bool(feedback)).
                await ws.send(
                    json.dumps({"type": "confirm", "data": {"run_id": confirm_run}})
                )
                print(f"  gate confirmed: {data.get('gate')}")
            elif etype in ("run_completed", "run_failed", "run_cancelled"):
                final_status = str(data.get("status") or etype)
                break
            elif etype == "error":
                print(f"  error event: {data}")

    return {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "base_url": base_url,
        "project_id": project_id,
        "run_id": run_id,
        "final_status": final_status,
        "event_count": len(events),
        "event_type_sequence": [e.get("type") for e in events],
        "events": events,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:18799")
    parser.add_argument("--output", default="docs/fixtures/ws-contract-snapshot.json")
    parser.add_argument("--global-timeout", type=float, default=420.0)
    args = parser.parse_args()

    ws_base = args.base_url.replace("http", "ws", 1)
    result = asyncio.run(capture(args.base_url, ws_base, args.global_timeout))
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"saved {args.output}: status={result['final_status']} events={result['event_count']}")


if __name__ == "__main__":
    main()
