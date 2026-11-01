"""角色一致性评估 Schemas"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.db.utils import UtcDatetime


class FaceMatchDetailRead(BaseModel):
    """单个分镜的人脸匹配详情"""

    shot_id: int
    shot_order: int
    similarity: float = Field(ge=0.0, le=1.0)
    detected: bool


class CharacterConsistencyRead(BaseModel):
    """单个角色的一致性报告"""

    character_id: int
    character_name: str
    face_similarity_mean: float = Field(ge=0.0, le=1.0)
    face_similarity_std: float = Field(ge=0.0)
    presence_rate: float = Field(ge=0.0, le=1.0)
    overall_score: float = Field(ge=0.0, le=100.0)
    face_matches: list[FaceMatchDetailRead] = Field(default_factory=list)
    grade: str  # A/B/C/D/F


class ProjectConsistencyRead(BaseModel):
    """项目级一致性报告"""

    project_id: int
    overall_score: float = Field(ge=0.0, le=100.0)
    character_reports: list[CharacterConsistencyRead] = Field(default_factory=list)
    evaluated_at: UtcDatetime
    # 由 ConsistencyEvalService 在报告落库后回填，持久化的 report_data 中不含该字段
    eval_id: int | None = None


class ConsistencyEvalResponse(BaseModel):
    """触发评估的响应"""

    eval_id: int
    status: str = "processing"


class ConsistencyReportRead(BaseModel):
    """数据库持久化的评估报告摘要"""

    id: int
    project_id: int
    overall_score: float
    created_at: UtcDatetime
    report_data: ProjectConsistencyRead | None = None
