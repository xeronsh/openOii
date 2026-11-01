"""Engine sidecar client against a local fake engine (never spawns the real one)."""

from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.generated.workflow_contract import WORKFLOW_VERSION
from app.services import engine_client as ec


class FakeEngine:
    """Routes map "METHOD /path" to (status, body); requests are recorded."""

    def __init__(self):
        self.routes: dict[str, tuple[int, object]] = {}
        self.requests: list[tuple[str, str, object]] = []
        engine = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self, method):
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                engine.requests.append((method, self.path, json.loads(raw) if raw else None))
                status, body = engine.routes.get(f"{method} {self.path}", (404, {"error": "nope"}))
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._serve("GET")

            def do_POST(self):
                self._serve("POST")

            def log_message(self, *_args):
                return None

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def engine():
    fake = FakeEngine()
    yield fake
    fake.close()


DEAD = "http://127.0.0.1:9"


def _dead_pid() -> int:
    proc = subprocess.Popen(["true"])
    proc.wait()
    return proc.pid


def test_engine_db_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert ec.engine_db_path("postgresql://u@h/db") is None
    assert ec.engine_db_path("sqlite+aiosqlite:///:memory:") is None
    assert ec.engine_db_path(f"sqlite+aiosqlite:///{tmp_path}/a.db") == str(tmp_path / "a.db")
    assert ec.engine_db_path("sqlite+aiosqlite:///rel/b.db") == str((tmp_path / "rel/b.db").resolve())


@pytest.mark.asyncio
async def test_health_degrades_to_none(engine):
    engine.routes["GET /health"] = (200, {"workflow_version": WORKFLOW_VERSION})
    assert await ec.engine_health(engine.url) == {"workflow_version": WORKFLOW_VERSION}
    engine.routes["GET /health"] = (200, ["not", "a", "dict"])
    assert await ec.engine_health(engine.url) is None
    engine.routes["GET /health"] = (503, {})
    assert await ec.engine_health(engine.url) is None
    assert await ec.engine_health(DEAD) is None


@pytest.mark.asyncio
async def test_ensure_running_accepts_a_compatible_engine_and_rejects_a_stale_one(engine, tmp_path):
    engine.routes["GET /health"] = (200, {"workflow_version": WORKFLOW_VERSION})
    await ec.ensure_engine_running(engine.url, "sqlite+aiosqlite:///x.db", tmp_path)

    engine.routes["GET /health"] = (200, {"workflow_version": "old"})
    with pytest.raises(ec.EngineUnavailableError, match="version mismatch"):
        await ec.ensure_engine_running(engine.url, "sqlite+aiosqlite:///x.db", tmp_path)


@pytest.mark.asyncio
async def test_ensure_running_explains_why_it_cannot_start_one(tmp_path, monkeypatch):
    monkeypatch.setattr(ec, "_ENGINE_PROCESS", None)
    with pytest.raises(ec.EngineUnavailableError, match="requires DATABASE_URL=sqlite"):
        await ec.ensure_engine_running(DEAD, "postgresql://u@h/db", tmp_path)

    monkeypatch.setattr(ec.shutil, "which", lambda _name: None)
    with pytest.raises(ec.EngineUnavailableError, match="pnpm install"):
        await ec.ensure_engine_running(DEAD, f"sqlite+aiosqlite:///{tmp_path}/e.db", tmp_path)
    assert ec._ENGINE_PROCESS is None


@pytest.mark.asyncio
async def test_active_run_ids(engine):
    engine.routes["GET /runs"] = (200, {"runs": [3, 4.0, "x", None]})
    assert await ec.engine_active_run_ids(engine.url) == {3, 4}
    engine.routes["GET /runs"] = (200, {"runs": "nope"})
    assert await ec.engine_active_run_ids(engine.url) == set()
    engine.routes["GET /runs"] = (500, {})
    assert await ec.engine_active_run_ids(engine.url) == set()
    assert await ec.engine_active_run_ids(DEAD) == set()


@pytest.mark.asyncio
async def test_owner_gone_only_when_certain(engine):
    import os

    dead = f"engine-{_dead_pid()}-{'0' * 8}-0000-0000-0000-{'0' * 12}"
    alive = f"engine-{os.getpid()}-{'1' * 8}-1111-1111-1111-{'1' * 12}"
    engine.routes["GET /health"] = (200, {"owner_id": "engine-1-new"})

    assert await ec.engine_owner_gone(engine.url, dead) is True
    assert await ec.engine_owner_gone(engine.url, alive) is False
    assert await ec.engine_owner_gone(engine.url, "worker-7") is False
    assert await ec.engine_owner_gone(engine.url, None) is False
    assert await ec.engine_owner_gone(DEAD, dead) is False
    engine.routes["GET /health"] = (200, {"owner_id": dead})
    assert await ec.engine_owner_gone(engine.url, dead) is False


@pytest.mark.asyncio
async def test_start_run_sends_scope_only_when_targeted(engine):
    engine.routes["POST /runs"] = (202, {"accepted": True})

    assert await ec.engine_start_run(engine.url, project_id=1, run_id=2) == {"accepted": True}
    await ec.engine_start_run(
        engine.url, project_id=1, run_id=3, stage="render", target_shot_ids=[5], target_character_ids=(6,)
    )

    first, second = (body for _, _, body in engine.requests)
    assert "target_shot_ids" not in first and first["stage"] == "full"
    assert second["target_shot_ids"] == [5] and second["target_character_ids"] == [6]


@pytest.mark.asyncio
async def test_engine_errors_map_to_conflict_or_unavailable(engine):
    engine.routes["POST /runs"] = (409, {"error": {"code": "RUN_BUSY", "message": "already running"}})
    with pytest.raises(ec.EngineConflictError) as conflict:
        await ec.engine_start_run(engine.url, project_id=1, run_id=2)
    assert (conflict.value.code, str(conflict.value)) == ("RUN_BUSY", "already running")

    engine.routes["POST /runs/2/resume"] = (409, "not json")
    with pytest.raises(ec.EngineConflictError) as plain:
        await ec.engine_resume_run(engine.url, project_id=1, run_id=2)
    assert (plain.value.code, str(plain.value)) == ("RUN_ALREADY_ACTIVE", "engine resume conflict")

    engine.routes["POST /runs/2/cancel"] = (500, "boom")
    with pytest.raises(ec.EngineUnavailableError, match="engine cancel failed: 500 boom"):
        await ec.engine_cancel_run(engine.url, 2)

    for call in (
        ec.engine_start_run(DEAD, project_id=1, run_id=2),
        ec.engine_resume_run(DEAD, project_id=1, run_id=2),
        ec.engine_cancel_run(DEAD, 2),
    ):
        with pytest.raises(ec.EngineUnavailableError):
            await call


@pytest.mark.asyncio
async def test_resume_and_cancel_accepted(engine):
    engine.routes["POST /runs/9/resume"] = (202, {"resumed": 9})
    engine.routes["POST /runs/9/cancel"] = (202, {})

    assert await ec.engine_resume_run(engine.url, project_id=4, run_id=9) == {"resumed": 9}
    await ec.engine_cancel_run(engine.url, 9)
    assert engine.requests[0][2] == {"project_id": 4}


class _Proc:
    pid = 4242

    def __init__(self, waits_out: int):
        self.waits_out = waits_out
        self.calls = []

    def poll(self):
        return None

    def terminate(self):
        self.calls.append("terminate")

    def kill(self):
        self.calls.append("kill")

    def wait(self, timeout):
        self.calls.append("wait")
        if self.waits_out > 0:
            self.waits_out -= 1
            raise subprocess.TimeoutExpired("engine", timeout)
        return 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("waits_out", "expected"),
    [(0, ["terminate", "wait"]), (1, ["terminate", "wait", "kill", "wait"]), (2, ["terminate", "wait", "kill", "wait"])],
)
async def test_shutdown_stops_only_the_owned_engine(monkeypatch, tmp_path, waits_out, expected):
    proc = _Proc(waits_out)
    log = (tmp_path / "engine.log").open("ab")
    monkeypatch.setattr(ec, "_ENGINE_PROCESS", proc)
    monkeypatch.setattr(ec, "_ENGINE_LOG_HANDLE", log)
    monkeypatch.setattr(ec, "ENGINE_STOP_TIMEOUT_S", 0.01)

    await ec.shutdown_engine()

    assert proc.calls == expected
    assert ec._ENGINE_PROCESS is None and ec._ENGINE_LOG_HANDLE is None
    assert log.closed
    await ec.shutdown_engine()  # nothing owned: a no-op


@pytest.mark.asyncio
async def test_engine_run_not_found_is_a_404_not_an_outage(engine):
    """引擎对 POST /runs 与 resume 的缺失 run 统一回 404 RUN_NOT_FOUND：不能当成引擎不可用重试。"""
    body = {"error": {"code": "RUN_NOT_FOUND", "message": "运行 2 不存在或不属于项目 1"}}
    engine.routes["POST /runs"] = (404, body)
    engine.routes["POST /runs/2/resume"] = (404, body)
    for call in (
        ec.engine_start_run(engine.url, project_id=1, run_id=2),
        ec.engine_resume_run(engine.url, project_id=1, run_id=2),
    ):
        with pytest.raises(ec.EngineRunNotFoundError) as missing:
            await call
        assert (missing.value.code, str(missing.value)) == ("RUN_NOT_FOUND", "运行 2 不存在或不属于项目 1")
    # 未知路由的 404（例如旧引擎）仍然是引擎不可用
    engine.routes["POST /runs"] = (404, {"error": "not found"})
    with pytest.raises(ec.EngineUnavailableError) as other:
        await ec.engine_start_run(engine.url, project_id=1, run_id=2)
    assert not isinstance(other.value, ec.EngineRunNotFoundError)
