"""Universe / IP 宇宙相关 Schema。"""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from app.db.utils import UtcDatetime


class UniverseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    world_setting: str | None = None
    style_rules: str | None = None
    cover_image_url: str | None = None


class UniverseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    world_setting: str | None = None
    style_rules: str | None = None
    cover_image_url: str | None = None
    is_active: bool | None = None


class UniverseProjectLinkCreate(BaseModel):
    project_id: int
    chapter_number: int | None = None
    chapter_title: str | None = None
    is_main_story: bool = True


class UniverseProjectLinkRead(BaseModel):
    id: int
    universe_id: int
    project_id: int
    chapter_number: int | None = None
    chapter_title: str | None = None
    is_main_story: bool = True
    created_at: UtcDatetime
    # joined from project
    project_title: str | None = None

    model_config = {"from_attributes": True}


class ImportedCharacterRead(BaseModel):
    id: int
    name: str
    project_id: int


class ImportSharedCastRead(BaseModel):
    project_id: int
    imported_count: int
    imported: list[ImportedCharacterRead] = Field(default_factory=list)
    skipped_existing: int = 0


class SharedCharacterRead(BaseModel):
    id: int
    universe_id: int
    name: str
    description: str | None = None
    visual_notes: str | None = None
    canonical_image_url: str | None = None
    reference_images: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _compute_has_embedding(_cls, data: object) -> object:
        if isinstance(data, dict) and "face_embedding" in data:
            emb = data.get("face_embedding")
            data["has_embedding"] = bool(emb and isinstance(emb, str) and emb.strip())
            data.pop("face_embedding", None)
        return data

    character_tags: str | None = None
    source_project_id: int | None = None
    source_character_id: int | None = None
    version: int = 1
    is_active: bool = True
    created_at: UtcDatetime
    updated_at: UtcDatetime

    # computed helpers
    reference_images_count: int = 0
    has_embedding: bool = False

    model_config = {"from_attributes": True}


class SharedCharacterPromote(BaseModel):
    """从项目角色提升为共享角色的请求"""
    character_id: int  # 项目角色 ID


class SharedCharacterManualCreate(BaseModel):
    """手动创建共享角色"""
    name: str = Field(min_length=1)
    description: str | None = None
    visual_notes: str | None = None
    canonical_image_url: str | None = None
    character_tags: str | None = None


class UniverseRead(BaseModel):
    id: int
    name: str
    description: str | None = None
    world_setting: str | None = None
    style_rules: str | None = None
    cover_image_url: str | None = None
    is_active: bool = True
    created_at: UtcDatetime
    updated_at: UtcDatetime
    # computed
    projects_count: int = 0
    shared_characters_count: int = 0

    model_config = {"from_attributes": True}


class UniverseDetailRead(UniverseRead):
    """Universe 详情，含章节列表和共享角色列表"""
    chapters: list[UniverseProjectLinkRead] = Field(default_factory=list)
    shared_characters: list[SharedCharacterRead] = Field(default_factory=list)


class UniverseTimelineChapterRead(BaseModel):
    """跨章节时间线条目（工作台 continuity 面板）"""

    project_id: int
    chapter_number: int | None = None
    chapter_title: str | None = None
    title: str
    summary: str | None = None
    status: str
    is_main_story: bool = True
    is_current: bool = False
    character_count: int = 0
    shot_count: int = 0
    has_video: bool = False
    style: str | None = None


class UniverseTimelineRead(BaseModel):
    universe_id: int
    universe_name: str
    world_setting: str | None = None
    style_rules: str | None = None
    chapters: list[UniverseTimelineChapterRead] = Field(default_factory=list)
    shared_character_count: int = 0
    shared_characters: list[SharedCharacterRead] = Field(default_factory=list)
