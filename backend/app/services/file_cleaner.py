"""文件清理服务

静态路径解析，以及已登记 managed-v1 媒体的保守回收（mark-and-sweep）。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 静态文件目录
STATIC_DIR = Path(__file__).parent.parent / "static"


def _extract_static_path(url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("/static/"):
        return url
    return None


def is_local_file(url: str | None) -> bool:
    """判断 URL 是否指向本地文件"""
    return _extract_static_path(url) is not None


def get_local_path(url: str) -> Path | None:
    """将本地 URL 转换为文件系统路径

    安全检查：验证最终路径在 STATIC_DIR 内，防止路径遍历攻击
    """
    static_path = _extract_static_path(url)
    if not static_path:
        return None
    # /static/videos/xxx.mp4 -> backend/app/static/videos/xxx.mp4
    relative_path = static_path.removeprefix("/static/")
    resolved_path = (STATIC_DIR / relative_path).resolve()

    # 安全检查：确保路径在 STATIC_DIR 内
    try:
        resolved_path.relative_to(STATIC_DIR.resolve())
    except ValueError:
        logger.warning(f"Path traversal attempt detected: {url}")
        return None

    return resolved_path


# Registered media younger than this is never collected: the engine registers a
# file before the transaction that stores its URL commits.
MEDIA_GC_GRACE_HOURS = 24
_MANAGED_REF = re.compile(r"managed-v1/[0-9A-Za-z._-]+")


async def sweep_managed_media(session: AsyncSession) -> int:
    """Delete registered managed-v1 files that nothing in the database mentions.

    Conservative by construction: any text in any column of any table that
    contains ``managed-v1/<name>`` counts as a reference (entities, versions, run
    context, stage attempts, checkpoints, events alike). Only rows registered in
    ``media_object`` are candidates, so legacy unregistered files are never
    touched. Skipped entirely while any run is active or holds a live lease.
    """
    busy = await session.execute(
        text(
            "SELECT 1 FROM agentrun WHERE status IN "
            "('queued','running','waiting_for_approval','cancelling') "
            "OR lease_expires_at > datetime('now') LIMIT 1"
        )
    )
    if busy.first():
        logger.info("media sweep skipped: a run is active")
        return 0

    referenced: set[str] = set()
    tables = await session.execute(
        text(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' AND name != 'media_object'"
        )
    )
    for (table,) in tables.all():
        columns = await session.execute(text(f'PRAGMA table_info("{table}")'))
        for column in [row[1] for row in columns.all()]:
            values = await session.execute(
                text(f'SELECT CAST("{column}" AS TEXT) FROM "{table}" WHERE CAST("{column}" AS TEXT) LIKE :p'),
                {"p": "%managed-v1/%"},
            )
            for (value,) in values.all():
                referenced.update(_MANAGED_REF.findall(value))

    candidates = await session.execute(
        text(
            "SELECT id, relative_path FROM media_object WHERE namespace = 'managed-v1' "
            "AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', :age)"
        ),
        {"age": f"-{MEDIA_GC_GRACE_HOURS} hours"},
    )
    removed = 0
    for object_id, relative_path in candidates.all():
        if relative_path in referenced:
            continue
        path = get_local_path(f"/static/{relative_path}")
        if path is None or not path.is_file():
            continue
        path.unlink()
        await session.execute(text("DELETE FROM media_object WHERE id = :id"), {"id": object_id})
        removed += 1
    await session.commit()
    if removed:
        logger.info("media sweep removed %s unreferenced file(s)", removed)
    return removed
