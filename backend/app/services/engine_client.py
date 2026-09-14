"""Workflow-engine sidecar client and owned child-process lifecycle."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
from pathlib import Path
from collections.abc import Sequence
from typing import Any, BinaryIO
from urllib.parse import urlsplit

import httpx

from app.generated.workflow_contract import WORKFLOW_VERSION

logger = logging.getLogger("openOii.engine_client")

ENGINE_START_TIMEOUT_S = 20.0
ENGINE_STOP_TIMEOUT_S = 5.0
_ENGINE_DIR = Path(__file__).resolve().parents[3] / "engine"
_ENGINE_START_LOCK = asyncio.Lock()
_ENGINE_PROCESS: subprocess.Popen[bytes] | None = None
_ENGINE_LOG_HANDLE: BinaryIO | None = None


class EngineUnavailableError(RuntimeError):
    pass


class EngineConflictError(RuntimeError):
    def __init__(self, message: str, *, code: str = "RUN_ALREADY_ACTIVE") -> None:
        super().__init__(message)
        self.code = code


def engine_db_path(database_url: str) -> str | None:
    """Extract the sqlite file path from the app DATABASE_URL (None otherwise)."""
    if not database_url.startswith("sqlite"):
        return None
    from sqlalchemy.engine import make_url

    database = make_url(database_url).database
    if not database or database == ":memory:":
        return None
    path = Path(database)
    if not path.is_absolute():
        path = Path.cwd() / path
    return str(path.resolve())


def _close_engine_log() -> None:
    global _ENGINE_LOG_HANDLE
    if _ENGINE_LOG_HANDLE is not None:
        try:
            _ENGINE_LOG_HANDLE.close()
        finally:
            _ENGINE_LOG_HANDLE = None


async def shutdown_engine() -> None:
    """Stop the sidecar only when this backend process started it."""
    global _ENGINE_PROCESS

    process = _ENGINE_PROCESS
    _ENGINE_PROCESS = None
    if process is None:
        _close_engine_log()
        return

    if process.poll() is None:
        logger.info("stopping owned engine sidecar (pid=%s)", process.pid)
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, ENGINE_STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            logger.warning("engine sidecar did not terminate in time; killing pid=%s", process.pid)
            process.kill()
            try:
                await asyncio.to_thread(process.wait, ENGINE_STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                logger.error("engine sidecar still alive after kill (pid=%s)", process.pid)
    _close_engine_log()


async def engine_health(base_url: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{base_url}/health")
            if res.status_code != 200:
                return None
            payload = res.json()
            return payload if isinstance(payload, dict) else None
    except Exception:  # noqa: BLE001 - health probe intentionally degrades to unavailable
        return None


def _assert_engine_compatible(health: dict[str, Any]) -> None:
    actual = health.get("workflow_version")
    if actual != WORKFLOW_VERSION:
        raise EngineUnavailableError(
            "workflow engine version mismatch: "
            f"backend={WORKFLOW_VERSION}, engine={actual!r}; restart the sidecar"
        )


async def ensure_engine_running(base_url: str, database_url: str, static_dir: Path) -> None:
    """Ensure one compatible engine exists; spawn and own it when necessary."""
    global _ENGINE_PROCESS, _ENGINE_LOG_HANDLE

    health = await engine_health(base_url)
    if health is not None:
        _assert_engine_compatible(health)
        return

    async with _ENGINE_START_LOCK:
        health = await engine_health(base_url)
        if health is not None:
            _assert_engine_compatible(health)
            return

        db_path = engine_db_path(database_url)
        if db_path is None:
            raise EngineUnavailableError(
                "workflow engine requires DATABASE_URL=sqlite+aiosqlite:///… (shared file)"
            )

        if _ENGINE_PROCESS is not None and _ENGINE_PROCESS.poll() is not None:
            logger.warning(
                "owned engine process exited with code %s; restarting",
                _ENGINE_PROCESS.returncode,
            )
            _ENGINE_PROCESS = None
            _close_engine_log()

        if _ENGINE_PROCESS is None:
            env = os.environ.copy()
            env["ENGINE_DB_PATH"] = db_path
            env["ENGINE_STATIC_DIR"] = str(static_dir)
            node = shutil.which("node")
            tsx_cli = _ENGINE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"
            entry = _ENGINE_DIR / "src" / "index.ts"
            if node is None or not tsx_cli.exists():
                raise EngineUnavailableError(
                    "engine runtime missing: run `cd engine && pnpm install` first"
                )

            log_path = Path(db_path).parent / "engine.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            _ENGINE_LOG_HANDLE = log_path.open("ab", buffering=0)
            command = [node, str(tsx_cli), str(entry)]
            logger.info("starting owned workflow engine: %s", " ".join(command))
            _ENGINE_PROCESS = subprocess.Popen(  # noqa: S603 - fixed argv
                command,
                cwd=str(_ENGINE_DIR),
                env=env,
                stdout=_ENGINE_LOG_HANDLE,
                stderr=subprocess.STDOUT,
                start_new_session=False,
            )

        deadline = asyncio.get_running_loop().time() + ENGINE_START_TIMEOUT_S
        while asyncio.get_running_loop().time() < deadline:
            health = await engine_health(base_url)
            if health is not None:
                _assert_engine_compatible(health)
                return
            if _ENGINE_PROCESS is not None and _ENGINE_PROCESS.poll() is not None:
                code = _ENGINE_PROCESS.returncode
                await shutdown_engine()
                raise EngineUnavailableError(
                    f"engine exited during startup with code {code}; "
                    f"see {Path(db_path).parent / 'engine.log'}"
                )
            await asyncio.sleep(0.4)

        await shutdown_engine()
        raise EngineUnavailableError(f"engine did not become healthy at {base_url}")


async def engine_active_run_ids(base_url: str) -> set[int]:
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(f"{base_url}/runs")
            if res.status_code != 200:
                return set()
            payload = res.json()
    except Exception:  # noqa: BLE001 - probe failure means no confirmed process-local runner
        return set()
    runs = payload.get("runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        return set()
    return {int(r) for r in runs if isinstance(r, (int, float))}


async def engine_healthy(base_url: str) -> bool:
    health = await engine_health(base_url)
    return health is not None and health.get("workflow_version") == WORKFLOW_VERSION


def _raise_engine_response_error(action: str, res: httpx.Response) -> None:
    if res.status_code == 409:
        code = "RUN_ALREADY_ACTIVE"
        message = f"engine {action} conflict"
        try:
            payload = res.json()
            if isinstance(payload, dict):
                error = payload.get("error")
                if isinstance(error, dict):
                    code = str(error.get("code") or code)
                    message = str(error.get("message") or message)
        except ValueError:
            pass
        raise EngineConflictError(message, code=code)
    raise EngineUnavailableError(f"engine {action} failed: {res.status_code} {res.text[:200]}")


async def engine_start_run(
    base_url: str,
    *,
    project_id: int,
    run_id: int,
    stage: str = "full",
    auto_mode: bool = False,
    user_feedback: str = "",
    target_character_ids: Sequence[int] | None = None,
    target_shot_ids: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Dispatch a run to the engine.

    Targeted redraw / fill is expressed as entity scope, not as an agent plan:
    the engine owns which stages run (ADR 0008).
    """
    payload: dict[str, Any] = {
        "project_id": project_id,
        "run_id": run_id,
        "stage": stage,
        "auto_mode": auto_mode,
        "user_feedback": user_feedback,
    }
    if target_character_ids:
        payload["target_character_ids"] = list(target_character_ids)
    if target_shot_ids:
        payload["target_shot_ids"] = list(target_shot_ids)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(f"{base_url}/runs", json=payload)
    except httpx.HTTPError as exc:
        raise EngineUnavailableError(f"engine start failed: {exc}") from exc
    if res.status_code != 202:
        _raise_engine_response_error("start", res)
    return res.json()  # type: ignore[no-any-return]


async def engine_resume_run(base_url: str, *, project_id: int, run_id: int) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(
                f"{base_url}/runs/{run_id}/resume", json={"project_id": project_id}
            )
    except httpx.HTTPError as exc:
        raise EngineUnavailableError(f"engine resume failed: {exc}") from exc
    if res.status_code != 202:
        _raise_engine_response_error("resume", res)
    return res.json()  # type: ignore[no-any-return]


async def engine_cancel_run(base_url: str, run_id: int) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(f"{base_url}/runs/{run_id}/cancel")
    except httpx.HTTPError as exc:
        raise EngineUnavailableError(f"engine cancel failed: {exc}") from exc
    if res.status_code != 202:
        _raise_engine_response_error("cancel", res)


async def engine_events_since(base_url: str, run_id: int, after_seq: int) -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{base_url}/runs/{run_id}/events", params={"after": after_seq})
    except httpx.HTTPError:
        return []
    if res.status_code != 200:
        return []
    return res.json().get("events", [])  # type: ignore[no-any-return]


def redact_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.hostname or ''}:{parts.port or ''}"
