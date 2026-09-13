from __future__ import annotations

from datetime import datetime
from sqlmodel import Field, SQLModel

from app.db.utils import utcnow


class Stage(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    run_id: int = Field(foreign_key="run.id", index=True)
    name: str = Field(index=True)
    status: str = Field(default="pending", index=True)
    version: int = Field(default=1, ge=1)
    source: str = Field(default="engine")
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
