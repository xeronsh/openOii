from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


TextProviderKey = Literal["anthropic", "openai", "fake"]
ImageProviderKey = Literal["modelscope", "openai", "fake"]
VideoProviderKey = Literal["openai", "doubao", "fake"]
RunStatus = Literal[
    "queued",
    "running",
    "waiting_for_approval",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
]


class ProjectProviderEntry(BaseModel):
    class Capabilities(BaseModel):
        generate: bool | None = None
        stream: bool | None = None

    selected_key: str
    source: Literal["project", "default"]
    resolved_key: str | None
    valid: bool
    status: Literal["valid", "degraded", "invalid"] | None = None
    reason_code: str | None
    reason_message: str | None
    capabilities: Capabilities | None = None


class ProjectProviderSettingsRead(BaseModel):
    text: ProjectProviderEntry
    image: ProjectProviderEntry
    video: ProjectProviderEntry


class ProviderResolution(BaseModel):
    valid: bool
    text: ProjectProviderEntry
    image: ProjectProviderEntry
    video: ProjectProviderEntry

    def as_project_provider_settings(self) -> ProjectProviderSettingsRead:
        return ProjectProviderSettingsRead(
            text=self.text,
            image=self.image,
            video=self.video,
        )

    def as_error_details(self) -> dict[str, object]:
        return {
            "valid": self.valid,
            "modalities": self.as_project_provider_settings().model_dump(),
        }


class StoryOutlineAct(BaseModel):
    act: int
    title: str
    summary: str


class StoryOutlineRead(BaseModel):
    logline: str = ""
    genre: list[str] = Field(default_factory=list)
    themes: list[str] = Field(default_factory=list)
    setting: str = ""
    tone: str = ""
    acts: list[StoryOutlineAct] = Field(default_factory=list)
    emotional_arc: str = ""


class StoryOutlineUpdate(BaseModel):
    expected_revision: int | None = Field(default=None, ge=1)
    logline: str | None = None
    genre: list[str] | None = None
    themes: list[str] | None = None
    setting: str | None = None
    tone: str | None = None
    acts: list[StoryOutlineAct] | None = None
    emotional_arc: str | None = None
    visual_bible: str | None = None
    summary: str | None = None
    outline_approved: bool | None = None


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1)
    story: str | None = None
    style: str | None = None
    status: str | None = None
    target_shot_count: int | None = None
    character_hints: list[str] | None = None
    creation_mode: str | None = None
    reference_images: list[str] | None = None
    exports: list[str] | None = None
    text_provider_override: TextProviderKey | None = None
    image_provider_override: ImageProviderKey | None = None
    video_provider_override: VideoProviderKey | None = None
    universe_id: int | None = None
    chapter_number: int | None = None
    chapter_title: str | None = None
    skill_id: str | None = None


class ProjectUpdate(BaseModel):
    title: str | None = None
    story: str | None = None
    style: str | None = None
    status: str | None = None
    target_shot_count: int | None = None
    character_hints: list[str] | None = None
    creation_mode: str | None = None
    reference_images: list[str] | None = None
    exports: list[str] | None = None
    text_provider_override: TextProviderKey | None = None
    image_provider_override: ImageProviderKey | None = None
    video_provider_override: VideoProviderKey | None = None
    universe_id: int | None = None
    chapter_number: int | None = None
    chapter_title: str | None = None
    skill_id: str | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class ProjectBatchDeleteRequest(BaseModel):
    ids: list[int] = Field(min_length=1)


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    revision: int = 1
    title: str
    story: str | None
    style: str | None
    summary: str | None
    story_outline: StoryOutlineRead | None = None
    visual_bible: str | None = None
    outline_approved: bool = False
    video_url: str | None
    status: str
    target_shot_count: int | None = None
    character_hints: list[str] = Field(default_factory=list)
    creation_mode: str | None = None
    reference_images: list[str] = Field(default_factory=list)
    exports: list[str] = Field(default_factory=list)
    provider_settings: ProjectProviderSettingsRead
    created_at: datetime
    updated_at: datetime
    universe_id: int | None = None
    chapter_number: int | None = None
    chapter_title: str | None = None
    skill_id: str | None = None


class ProjectListRead(BaseModel):
    items: list[ProjectRead]
    total: int


class CharacterRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    revision: int = 1
    project_id: int
    name: str
    description: str | None
    image_url: str | None
    reference_images: list[str] = Field(default_factory=list)
    has_embedding: bool = False
    visual_notes: str | None = None
    approval_state: Literal["draft", "approved", "superseded"]
    approval_version: int
    approved_at: datetime | None
    approved_name: str | None
    approved_description: str | None
    approved_image_url: str | None

    @model_validator(mode="before")
    @classmethod
    def _compute_has_embedding(_cls, data: object) -> object:
        if isinstance(data, dict):
            if "has_embedding" not in data and "face_embedding" in data:
                data["has_embedding"] = bool(data.get("face_embedding"))
        elif hasattr(data, "face_embedding"):
            try:
                data.__dict__["has_embedding"] = bool(getattr(data, "face_embedding", None))
            except (AttributeError, TypeError):
                pass
        return data


class ShotRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    revision: int = 1
    project_id: int
    order: int
    description: str
    prompt: str | None = None
    image_prompt: str | None = None
    image_url: str | None = None
    video_url: str | None = None
    duration: float | None = None
    camera: str | None = None
    motion_note: str | None = None
    scene: str | None = None
    action: str | None = None
    expression: str | None = None
    lighting: str | None = None
    dialogue: str | None = None
    sfx: str | None = None
    tts_url: str | None = None
    bgm_type: str | None = None
    seed: int | None = None
    character_ids: list[int]
    approval_state: Literal["draft", "approved", "superseded"]
    approval_version: int
    approved_at: datetime | None = None
    approved_description: str | None = None
    approved_prompt: str | None = None
    approved_image_prompt: str | None = None
    approved_duration: float | None = None
    approved_camera: str | None = None
    approved_motion_note: str | None = None
    approved_scene: str | None = None
    approved_action: str | None = None
    approved_expression: str | None = None
    approved_lighting: str | None = None
    approved_dialogue: str | None = None
    approved_sfx: str | None = None
    approved_character_ids: list[int] = Field(default_factory=list)


class ShotUpdate(BaseModel):
    order: int | None = Field(default=None, ge=1)
    description: str | None = None
    prompt: str | None = None
    image_prompt: str | None = None
    duration: float | None = Field(default=None, gt=0)
    camera: str | None = None
    motion_note: str | None = None
    scene: str | None = None
    action: str | None = None
    expression: str | None = None
    lighting: str | None = None
    dialogue: str | None = None
    sfx: str | None = None
    seed: int | None = None
    character_ids: list[int] | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class ShotReorderItem(BaseModel):
    shot_id: int = Field(ge=1)
    order: int = Field(ge=1)


class ShotReorderRequest(BaseModel):
    items: list[ShotReorderItem] = Field(min_length=1)


class ShotReorderRead(BaseModel):
    shots: list[ShotRead]


class CharacterUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    image_url: str | None = None
    visual_notes: str | None = None
    reference_images: list[str] | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class RegenerateRequest(BaseModel):
    type: Literal["image", "video"]
    description: str | None = None
    image_url: str | None = None


class CancelRunResponse(BaseModel):
    """Cancellation is durable; cancelling means executor acknowledgement is pending."""

    status: Literal["cancelling", "cancelled", "no_active_run"]
    cancelled: int = 0
    run_ids: list[int] = Field(default_factory=list)


class FeedbackAcceptedResponse(BaseModel):
    """反馈已受理；run_id 是本次反馈触发的 run。"""

    status: Literal["accepted"] = "accepted"
    run_id: int


class GenerateRequest(BaseModel):
    seed: int | None = None
    notes: str | None = None
    auto_mode: bool = False
    skill_id: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    entity_ids: list[int] | None = None


class ResumeRequest(BaseModel):
    run_id: int


class AgentRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    status: RunStatus
    current_agent: str | None
    progress: float
    error: str | None
    resource_type: str | None
    resource_id: int | None
    provider_snapshot: ProjectProviderSettingsRead | None = None
    workflow_version: int = 1
    execution_attempt: int = 0
    created_at: datetime
    updated_at: datetime


class RecoveryStageRead(BaseModel):
    name: str
    status: Literal["completed", "current", "pending", "blocked"]
    artifact_count: int = 0


class RecoverySummaryRead(BaseModel):
    project_id: int
    run_id: int
    current_stage: str
    next_stage: str | None = None
    preserved_stages: list[str] = Field(default_factory=list)
    stage_history: list[RecoveryStageRead] = Field(default_factory=list)
    resumable: bool = True


class RecoveryControlRead(BaseModel):
    state: Literal["active", "recoverable"]
    detail: str
    available_actions: list[Literal["resume", "cancel"]] = Field(
        default_factory=lambda: ["resume", "cancel"]
    )
    active_run: AgentRunRead
    recovery_summary: RecoverySummaryRead


class FeedbackRequest(BaseModel):
    content: str = Field(min_length=1)
    run_id: int | None = None
    feedback_type: str | None = None
    entity_type: str | None = None
    entity_id: int | None = None
    """Primary selected entity (back-compat)."""
    entity_ids: list[int] | None = None
    """Multi-select 九宫格 / cast binding — all targeted entity ids."""


class FillEmptyShotsRequest(BaseModel):
    """补齐九宫格空格：只生成缺少首帧或视频的分镜。"""

    type: Literal["image", "video"] = "image"


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    run_id: int | None
    agent: str
    role: str
    content: str
    summary: str | None
    progress: float | None
    is_loading: bool
    created_at: datetime


class AssetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    asset_type: Literal["character", "scene"]
    description: str | None = None
    image_url: str | None = None
    metadata_json: str | None = None
    source_project_id: int | None = None
    tags: str | None = None


class UseAssetInProjectRequest(BaseModel):
    project_id: int


class AssetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    asset_type: str
    description: str | None
    image_url: str | None
    metadata_json: str | None
    source_project_id: int | None
    tags: str | None
    created_at: datetime
    updated_at: datetime


class AssetListRead(BaseModel):
    items: list[AssetRead]
    total: int


class CharacterBibleRead(BaseModel):
    """角色圣经 — visual_notes + reference_images + embedding 状态 + 相似度"""

    character_id: int
    name: str
    description: str | None
    visual_notes: str | None
    reference_images: list[str] = Field(default_factory=list)
    has_embedding: bool = False
    similarity_scores: list[dict[str, object]] = Field(default_factory=list)


class CharacterBibleUpdate(BaseModel):
    """更新角色圣经"""

    visual_notes: str | None = None
    reference_images: list[str] | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class ReferenceImageCreate(BaseModel):
    """添加参考图 URL"""

    image_url: str = Field(min_length=1)
    label: str | None = None
