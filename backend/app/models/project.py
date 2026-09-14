from datetime import datetime
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Column, Integer, JSON
from sqlmodel import Field, Relationship, SQLModel

from app.db.utils import utcnow

if TYPE_CHECKING:
    from app.models.universe import Universe, UniverseProjectLink


class Project(SQLModel, table=True):
    """项目"""

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str
    story: Optional[str] = None
    style: str = Field(default="anime")
    summary: Optional[str] = None  # 剧情摘要
    story_outline: dict = Field(default_factory=dict, sa_column=Column(JSON, nullable=True))
    visual_bible: Optional[str] = None
    outline_approved: bool = Field(default=False)
    video_url: Optional[str] = None  # 最终拼接视频
    status: str = Field(default="draft")
    text_provider_override: Optional[str] = None
    image_provider_override: Optional[str] = None
    video_provider_override: Optional[str] = None
    target_shot_count: Optional[int] = None
    character_hints: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=True))
    creation_mode: Optional[str] = None
    universe_id: Optional[int] = Field(default=None, foreign_key="universe.id")
    chapter_number: Optional[int] = None
    chapter_title: Optional[str] = None
    reference_images: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=True))
    exports: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=True))
    skill_id: Optional[str] = Field(default=None, index=True)
    reimagine_meta: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Optimistic concurrency: the engine and the HTTP API both write this row.
    # The mapper-level version_id_col turns every SQLAlchemy write into a
    # compare-and-set on revision (UPDATE ... WHERE revision = read-value,
    # bump on success); a stale or concurrent writer flush fails with
    # StaleDataError instead of silently clobbering the other writer's edit.
    _revision_col = Column(
        "revision",
        Integer,
        nullable=False,
        default=1,  # client-side: keeps version_id out of RETURNING paths
    )
    revision: int = Field(default=1, ge=1, sa_column=_revision_col)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    # Default version_id_generator: ORM bumps revision (+1) on every flush and
    # asserts the previously-read value in the UPDATE predicate.
    __mapper_args__ = {"version_id_col": _revision_col}

    universe: Optional["Universe"] = Relationship(back_populates="projects")
    universe_link: Optional["UniverseProjectLink"] = Relationship(back_populates="project")

    characters: List["Character"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    shots: List["Shot"] = Relationship(
        back_populates="project",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class Character(SQLModel, table=True):
    """角色"""

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    name: str
    description: Optional[str] = None
    image_url: Optional[str] = None
    reference_images: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=True))
    face_embedding: Optional[str] = Field(default=None)  # JSON string of 512-dim float list
    visual_notes: Optional[str] = None  # Character visual bible text
    approved_name: Optional[str] = None
    approved_description: Optional[str] = None
    approved_image_url: Optional[str] = None
    approved_at: Optional[datetime] = None
    approval_version: int = Field(default=0, ge=0)
    # Mapper-level compare-and-set on revision; see Project.revision.
    _revision_col = Column(
        "revision",
        Integer,
        nullable=False,
        default=1,  # client-side: keeps version_id out of RETURNING paths
    )
    revision: int = Field(default=1, ge=1, sa_column=_revision_col)

    # Default version_id_generator: ORM bumps revision (+1) on every flush and
    # asserts the previously-read value in the UPDATE predicate.
    __mapper_args__ = {"version_id_col": _revision_col}

    project: Optional[Project] = Relationship(back_populates="characters")

    @property
    def approval_state(self) -> str:
        if self.approval_version <= 0 or self.approved_at is None:
            return "draft"
        if (
            self.name == self.approved_name
            and self.description == self.approved_description
            and self.image_url == self.approved_image_url
        ):
            return "approved"
        return "superseded"

    def freeze_approval(self) -> None:
        self.approved_name = self.name
        self.approved_description = self.description
        self.approved_image_url = self.image_url
        self.approved_at = utcnow()
        self.approval_version = max(self.approval_version, 0) + 1


class Shot(SQLModel, table=True):
    """镜头"""

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    order: int = Field(index=True)
    description: str
    prompt: Optional[str] = None
    image_prompt: Optional[str] = None  # 首帧图片生成 prompt
    image_url: Optional[str] = None  # 首帧图片
    video_url: Optional[str] = None  # 分镜视频
    duration: Optional[float] = None
    camera: Optional[str] = None
    motion_note: Optional[str] = None
    scene: Optional[str] = None
    action: Optional[str] = None
    expression: Optional[str] = None
    lighting: Optional[str] = None
    dialogue: Optional[str] = None
    sfx: Optional[str] = None
    tts_url: Optional[str] = None  # TTS 音频文件 URL
    bgm_type: Optional[str] = None  # 使用的 BGM 类型（suspense/warm/action/sad/happy/ambient）
    seed: Optional[int] = None
    character_ids: list[int] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    approved_description: Optional[str] = None
    approved_prompt: Optional[str] = None
    approved_image_prompt: Optional[str] = None
    approved_duration: Optional[float] = None
    approved_camera: Optional[str] = None
    approved_motion_note: Optional[str] = None
    approved_scene: Optional[str] = None
    approved_action: Optional[str] = None
    approved_expression: Optional[str] = None
    approved_lighting: Optional[str] = None
    approved_dialogue: Optional[str] = None
    approved_sfx: Optional[str] = None
    approved_character_ids: list[int] = Field(
        default_factory=list, sa_column=Column(JSON, nullable=False)
    )
    approved_at: Optional[datetime] = None
    approval_version: int = Field(default=0, ge=0)
    # Optimistic concurrency: the engine and the HTTP API both write this row.
    # Mapper-level compare-and-set on revision; see Project.revision.
    _revision_col = Column(
        "revision",
        Integer,
        nullable=False,
        default=1,  # client-side: keeps version_id out of RETURNING paths
    )
    revision: int = Field(default=1, ge=1, sa_column=_revision_col)

    # Default version_id_generator: ORM bumps revision (+1) on every flush and
    # asserts the previously-read value in the UPDATE predicate.
    __mapper_args__ = {"version_id_col": _revision_col}

    project: Optional[Project] = Relationship(back_populates="shots")
    character_bindings: List["ShotCharacterBinding"] = Relationship(
        back_populates="shot",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )

    @property
    def approval_state(self) -> str:
        if self.approval_version <= 0 or self.approved_at is None:
            return "draft"
        if (
            self.description == self.approved_description
            and self.prompt == self.approved_prompt
            and self.image_prompt == self.approved_image_prompt
            and self.duration == self.approved_duration
            and self.camera == self.approved_camera
            and self.motion_note == self.approved_motion_note
            and self.scene == self.approved_scene
            and self.action == self.approved_action
            and self.expression == self.approved_expression
            and self.lighting == self.approved_lighting
            and self.dialogue == self.approved_dialogue
            and self.sfx == self.approved_sfx
            and list(self.character_ids) == list(self.approved_character_ids)
        ):
            return "approved"
        return "superseded"

    def freeze_approval(self) -> None:
        self.approved_description = self.description
        self.approved_prompt = self.prompt
        self.approved_image_prompt = self.image_prompt
        self.approved_duration = self.duration
        self.approved_camera = self.camera
        self.approved_motion_note = self.motion_note
        self.approved_scene = self.scene
        self.approved_action = self.action
        self.approved_expression = self.expression
        self.approved_lighting = self.lighting
        self.approved_dialogue = self.dialogue
        self.approved_sfx = self.sfx
        self.approved_character_ids = list(self.character_ids)
        self.approved_at = utcnow()
        self.approval_version = max(self.approval_version, 0) + 1


class ShotCharacterBinding(SQLModel, table=True):
    __tablename__ = "shot_character_binding"

    shot_id: int = Field(foreign_key="shot.id", primary_key=True, index=True)
    character_id: int = Field(foreign_key="character.id", primary_key=True, index=True)

    shot: Optional[Shot] = Relationship(back_populates="character_bindings")
