from __future__ import annotations

import asyncio

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket
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

# 静态文件目录
STATIC_DIR = Path(__file__).parent / "static"
LOCAL_DEV_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"


def _local_dev_origin_regex(environment: str | None) -> str | None:
    if (environment or "").lower() in {"dev", "development", "local", "test"}:
        return LOCAL_DEV_ORIGIN_REGEX
    return None


@asynccontextmanager
async def lifespan(_: FastAPI):
    import logging

    log = logging.getLogger("openOii.lifespan")
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "videos").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "images").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "exports").mkdir(parents=True, exist_ok=True)
    (STATIC_DIR / "fonts").mkdir(parents=True, exist_ok=True)
    log.info("lifespan: calling init_db")
    await init_db()
    log.info("lifespan: init_db done")
    yield


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

    # 挂载静态文件服务（用于提供拼接后的视频）
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # 全局异常处理器
    @app.exception_handler(AppException)
    async def app_exception_handler(request: Request, exc: AppException):
        """处理自定义应用异常"""
        logger.error(
            f"AppException: {exc.code} - {exc.message}",
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
        """处理未捕获的异常"""
        logger.exception(
            f"Unhandled exception: {str(exc)}",
            extra={
                "path": request.url.path,
                "method": request.method,
            },
        )
        # 开发环境返回详细错误，生产环境只返回友好消息
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

    async def _tail_engine_events(project_id: int, websocket: WebSocket) -> None:
        """pi 引擎事件的 WS 桥：轮询 engine_run_events 增量推送给本连接。"""
        from app.db.session import async_session_maker
        from app.models.agent_run import AgentRun
        from app.services.engine_client import engine_events_since
        from sqlalchemy import select

        last_seq: dict[int, int] = {}
        draining: set[int] = set()
        try:
            while True:
                async with async_session_maker() as session:
                    res = await session.execute(
                        select(AgentRun).where(
                            AgentRun.project_id == project_id,  # type: ignore[arg-type]
                            AgentRun.status.in_(("queued", "running")),  # type: ignore[attr-defined]
                        )
                    )
                    active_ids = {int(run.id) for run in res.scalars().all() if run.id is not None}
                for run_id in (active_ids | draining) - set():
                    draining.add(run_id)
                    since = last_seq.get(run_id, 0)
                    try:
                        events = await engine_events_since(settings.engine_url, run_id, since)
                    except Exception:  # noqa: BLE001 - 引擎暂不可达时下轮重试
                        await asyncio.sleep(1.0)
                        continue
                    for event in events:
                        seq = int(event.get("seq") or 0)
                        if seq <= last_seq.get(run_id, 0):
                            continue
                        last_seq[run_id] = seq
                        etype = str(event.get("type") or "")
                        # 只拦截引擎内部协议帧；agent_thinking 等契约事件必须放行
                        if etype not in _ENGINE_INTERNAL_EVENTS:
                            await ws_manager.send_event(
                                project_id,
                                {"type": etype, "data": event.get("data") or {}},
                            )
                        if etype in ("run_completed", "run_failed", "run_cancelled"):
                            last_seq.pop(run_id, None)
                            draining.discard(run_id)
                await asyncio.sleep(0.4)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            logger.exception("engine event tailer failed for project %s", project_id)

    @app.websocket("/ws/projects/{project_id}")
    async def ws_projects(websocket: WebSocket, project_id: int):
        from app.services.run_signals import (
            get_awaiting_payload,
            trigger_confirm_signal,
        )

        try:
            await ws_manager.connect(project_id, websocket)
            await ws_manager.send_event(
                project_id, {"type": "connected", "data": {"project_id": project_id}}
            )

            # 补发当前项目下任意 running run 的状态，防止客户端错过事件
            try:
                from app.db.session import async_session_maker
                from app.models.agent_run import AgentRun
                from sqlalchemy import select

                async with async_session_maker() as session:
                    stmt = (
                        select(AgentRun)
                        .where(AgentRun.project_id == project_id)  # type: ignore[arg-type]
                        .where(AgentRun.status == "running")  # type: ignore[arg-type]
                        .order_by(AgentRun.created_at.desc())  # type: ignore[attr-defined]
                    )
                    res = await session.execute(stmt)
                    for run in res.scalars().all():
                        assert run.id is not None
                        payload = await get_awaiting_payload(run.id)
                        if payload:
                            await ws_manager.send_event(
                                project_id,
                                {"type": "run_awaiting_confirm", "data": payload},
                            )
                        else:
                            from app.services.run_signals import GRAPH_STAGE_FOR_AGENT

                            mapped_stage = GRAPH_STAGE_FOR_AGENT.get(
                                run.current_agent or "", run.current_agent or "plan"
                            )
                            await ws_manager.send_event(
                                project_id,
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
            except Exception as e:
                logger.warning(f"Failed to replay state for project {project_id}: {e}")

            # pi 引擎：尾随 engine_run_events，把引擎事件推给 WS 客户端
            engine_tailer_task = asyncio.create_task(
                _tail_engine_events(project_id, websocket)
            )

            while True:
                # Pre-check: if the socket is no longer connected, exit cleanly.
                if websocket.client_state != WebSocketState.CONNECTED:
                    logger.info(
                        f"WebSocket client_state is {websocket.client_state.name}, "
                        f"exiting loop for project {project_id}"
                    )
                    break

                try:
                    msg = await websocket.receive_json()
                    msg_type = msg.get("type")
                    if msg_type == "ping":
                        await ws_manager.send_event(project_id, {"type": "pong", "data": {}})
                    elif msg_type == "echo":
                        await ws_manager.send_event(
                            project_id, {"type": "echo", "data": msg.get("data")}
                        )
                    elif msg_type == "confirm":
                        run_id = msg.get("data", {}).get("run_id")
                        feedback = msg.get("data", {}).get("feedback")
                        if run_id:
                            if isinstance(feedback, str) and feedback.strip():
                                try:
                                    from app.db.session import async_session_maker
                                    from app.models.agent_run import AgentMessage
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
                                except Exception as e:
                                    logger.error(f"Failed to save feedback for run {run_id}: {e}")
                            await trigger_confirm_signal(run_id)
                except WebSocketDisconnect:
                    logger.info(f"WebSocket disconnected for project {project_id}")
                    if engine_tailer_task is not None:
                        engine_tailer_task.cancel()
                    break
                except RuntimeError as e:
                    # Starlette raises RuntimeError when receive_json/send_json
                    # is called on a socket whose underlying connection is gone
                    # (e.g. client closed browser).  Treat as a disconnect.
                    if "not connected" in str(e).lower():
                        logger.info(f"WebSocket not connected for project {project_id}: {e}")
                        break
                    # Unexpected RuntimeError — log and re-raise.
                    logger.error(
                        f"WebSocket runtime error for project {project_id}: {e}", exc_info=True
                    )
                    break
                except Exception as e:
                    logger.error(f"WebSocket message error: {e}", exc_info=True)
                    # Try to notify the client, but break if it fails — don't
                    # spin in an infinite loop on a dead connection.
                    try:
                        await ws_manager.send_event(
                            project_id,
                            {
                                "type": "error",
                                "data": {
                                    "code": "WS_MESSAGE_ERROR",
                                    "message": "消息处理失败",
                                },
                            },
                        )
                    except Exception:
                        logger.info(
                            f"Failed to send error event, breaking WS loop for project {project_id}"
                        )
                        break
        except Exception as e:
            logger.error(f"WebSocket connection error: {e}", exc_info=True)
            try:
                await ws_manager.send_event(
                    project_id,
                    {
                        "type": "error",
                        "data": {
                            "code": "WS_CONNECTION_ERROR",
                            "message": "连接失败",
                        },
                    },
                )
            except Exception:
                pass  # 连接已断开，忽略发送错误
        finally:
            await ws_manager.disconnect(project_id, websocket)

    return app


app = create_app()
