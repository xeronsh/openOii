from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.db.utils import UtcDatetime

EntityType = Literal["character", "shot"]


class ArtifactVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_type: EntityType
    entity_id: int
    version: int
    snapshot: dict[str, Any] = Field(default_factory=dict)
    trigger: str
    created_at: UtcDatetime


class VersionListRead(BaseModel):
    entity_type: EntityType
    entity_id: int
    versions: list[ArtifactVersionRead]


class RollbackRequest(BaseModel):
    entity_type: EntityType
    entity_id: int
    target_version: int = Field(ge=1)


class RollbackResponse(BaseModel):
    success: bool
    message: str
    new_version: ArtifactVersionRead | None = None


class VersionDiff(BaseModel):
    field_name: str
    old_value: Any = None
    new_value: Any = None


class VersionCompareRead(BaseModel):
    entity_type: EntityType
    entity_id: int
    from_version: ArtifactVersionRead
    to_version: ArtifactVersionRead
    diffs: list[VersionDiff]
