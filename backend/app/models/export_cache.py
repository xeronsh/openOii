from datetime import datetime

from sqlalchemy import Column, Text
from sqlmodel import Field, SQLModel

from app.db.utils import utcnow


class ExportCache(SQLModel, table=True):
    """导出状态缓存（替代原 Redis key `openoii:export:{id}`，TTL 1 小时）。"""

    export_id: str = Field(primary_key=True, max_length=64)
    payload: str = Field(sa_column=Column(Text, nullable=False))
    expires_at: datetime = Field(default_factory=utcnow, index=True)
    created_at: datetime = Field(default_factory=utcnow)
