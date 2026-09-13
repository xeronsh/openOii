"""pi-engine sidecar client.

The engine owns run execution; the Python API keeps the HTTP/WS surface and
tails engine_run_events. Communication is loopback HTTP + the shared SQLite
file.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("openOii.engine_client")

ENGINE_START_TIMEOUT_S = 20.0
_ENGINE_DIR = Path(__file__).resolve().parents[3] / "engine"


class EngineUnavailableError(RuntimeError):
    pass


def engine_db_path(database_url: str) -> str | None:
    """Extract the sqlite file path from the app DATABASE_URL (None otherwise)."""
    if not database_url.startswith("sqlite"):
        return None
    from sqlalchemy.engine import make_url

    database = make_url(database_url).database
    if not database or database == ":memory:":
        return None
    # 引擎进程的 CWD 是 engine/，相对路径必须先在 Python 侧固定为绝对路径，
    # 否则两边会各创建各的库。
    path = Path(database)
    if not path.is_absolute():
        path = Path.cwd() / path
    return str(path.resolve())


async def ensure_engine_running(base_url: str, database_url: str, static_dir: Path) -> None:
    """Health-check the engine; start it as a subprocess when unreachable."""
    if await engine_healthy(base_url):
        return

    db_path = engine_db_path(database_url)
    if db_path is None:
        raise EngineUnavailableError(
            "pi engine requires DATABASE_URL=sqlite+aiosqlite:///… (shared file)"
        )

    env = os.environ.copy()
    env["ENGINE_DB_PATH"] = db_path
    env["ENGINE_STATIC_DIR"] = str(static_dir)
    env["TEXT_PROVIDER"] = env.get("TEXT_PROVIDER", "")
    node = shutil.which("node")
    tsx_cli = _ENGINE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"
    entry = _ENGINE_DIR / "src" / "index.ts"
    if node is None or not tsx_cli.exists():
        raise EngineUnavailableError(
            "engine runtime missing: run `cd engine && pnpm install` first"
        )
    command = [node, str(tsx_cli), str(entry)]
    logger.info("starting engine sidecar: %s", " ".join(command))
    subprocess.Popen(  # noqa: S603 - fixed argv
        command,
        cwd=str(_ENGINE_DIR),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    deadline = asyncio.get_running_loop().time() + ENGINE_START_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        if await engine_healthy(base_url):
            return
        await asyncio.sleep(0.4)
    raise EngineUnavailableError(f"engine did not become healthy at {base_url}")


async def engine_active_run_ids(base_url: str) -> set[int]:
    """Run ids the engine is actually executing.

    Python 不拥有执行（引擎才是编排者），所以“是否正在跑”只能问引擎。
    引擎不可达时返回空集：此时没有可信的执行中 run。
    """
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{base_url}/runs")
            if res.status_code != 200:
                return set()
            payload = res.json()
    except Exception:  # noqa: BLE001 - 探活失败等价于“没有活跃 run”
        return set()
    runs = payload.get("runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        return set()
    return {int(r) for r in runs if isinstance(r, (int, float))}


async def engine_healthy(base_url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{base_url}/health")
            return res.status_code == 200
    except Exception:  # noqa: BLE001
        return False


async def engine_start_run(
    base_url: str,
    *,
    project_id: int,
    run_id: int,
    stage: str = "full",
    auto_mode: bool = False,
    user_feedback: str = "",
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(
            f"{base_url}/runs",
            json={
                "project_id": project_id,
                "run_id": run_id,
                "stage": stage,
                "auto_mode": auto_mode,
                "user_feedback": user_feedback,
            },
        )
        if res.status_code != 202:
            raise EngineUnavailableError(f"engine start failed: {res.status_code} {res.text[:200]}")
        return res.json()  # type: ignore[no-any-return]


async def engine_resume_run(base_url: str, *, project_id: int, run_id: int) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(
            f"{base_url}/runs/{run_id}/resume", json={"project_id": project_id}
        )
        if res.status_code != 202:
            raise EngineUnavailableError(f"engine resume failed: {res.status_code} {res.text[:200]}")
        return res.json()  # type: ignore[no-any-return]


async def engine_cancel_run(base_url: str, run_id: int) -> None:
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(f"{base_url}/runs/{run_id}/cancel")


async def engine_events_since(base_url: str, run_id: int, after_seq: int) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(f"{base_url}/runs/{run_id}/events", params={"after": after_seq})
        if res.status_code != 200:
            return []
        return res.json().get("events", [])  # type: ignore[no-any-return]


def redact_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.hostname or ''}:{parts.port or ''}"
