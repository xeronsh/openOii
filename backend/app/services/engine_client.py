"""Workflow-engine sidecar client and owned child-process lifecycle."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from collections.abc import Sequence
from typing import Any, BinaryIO

import httpx

from app.generated.workflow_contract import WORKFLOW_VERSION

logger = logging.getLogger("openOii.engine_client")

ENGINE_START_TIMEOUT_S = 20.0
ENGINE_STOP_TIMEOUT_S = 5.0
_ENGINE_DIR = Path(__file__).resolve().parents[3] / "engine"
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ENGINE_START_LOCK = asyncio.Lock()
_ENGINE_PROCESS: subprocess.Popen[bytes] | None = None
_ENGINE_LOG_HANDLE: BinaryIO | None = None


class EngineUnavailableError(RuntimeError):
    pass


class EngineConflictError(RuntimeError):
    def __init__(self, message: str, *, code: str = "RUN_ALREADY_ACTIVE") -> None:
        super().__init__(message)
        self.code = code


class EngineRunNotFoundError(EngineUnavailableError):
    """The engine has no such run for this project (404 RUN_NOT_FOUND).

    Subclasses EngineUnavailableError so callers that only know about outages keep
    their behaviour; the run routes map it to a 404 instead of a retryable 503.
    """

    def __init__(self, message: str, *, code: str = "RUN_NOT_FOUND") -> None:
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
            env.setdefault("ENGINE_PYTHON", sys.executable)
            env["ENGINE_BACKEND_DIR"] = str(_BACKEND_DIR)
            # The chat agent's tools call this backend's product API over loopback.
            env.setdefault("OPENOII_BACKEND_URL", f"http://127.0.0.1:{os.environ.get('PORT', '18765')}")
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


_ENGINE_OWNER = re.compile(r"^engine-(\d+)-[0-9a-f-]{36}$")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


async def engine_owner_gone(base_url: str, lease_owner: str | None) -> bool:
    """True when the engine that holds this lease has certainly died.

    The heartbeat renews a lease every 30s for 120s, so a run whose engine was
    killed keeps claiming to be active for up to two minutes. Detect it sooner:
    the engine at ``base_url`` answers with a different owner id, and the old
    owner's process no longer exists. Anything less certain (engine unreachable,
    unknown owner format) waits for the lease to expire as before.
    """
    match = _ENGINE_OWNER.match(lease_owner or "")
    if match is None:
        return False
    health = await engine_health(base_url)
    if health is None:
        return False
    current = health.get("owner_id")
    if not isinstance(current, str) or current == lease_owner:
        return False
    return not _pid_alive(int(match.group(1)))


def _engine_error_body(res: httpx.Response) -> dict[str, Any]:
    try:
        payload = res.json()
    except ValueError:
        return {}
    error = payload.get("error") if isinstance(payload, dict) else None
    return error if isinstance(error, dict) else {}


def _raise_engine_response_error(action: str, res: httpx.Response) -> None:
    error = _engine_error_body(res)
    if res.status_code == 409:
        raise EngineConflictError(
            str(error.get("message") or f"engine {action} conflict"),
            code=str(error.get("code") or "RUN_ALREADY_ACTIVE"),
        )
    if res.status_code == 404 and error.get("code") == "RUN_NOT_FOUND":
        raise EngineRunNotFoundError(str(error.get("message") or f"engine {action}: run not found"))
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
    force_regenerate: bool = False,
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
        "force_regenerate": force_regenerate,
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



async def engine_chat(
    base_url: str, project_id: int, action: str = "", body: dict[str, Any] | None = None
) -> tuple[int, dict[str, Any]]:
    """Forward one chat request to the engine; returns (status, JSON body).

    ``action`` is "" (GET history / POST message), "abort" or "confirm".
    """
    url = f"{base_url}/chat/{project_id}" + (f"/{action}" if action else "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await (client.get(url) if body is None and not action else client.post(url, json=body or {}))
    except httpx.HTTPError as exc:
        raise EngineUnavailableError(f"engine chat failed: {exc}") from exc
    try:
        payload = res.json()
    except ValueError:
        payload = {}
    return res.status_code, payload if isinstance(payload, dict) else {}
