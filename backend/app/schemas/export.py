"""导出相关 Schema"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.db.utils import UtcDatetime, utcnow


class ExportRequest(BaseModel):
    """导出请求"""

    format: Literal["pdf", "webtoon"]
    include_dialogue: bool = True
    include_character_info: bool = True


class ExportResponse(BaseModel):
    """导出响应"""

    export_id: str
    project_id: int
    format: str
    status: Literal["processing", "completed", "failed"]
    download_url: str | None = None
    created_at: UtcDatetime = Field(default_factory=utcnow)


class ExportCompletedEventData(BaseModel):
    """WebSocket export_completed 事件数据"""

    export_id: str
    format: str
    download_url: str | None = None
    status: Literal["completed", "failed"]
    error: str | None = None
