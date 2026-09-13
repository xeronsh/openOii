"""导出 API 路由"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404
from app.config import Settings
from app.models.project import Character, Project, Shot
from app.schemas.export import ExportResponse
from app.services.export_service import ExportService
from app.ws.manager import ConnectionManager

logger = logging.getLogger(__name__)

router = APIRouter()

# 内存导出状态缓存（DB 不可用时的降级方案）
_export_status_cache: dict[str, ExportResponse] = {}

# 全局 ExportService 实例
_export_service = ExportService()

_EXPORT_TTL_S = 3600


async def _store_export_status(export_resp: ExportResponse) -> None:
    """存储导出状态到 exportcache 表（TTL 1 小时，降级到内存缓存）"""
    from app.db.session import async_session_maker
    from app.db.utils import utcnow
    from app.models.export_cache import ExportCache

    try:
        async with async_session_maker() as session:
            session.add(
                ExportCache(
                    export_id=export_resp.export_id,
                    payload=export_resp.model_dump_json(),
                    expires_at=utcnow() + timedelta(seconds=_EXPORT_TTL_S),
                )
            )
            await session.commit()
    except Exception:
        logger.exception("export cache write failed, falling back to memory")
        _export_status_cache[export_resp.export_id] = export_resp


async def _get_export_status(export_id: str) -> ExportResponse | None:
    """从 exportcache 表获取导出状态（惰性清理过期行，降级到内存缓存）"""
    from sqlalchemy import delete as _delete

    from app.db.session import async_session_maker
    from app.db.utils import utcnow
    from app.models.export_cache import ExportCache

    try:
        async with async_session_maker() as session:
            row = await session.get(ExportCache, export_id)
            if row is not None:
                if row.expires_at <= utcnow():
                    await session.execute(
                        _delete(ExportCache).where(ExportCache.export_id == export_id)
                    )
                    await session.commit()
                else:
                    return ExportResponse.model_validate_json(row.payload)
    except Exception:
        logger.exception("export cache read failed, falling back to memory")
    return _export_status_cache.get(export_id)


async def _append_project_export(
    session: AsyncSession,
    project_id: int,
    download_url: str,
) -> None:
    stmt = select(Project).where(Project.id == project_id).with_for_update()
    res = await session.execute(stmt)
    project = res.scalar_one_or_none()
    if project is None:
        return

    exports = list(project.exports or [])
    if download_url not in exports:
        exports.append(download_url)
        project.exports = exports
        session.add(project)
    await session.commit()


async def _run_export_task(
    project_id: int,
    export_id: str,
    format: str,
    include_dialogue: bool,
    include_character_info: bool,
    ws: ConnectionManager,
) -> None:
    """后台导出任务"""
    from app.db.session import async_session_maker

    try:
        async with async_session_maker() as session:
            project = await session.get(Project, project_id)
            if not project:
                raise ValueError(f"Project {project_id} not found")

            # 加载分镜和角色
            shot_res = await session.execute(
                select(Shot).where(Shot.project_id == project_id).order_by(Shot.order)
            )
            shots = list(shot_res.scalars().all())

            char_res = await session.execute(
                select(Character).where(Character.project_id == project_id)
            )
            characters = list(char_res.scalars().all())

        # 执行导出
        if format == "pdf":
            download_url = await _export_service.export_pdf(
                project=project,
                shots=shots,
                characters=characters,
                include_dialogue=include_dialogue,
                include_character_info=include_character_info,
            )
        else:
            download_url = await _export_service.export_webtoon(
                project=project,
                shots=shots,
                include_dialogue=include_dialogue,
            )

        # 更新状态
        export_resp = ExportResponse(
            export_id=export_id,
            project_id=project_id,
            format=format,
            status="completed",
            download_url=download_url,
            created_at=datetime.now(),
        )
        await _store_export_status(export_resp)

        # 更新项目 exports 列表
        async with async_session_maker() as session:
            await _append_project_export(session, project_id, download_url)

        # WebSocket 通知
        from app.schemas.export import ExportCompletedEventData

        event_data = ExportCompletedEventData(
            export_id=export_id,
            format=format,
            download_url=download_url,
            status="completed",
        )
        await ws.send_event(project_id, {
            "type": "export_completed",
            "data": event_data.model_dump(),
        })

        logger.info(f"Export {export_id} completed: {download_url}")

    except Exception as e:
        logger.exception(f"Export {export_id} failed")
        export_resp = ExportResponse(
            export_id=export_id,
            project_id=project_id,
            format=format,
            status="failed",
            created_at=datetime.now(),
        )
        await _store_export_status(export_resp)

        # WebSocket 通知失败
        from app.schemas.export import ExportCompletedEventData

        event_data = ExportCompletedEventData(
            export_id=export_id,
            format=format,
            status="failed",
            error=str(e),
        )
        await ws.send_event(project_id, {
            "type": "export_completed",
            "data": event_data.model_dump(),
        })


@router.post(
    "/{project_id}/export/pdf",
    response_model=ExportResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def export_pdf(
    project_id: int,
    background_tasks: BackgroundTasks,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """触发 PDF 导出"""
    await get_or_404(session, Project, project_id)

    export_id = uuid.uuid4().hex[:12]
    export_resp = ExportResponse(
        export_id=export_id,
        project_id=project_id,
        format="pdf",
        status="processing",
        created_at=datetime.now(),
    )
    await _store_export_status(export_resp)

    # 后台执行导出
    asyncio.create_task(
        _run_export_task(
            project_id=project_id,
            export_id=export_id,
            format="pdf",
            include_dialogue=True,
            include_character_info=True,
            ws=ws,
        )
    )

    return export_resp


@router.post(
    "/{project_id}/export/webtoon",
    response_model=ExportResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def export_webtoon(
    project_id: int,
    background_tasks: BackgroundTasks,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """触发 Webtoon 导出"""
    await get_or_404(session, Project, project_id)

    export_id = uuid.uuid4().hex[:12]
    export_resp = ExportResponse(
        export_id=export_id,
        project_id=project_id,
        format="webtoon",
        status="processing",
        created_at=datetime.now(),
    )
    await _store_export_status(export_resp)

    # 后台执行导出
    asyncio.create_task(
        _run_export_task(
            project_id=project_id,
            export_id=export_id,
            format="webtoon",
            include_dialogue=True,
            include_character_info=True,
            ws=ws,
        )
    )

    return export_resp


@router.get(
    "/{project_id}/export/{export_id}/status",
    response_model=ExportResponse,
)
async def get_export_status(
    project_id: int,
    export_id: str,
):
    """查询导出状态"""
    export_resp = await _get_export_status(export_id)
    if not export_resp:
        raise HTTPException(status_code=404, detail="Export task not found")
    if export_resp.project_id != project_id:
        raise HTTPException(status_code=404, detail="Export task not found")
    return export_resp
