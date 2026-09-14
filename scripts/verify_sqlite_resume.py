"""Phase 2 migration verification: checkpoints survive a backend restart.

Scenario:
1. start a fake-provider run and leave it paused at the first approval gate
2. the caller kills the backend process (simulated by --stop-after-gate)
3. after restart, POST /resume and drive all gates to completion

Usage (two invocations):
    python scripts/verify_sqlite_resume.py --phase wait   # exits once paused
    python scripts/verify_sqlite_resume.py --phase resume # after backend restart
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import urllib.request
from typing import Any

import websockets

STATE_FILE = "/tmp/ws-snapshot/resume-verify-state.json"


def _http_json(base_url: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    req = urllib.request.Request(
        base_url + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


async def _drive_gates(ws, run_id: int | None, stop_at_first_gate: bool) -> str:
    deadline = time.monotonic() + 240
    gates_confirmed = 0
    while time.monotonic() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
        except (asyncio.TimeoutError, TimeoutError):
            continue
        frame = json.loads(raw)
        etype = frame.get("type")
        data = frame.get("data") or {}
        if etype == "run_awaiting_confirm":
            if stop_at_first_gate and gates_confirmed == 0:
                return "paused-at-gate"
            confirm_run = data.get("run_id") or run_id
            await ws.send(json.dumps({"type": "confirm", "data": {"run_id": confirm_run}}))
            gates_confirmed += 1
        elif etype in ("run_completed", "run_failed", "run_cancelled"):
            status = str(data.get("status") or etype)
            return "completed" if etype == "run_completed" else status
    return "timeout"


async def phase_wait(base_url: str, ws_base: str) -> None:
    project = _http_json(
        base_url,
        "POST",
        "/api/v1/projects",
        {"title": "sqlite-resume-verify", "story": "猫在图书馆夜里守卫会说话的书。", "style": "anime"},
    )
    project_id = project["id"]
    async with websockets.connect(f"{ws_base}/ws/projects/{project_id}", max_size=None) as ws:
        gen = _http_json(base_url, "POST", f"/api/v1/projects/{project_id}/generate", {})
        run_id = gen.get("run_id") or gen.get("id")
        result = await _drive_gates(ws, run_id, stop_at_first_gate=True)
    assert result == "paused-at-gate", f"expected to pause at gate, got {result}"
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"project_id": project_id, "run_id": run_id}, f)
    print(f"paused at first gate: project={project_id} run={run_id} — kill the backend now")


async def phase_resume(base_url: str, ws_base: str) -> None:
    with open(STATE_FILE, encoding="utf-8") as f:
        state = json.load(f)
    project_id, run_id = state["project_id"], state["run_id"]

    # generate-state 水合接口应报告可恢复
    recovery = _http_json(base_url, "GET", f"/api/v1/projects/{project_id}/generation-state")
    assert recovery is not None, "run state lost after restart — checkpoints not durable"
    print(f"recovery surface after restart: state={recovery.get('state')}")

    async with websockets.connect(f"{ws_base}/ws/projects/{project_id}", max_size=None) as ws:
        _http_json(
            base_url, "POST", f"/api/v1/projects/{project_id}/resume", {"run_id": run_id}
        )
        result = await _drive_gates(ws, run_id, stop_at_first_gate=False)
    assert result == "completed", f"resume did not complete: {result}"
    print("RESUME VERIFIED: run completed after process restart")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["wait", "resume"], required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18799")
    args = parser.parse_args()
    ws_base = args.base_url.replace("http", "ws", 1)
    if args.phase == "wait":
        asyncio.run(phase_wait(args.base_url, ws_base))
    else:
        asyncio.run(phase_resume(args.base_url, ws_base))


if __name__ == "__main__":
    main()
