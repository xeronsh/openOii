from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .project import (
    CharacterRead,
    ProjectProviderSettingsRead,
    RecoverySummaryRead,
    ShotRead,
    StoryOutlineRead,
)


WsEventType = Literal[
    "connected",
    "pong",
    "echo",
    "error",
    "run_started",
    "run_progress",
    "run_message",
    "agent_thinking",
    "run_completed",
    "run_failed",
    "run_awaiting_confirm",
    "run_confirmed",
    "run_cancelled",
    "character_created",
    "character_updated",
    "character_deleted",
    "shot_created",
    "shot_updated",
    "shots_reordered",
    "shot_deleted",
    # Kept for backward compatibility; current outline writes usually emit
    # project_updated, but stale clients/tests may still send outline_updated.
    "outline_updated",
    "project_updated",
    "data_cleared",
    "critique_result",
    "bible_updated",
    "version_created",
    "version_rollback",
    "audio_generated",
    "export_completed",
    "consistency_eval_completed",
]


class RunProgressEventData(BaseModel):
    run_id: int
    project_id: int | None = None
    current_agent: str | None = None
    current_stage: str | None = None
    stage: str | None = None
    next_stage: str | None = None
    progress: float = Field(ge=0.0, le=1.0)
    recovery_summary: RecoverySummaryRead | None = None


class RunStartedEventData(BaseModel):
    run_id: int
    project_id: int | None = None
    provider_snapshot: dict[str, Any] | None = None
    current_stage: str | None = None
    stage: str | None = None
    next_stage: str | None = None
    progress: float = Field(ge=0.0, le=1.0, default=0.0)
    current_agent: str | None = None
    recovery_summary: RecoverySummaryRead | None = None
    preserved_stages: list[str] = Field(default_factory=list)


class RunMessageEventData(BaseModel):
    agent: str | None = None
    role: str | None = None
    content: str = ""
    summary: str | None = None
    progress: float | None = Field(default=None, ge=0.0, le=1.0)
    isLoading: bool | None = None


class RunCompletedEventData(BaseModel):
    run_id: int | None = None
    project_id: int | None = None
    current_stage: str | None = None
    current_agent: str | None = None
    message: str | None = None
    video_generation_pending: bool | None = None


class RunFailedEventData(BaseModel):
    run_id: int | None = None
    project_id: int | None = None
    error: str | None = None
    agent: str | None = None
    current_stage: str | None = None


class RunCancelledEventData(BaseModel):
    run_id: int | None = None
    project_id: int | None = None
    run_ids: list[int] | None = None
    cancelled_count: int | None = None


class DataClearedEventData(BaseModel):
    cleared_types: list[str] = Field(default_factory=list)
    # Present on full re-plan wipes; optional on incremental media clear
    start_agent: str | None = None
    mode: str | None = None


class ErrorEventData(BaseModel):
    code: str
    message: str


class CharacterCreatedEventData(BaseModel):
    character: CharacterRead


class CharacterDeletedEventData(BaseModel):
    character_id: int


class ShotCreatedEventData(BaseModel):
    shot: ShotRead


class ShotDeletedEventData(BaseModel):
    shot_id: int


class OutlineUpdatedEventData(BaseModel):
    project_id: int
    story_outline: StoryOutlineRead | None = None
    visual_bible: str | None = None
    outline_approved: bool = False


class RunAwaitingConfirmEventData(BaseModel):
    run_id: int
    project_id: int | None = None
    agent: str
    gate: str | None = None
    current_stage: str | None = None
    stage: str | None = None
    next_stage: str | None = None
    recovery_summary: RecoverySummaryRead
    preserved_stages: list[str] = Field(default_factory=list)
    message: str | None = None
    completed: str | None = None
    next_step: str | None = None
    question: str | None = None
    auto_mode: bool | None = None
    story_outline: StoryOutlineRead | None = None
    visual_bible: str | None = None


class RunConfirmedEventData(BaseModel):
    run_id: int
    project_id: int | None = None
    agent: str
    gate: str | None = None
    current_stage: str | None = None
    stage: str | None = None
    next_stage: str | None = None
    recovery_summary: RecoverySummaryRead | None = None
    auto_mode: bool | None = None


class CharacterUpdatedEventData(BaseModel):
    character: CharacterRead


class ShotUpdatedEventData(BaseModel):
    shot: ShotRead


class ShotsReorderedEventData(BaseModel):
    project_id: int
    shots: list[ShotRead]


class BlockingClipPayload(BaseModel):
    shot_id: int
    order: int
    status: str
    reason: str


class ProjectUpdatedPayload(BaseModel):
    id: int
    revision: int | None = None
    title: str | None = None
    story: str | None = None
    style: str | None = None
    summary: str | None = None
    video_url: str | None = None
    status: str | None = None
    target_shot_count: int | None = None
    character_hints: list[str] | None = None
    creation_mode: str | None = None
    reference_images: list[str] | None = None
    exports: list[str] | None = None
    provider_settings: ProjectProviderSettingsRead | None = None
    universe_id: int | None = None
    chapter_number: int | None = None
    chapter_title: str | None = None
    skill_id: str | None = None
    story_outline: StoryOutlineRead | None = None
    visual_bible: str | None = None
    outline_approved: bool | None = None
    blocking_clips: list[BlockingClipPayload] | None = None


class ProjectUpdatedEventData(BaseModel):
    project: ProjectUpdatedPayload


class CritiqueResultEventData(BaseModel):
    score: float = Field(ge=0.0, le=10.0)
    dimensions: dict[str, int] = Field(default_factory=dict)
    issues: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)
    entity_type: str = ""  # "character" or "shot"
    entity_id: int = 0
    will_regenerate: bool = False


class BibleUpdatedEventData(BaseModel):
    character_id: int
    visual_notes: bool = False  # whether visual_notes was updated
    reference_images_count: int = 0
    has_embedding: bool = False


class AudioGeneratedEventData(BaseModel):
    shot_id: int
    tts_url: str | None = None
    bgm_type: str | None = None
    duration: float | None = None


class AgentThinkingEventData(BaseModel):
    agent: str
    phase: Literal["reasoning", "decision", "planning", "reviewing"]
    content: str
    details: str | None = None


class VersionCreatedEventData(BaseModel):
    entity_type: Literal["character", "shot"]
    entity_id: int
    version: int
    trigger: str


class VersionRollbackEventData(BaseModel):
    entity_type: Literal["character", "shot"]
    entity_id: int
    from_version: int
    to_version: int


class ConsistencyEvalCompletedEventData(BaseModel):
    project_id: int
    overall_score: float = Field(ge=0.0, le=100.0)
    character_count: int = 0


class WsEvent(BaseModel):
    type: WsEventType
    data: dict[str, Any] = Field(default_factory=dict)
