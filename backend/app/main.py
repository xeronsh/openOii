from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.api.v1.router import api_router
from app.config import get_settings
from app.db.session import init_db
from app.exceptions import AppException
from app.http_cache import JsonGZipMiddleware, MediaStaticFiles
from app.ws.manager import ws_manager

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
LOCAL_DEV_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"


def _local_dev_origin_regex(environment: str | None) -> str | None:
    if (environment or "").lower() in {"dev", "development", "local", "test"}:
        return LOCAL_DEV_ORIGIN_REGEX
    return None


@asynccontextmanager
async def lifespan(_: FastAPI):
    log = logging.getLogger("openOii.lifespan")
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "videos").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "images").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "exports").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "fonts").mkdir(parents=True, exist_ok=True)
    log.info("lifespan: calling init_db")
    await init_db()
    log.info("lifespan: init_db done")
    try:
        from app.db.session import async_session_maker
        from app.services.file_cleaner import sweep_managed_media

        async with async_session_maker() as session:
            await sweep_managed_media(session)
    except Exception:
        log.exception("lifespan: media sweep failed; continuing")
    from app.db.session import engine as db_engine
    from app.services.db_change_notifier import db_change_notifier, sqlite_db_path

    # Watch the file the backend actually reads (settings may be overridden from the DB).
    db_path = sqlite_db_path(db_engine.url)
    if db_path is not None:
        db_change_notifier.start(db_path)
    try:
        yield
    finally:
        from app.services.engine_client import shutdown_engine

        await db_change_notifier.stop()
        await shutdown_engine()


_HTTP_STATUS_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    408: "REQUEST_TIMEOUT",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "UNPROCESSABLE_ENTITY",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}
_RETRYABLE_HTTP_STATUSES = {408, 429, 500, 502, 503, 504}

_TAIL_ACTIVE_POLL_S = 0.25
_TAIL_IDLE_POLL_S = 1.0
_TAIL_IDLE_AFTER_POLLS = 8


# With the db change notifier running, tailers query only after the SQLite file
# changes; this slow poll is the safety net if a notification is ever missed.
_TAIL_PUSH_FALLBACK_S = 5.0
# Floor between push-driven queries: a write burst (stream frame + heartbeat +
# compaction) costs at most 5 queries/s per connection, close to the old 4/s poll.
_TAIL_PUSH_MIN_GAP_S = 0.2


def _tail_poll_interval(idle_polls: int) -> float:
    """WS event-tail cadence: fast while rows arrive, 1s once ~2s have been empty."""
    return _TAIL_IDLE_POLL_S if idle_polls >= _TAIL_IDLE_AFTER_POLLS else _TAIL_ACTIVE_POLL_S


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=_local_dev_origin_regex(settings.environment),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(JsonGZipMiddleware)
    app.include_router(api_router, prefix=settings.api_v1_prefix)
    app.mount("/static", MediaStaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        detail = exc.detail
        fallback_code = _HTTP_STATUS_CODES.get(exc.status_code, f"HTTP_{exc.status_code}")
        if isinstance(detail, dict):
            code = str(detail.get("code") or fallback_code)
            message = str(detail.get("message") or detail.get("detail") or fallback_code)
            retryable_value = detail.get("retryable")
            retryable = (
                retryable_value
                if isinstance(retryable_value, bool)
                else exc.status_code in _RETRYABLE_HTTP_STATUSES
            )
            details = detail.get("details") or {
                k: v
                for k, v in detail.items()
                if k not in ("code", "message", "retryable", "details")
            }
        else:
            code = fallback_code
            message = str(detail)
            retryable = exc.status_code in _RETRYABLE_HTTP_STATUSES
            details = {}
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": retryable,
                    "details": details,
                }
            },
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        del request
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "请求参数校验失败",
                    "retryable": False,
                    "details": {"errors": jsonable_encoder(exc.errors())},
                }
            },
        )

    @app.exception_handler(AppException)
    async def app_exception_handler(request: Request, exc: AppException):
        logger.error(
            "AppException: %s - %s",
            exc.code,
            exc.message,
            extra={
                "code": exc.code,
                "status_code": exc.status_code,
                "details": exc.details,
                "path": request.url.path,
                "method": request.method,
            },
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "retryable": exc.status_code in _RETRYABLE_HTTP_STATUSES,
                    "details": exc.details,
                }
            },
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        logger.exception(
            "Unhandled exception: %s",
            str(exc),
            extra={"path": request.url.path, "method": request.method},
        )
        details = {"error": str(exc)} if settings.environment == "development" else {}
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "服务器内部错误，请稍后重试",
                    "retryable": True,
                    "details": details,
                }
            },
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    _ENGINE_INTERNAL_EVENTS = {
        "engine_run_started",
        "engine_run_completed",
        "engine_run_failed",
        "engine_run_cancelled",
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
    }

    async def _send_connection_event(
        project_id: int, websocket: WebSocket, event: dict[str, object]
    ) -> None:
        """Send to one socket; keep old/lightweight managers usable in tests.

        Production ``ConnectionManager`` always provides ``send_event_to`` so a
        per-connection replay can never become an N×N project broadcast. The
        fallback is intentionally only a compatibility/degraded path.
        """
        send_to = getattr(ws_manager, "send_event_to", None)
        if send_to is not None:
            await send_to(websocket, event)
            return
        await ws_manager.send_event(project_id, event)

    async def _send_durable_connection_event(
        project_id: int,
        websocket: WebSocket,
        *,
        event_id: int,
        event_type: str,
        data: dict[str, object],
    ) -> None:
        send_durable = getattr(ws_manager, "send_durable_event_to", None)
        if send_durable is not None:
            await send_durable(
                websocket,
                event_id=event_id,
                event_type=event_type,
                data=data,
            )
            return
        await _send_connection_event(
            project_id,
            websocket,
            {"type": event_type, "data": data, "event_id": event_id},
        )

    async def _engine_event_watermark(project_id: int) -> int:
        from app.db.session import async_session_maker
        from sqlalchemy import text

        try:
            async with async_session_maker() as session:
                result = await session.execute(
                    text(
                        "SELECT COALESCE(MAX(seq), 0) FROM engine_run_events "
                        "WHERE project_id = :project_id"
                    ),
                    {"project_id": project_id},
                )
                return int(result.scalar() or 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "event watermark unavailable for project %s; starting at 0: %s",
                project_id,
                exc,
            )
            return 0

    async def _tail_engine_events(
        project_id: int,
        websocket: WebSocket,
        *,
        after_seq: int,
    ) -> None:
        """Replay/tail durable events to exactly one connection."""
        from app.db.session import async_session_maker
        from app.services.db_change_notifier import db_change_notifier
        from sqlalchemy import text

        last_seq = after_seq
        idle_polls = 0
        try:
            loop = asyncio.get_running_loop()
            while True:
                seen_generation = db_change_notifier.generation
                queried_at = loop.time()
                async with async_session_maker() as session:
                    result = await session.execute(
                        text(
                            "SELECT seq, type, payload FROM engine_run_events "
                            "WHERE project_id = :project_id AND seq > :after_seq "
                            "ORDER BY seq LIMIT 500"
                        ),
                        {"project_id": project_id, "after_seq": last_seq},
                    )
                    rows = list(result.all())

                for seq_raw, type_raw, payload_raw in rows:
                    seq = int(seq_raw)
                    if seq <= last_seq:
                        continue
                    last_seq = seq
                    etype = str(type_raw or "")
                    if etype in _ENGINE_INTERNAL_EVENTS:
                        continue
                    try:
                        data = json.loads(str(payload_raw or "{}"))
                    except json.JSONDecodeError:
                        logger.error(
                            "invalid engine event payload project=%s seq=%s type=%s",
                            project_id,
                            seq,
                            etype,
                        )
                        continue
                    await _send_durable_connection_event(
                        project_id,
                        websocket,
                        event_id=seq,
                        event_type=etype,
                        data=data if isinstance(data, dict) else {},
                    )
                # Short enough that live llm_stream previews (200ms frames) read as streaming
                # while events flow; an idle tab (no run, or parked at a gate) backs off to 1s
                # after ~2s of empty polls instead of querying 4x/s forever.
                idle_polls = 0 if rows else idle_polls + 1
                if db_change_notifier.active:
                    # Push: sleep until the engine (or anyone) writes the DB; a write that
                    # landed while we were querying, or a full batch, re-queries at once.
                    if len(rows) >= 500:
                        continue
                    if db_change_notifier.generation == seen_generation:
                        await db_change_notifier.wait_for_change(
                            seen_generation, _TAIL_PUSH_FALLBACK_S
                        )
                    await asyncio.sleep(max(0.0, queried_at + _TAIL_PUSH_MIN_GAP_S - loop.time()))
                    continue
                await asyncio.sleep(_tail_poll_interval(idle_polls))
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            logger.exception("engine event tailer failed for project %s", project_id)

    @app.websocket("/ws/projects/{project_id}")
    async def ws_projects(websocket: WebSocket, project_id: int):
        from app.services.run_signals import get_awaiting_payload, trigger_confirm_signal

        engine_tailer_task: asyncio.Task[None] | None = None
        try:
            await ws_manager.connect(project_id, websocket)
            head_cursor = await _engine_event_watermark(project_id)
            query_params = getattr(websocket, "query_params", None)
            raw_after = query_params.get("after") if query_params is not None else None
            requested_after: int | None = None
            if raw_after is not None:
                try:
                    requested_after = max(0, int(raw_after))
                except ValueError:
                    requested_after = None
            event_cursor = (
                min(requested_after, head_cursor)
                if requested_after is not None
                else head_cursor
            )
            await _send_connection_event(
                project_id,
                websocket,
                {"type": "connected", "data": {"project_id": project_id}},
            )

            if requested_after is None:
                try:
                    from app.db.session import async_session_maker
                    from app.models.agent_run import AgentRun
                    from app.services.run_signals import GRAPH_STAGE_FOR_AGENT
                    from sqlalchemy import select, text

                    async with async_session_maker() as session:
                        stmt = (
                            select(AgentRun)
                            .where(AgentRun.project_id == project_id)  # type: ignore[arg-type]
                            .where(
                                AgentRun.status.in_(  # type: ignore[union-attr]
                                    ("queued", "running", "waiting_for_approval", "cancelling")
                                )
                            )
                            .order_by(AgentRun.created_at.desc())  # type: ignore[attr-defined]
                        )
                        res = await session.execute(stmt)
                        for run in res.scalars().all():
                            assert run.id is not None
                            payload = await get_awaiting_payload(run.id)
                            if payload:
                                await _send_connection_event(
                                    project_id,
                                    websocket,
                                    {"type": "run_awaiting_confirm", "data": payload},
                                )
                                continue
                            # current_agent alone is ambiguous ("render" covers both
                            # character and shot images); the engine's last stage event
                            # is exact.
                            mapped_stage = GRAPH_STAGE_FOR_AGENT.get(
                                run.current_agent or "", run.current_agent or "plan_outline"
                            )
                            try:
                                last = await session.execute(
                                    text(
                                        "SELECT json_extract(payload, '$.current_stage') "
                                        "FROM engine_run_events WHERE run_id = :run_id "
                                        "AND json_extract(payload, '$.current_stage') IS NOT NULL "
                                        "ORDER BY seq DESC LIMIT 1"
                                    ),
                                    {"run_id": run.id},
                                )
                                mapped_stage = last.scalar() or mapped_stage
                            except Exception:  # noqa: BLE001 - no engine events table yet
                                pass
                            await _send_connection_event(
                                project_id,
                                websocket,
                                {
                                    "type": "run_progress",
                                    "data": {
                                        "run_id": run.id,
                                        "project_id": project_id,
                                        "current_agent": run.current_agent,
                                        "current_stage": mapped_stage,
                                        "stage": mapped_stage,
                                        "progress": run.progress,
                                    },
                                },
                            )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Failed to hydrate project %s: %s", project_id, exc)

            engine_tailer_task = asyncio.create_task(
                _tail_engine_events(project_id, websocket, after_seq=event_cursor)
            )

            while True:
                if websocket.client_state != WebSocketState.CONNECTED:
                    break
                try:
                    msg = await websocket.receive_json()
                    msg_type = msg.get("type")
                    if msg_type == "ping":
                        await _send_connection_event(
                            project_id, websocket, {"type": "pong", "data": {}}
                        )
                    elif msg_type == "echo":
                        await _send_connection_event(
                            project_id,
                            websocket,
                            {"type": "echo", "data": msg.get("data")},
                        )
                    elif msg_type == "confirm":
                        data = msg.get("data") or {}
                        run_id = data.get("run_id")
                        feedback = data.get("feedback")
                        if run_id:
                            if isinstance(feedback, str) and feedback.strip():
                                # 闸门处带文字 = 要求修改，不是批准：engine 按意见重做并回到同一闸门
                                from app.services import run_signals

                                try:
                                    await run_signals.submit_gate_feedback(
                                        run_id, project_id=project_id, content=feedback
                                    )
                                except run_signals.GateFeedbackRejected as exc:
                                    await _send_connection_event(
                                        project_id,
                                        websocket,
                                        {
                                            "type": "error",
                                            "data": {"code": exc.code, "message": str(exc)},
                                        },
                                    )
                                except Exception as exc:  # noqa: BLE001
                                    logger.error(
                                        "Failed to save gate feedback for run %s: %s", run_id, exc
                                    )
                            else:
                                run_belongs_to_project = False
                                try:
                                    from app.db.session import async_session_maker
                                    from app.models.agent_run import AgentRun

                                    async with async_session_maker() as session:
                                        agent_run = await session.get(AgentRun, run_id)
                                        run_belongs_to_project = (
                                            agent_run is not None
                                            and agent_run.project_id == project_id
                                        )
                                except Exception as exc:  # noqa: BLE001
                                    logger.error("Failed to load run %s: %s", run_id, exc)
                                if run_belongs_to_project:
                                    await trigger_confirm_signal(run_id, project_id=project_id)
                except WebSocketDisconnect:
                    break
                except RuntimeError as exc:
                    if "not connected" in str(exc).lower():
                        break
                    logger.error("WebSocket runtime error: %s", exc, exc_info=True)
                    break
                except Exception as exc:  # noqa: BLE001
                    logger.error("WebSocket message error: %s", exc, exc_info=True)
                    try:
                        await _send_connection_event(
                            project_id,
                            websocket,
                            {
                                "type": "error",
                                "data": {
                                    "code": "WS_MESSAGE_ERROR",
                                    "message": "消息处理失败",
                                },
                            },
                        )
                    except Exception:  # noqa: BLE001
                        break
        except Exception as exc:  # noqa: BLE001
            logger.error("WebSocket connection error: %s", exc, exc_info=True)
            try:
                await _send_connection_event(
                    project_id,
                    websocket,
                    {
                        "type": "error",
                        "data": {
                            "code": "WS_CONNECTION_ERROR",
                            "message": "连接失败",
                        },
                    },
                )
            except Exception:  # noqa: BLE001
                pass
        finally:
            if engine_tailer_task is not None:
                engine_tailer_task.cancel()
                try:
                    await engine_tailer_task
                except asyncio.CancelledError:
                    pass
            await ws_manager.disconnect(project_id, websocket)

    return app


app = create_app()
