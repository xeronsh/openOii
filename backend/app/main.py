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
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.api.v1.router import api_router
from app.config import get_settings
from app.db.session import init_db
from app.exceptions import AppException
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
        yield
    finally:
        from app.services.engine_client import shutdown_engine

        await shutdown_engine()


_HTTP_STATUS_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
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
    app.include_router(api_router, prefix=settings.api_v1_prefix)
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        detail = exc.detail
        fallback_code = _HTTP_STATUS_CODES.get(exc.status_code, f"HTTP_{exc.status_code}")
        if isinstance(detail, dict):
            code = str(detail.get("code") or fallback_code)
            message = str(detail.get("message") or detail.get("detail") or fallback_code)
            details = detail.get("details") or {
                k: v for k, v in detail.items() if k not in ("code", "message", "details")
            }
        else:
            code = fallback_code
            message = str(detail)
            details = {}
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": message, "details": details}},
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

    async def _engine_event_watermark(project_id: int) -> int:
        from app.db.session import async_session_maker
        from sqlalchemy import text

        async with async_session_maker() as session:
            result = await session.execute(
                text(
                    "SELECT COALESCE(MAX(seq), 0) FROM engine_run_events "
                    "WHERE project_id = :project_id"
                ),
                {"project_id": project_id},
            )
            return int(result.scalar() or 0)

    async def _tail_engine_events(
        project_id: int,
        websocket: WebSocket,
        *,
        after_seq: int,
    ) -> None:
        """Replay/tail durable events to exactly one connection."""
        from app.db.session import async_session_maker
        from sqlalchemy import text

        last_seq = after_seq
        try:
            while True:
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
                    await ws_manager.send_durable_event_to(
                        websocket,
                        event_id=seq,
                        event_type=etype,
                        data=data if isinstance(data, dict) else {},
                    )
                await asyncio.sleep(0.4)
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
            raw_after = websocket.query_params.get("after")
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
            await ws_manager.send_event_to(
                websocket,
                {
                    "type": "connected",
                    "data": {
                        "project_id": project_id,
                        "event_cursor": event_cursor,
                        "head_event_cursor": head_cursor,
                    },
                },
            )

            # First connection hydrates current state. Reconnects with a cursor
            # replay the exact durable delta instead of mixing a current
            # projection with older events that could temporarily roll UI state
            # backwards.
            if requested_after is None:
                try:
                    from app.db.session import async_session_maker
                    from app.models.agent_run import AgentRun
                    from app.services.run_signals import GRAPH_STAGE_FOR_AGENT
                    from sqlalchemy import select

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
                                await ws_manager.send_event_to(
                                    websocket,
                                    {"type": "run_awaiting_confirm", "data": payload},
                                )
                                continue
                            mapped_stage = GRAPH_STAGE_FOR_AGENT.get(
                                run.current_agent or "", run.current_agent or "plan_outline"
                            )
                            await ws_manager.send_event_to(
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
                        await ws_manager.send_event_to(websocket, {"type": "pong", "data": {}})
                    elif msg_type == "echo":
                        await ws_manager.send_event_to(
                            websocket, {"type": "echo", "data": msg.get("data")}
                        )
                    elif msg_type == "confirm":
                        run_id = msg.get("data", {}).get("run_id")
                        feedback = msg.get("data", {}).get("feedback")
                        if run_id:
                            if isinstance(feedback, str) and feedback.strip():
                                try:
                                    from app.db.session import async_session_maker
                                    from app.models.agent_run import AgentMessage, AgentRun
                                    from app.models.message import Message

                                    content = feedback.strip()
                                    async with async_session_maker() as session:
                                        agent_run = await session.get(AgentRun, run_id)
                                        if agent_run and agent_run.project_id == project_id:
                                            session.add(
                                                AgentMessage(
                                                    run_id=run_id,
                                                    agent="user",
                                                    role="user",
                                                    content=content,
                                                )
                                            )
                                            session.add(
                                                Message(
                                                    project_id=project_id,
                                                    run_id=run_id,
                                                    agent="user",
                                                    role="user",
                                                    content=content,
                                                )
                                            )
                                            await session.commit()
                                except Exception as exc:  # noqa: BLE001
                                    logger.error(
                                        "Failed to save feedback for run %s: %s", run_id, exc
                                    )
                            await trigger_confirm_signal(run_id)
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
                        await ws_manager.send_event_to(
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
                await ws_manager.send_event_to(
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
