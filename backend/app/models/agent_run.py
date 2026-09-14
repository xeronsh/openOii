from datetime import datetime
from typing import List, Optional

from sqlalchemy import Column, JSON, Text
from sqlmodel import Field, Relationship, SQLModel

from app.db.utils import utcnow
from app.generated.workflow_contract import WORKFLOW_VERSION


class AgentRun(SQLModel, table=True):
    """Canonical durable workflow run.

    The executor lease makes execution ownership explicit across backend/engine
    process restarts. ``provider_snapshot`` is kept for the public API while
    ``context_snapshot`` grows into the immutable execution context consumed by
    every stage of this run.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: int = Field(foreign_key="project.id", index=True)
    status: str = Field(default="queued")  # queued|running|waiting_for_approval|...|terminal
    current_agent: Optional[str] = None
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    route_decision: Optional[str] = Field(default=None, sa_column=Column(Text))
    patch_plan: Optional[str] = Field(default=None, sa_column=Column(Text))
    error: Optional[str] = None
    # 资源级别锁：用于细粒度并发控制
    resource_type: Optional[str] = Field(default=None, index=True)  # character|shot|project
    resource_id: Optional[int] = Field(default=None, index=True)  # 对应资源的 ID
    provider_snapshot: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON, nullable=True)
    )

    # Workflow/execution identity. A run always executes one immutable workflow
    # version and context snapshot; config changes affect only future runs.
    workflow_version: int = Field(default=WORKFLOW_VERSION, ge=1)
    execution_attempt: int = Field(default=0, ge=0)
    context_snapshot: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON, nullable=True)
    )

    # Durable single-executor lease. lease_token is a fencing token for the
    # current execution attempt; an expired/stale owner must not keep committing.
    lease_owner: Optional[str] = None
    lease_token: Optional[str] = Field(default=None, index=True)
    lease_expires_at: Optional[datetime] = None
    cancel_requested_at: Optional[datetime] = None

    # 审批闸门信号（替代原 Redis confirm key）：API 侧置 True，编排侧消费后复位
    confirm_requested: bool = Field(default=False)
    # 当前闸门的 run_awaiting_confirm payload，用于 WS 重连补发（替代原 Redis key）
    awaiting_payload: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON, nullable=True)
    )
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    messages: List["AgentMessage"] = Relationship(
        back_populates="run",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "lazy": "selectin"},
    )


class AgentMessage(SQLModel, table=True):
    """Agent 消息记录"""

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="agentrun.id", index=True)
    agent: str
    role: str  # system|user|assistant|tool
    content: str
    created_at: datetime = Field(default_factory=utcnow)

    run: Optional[AgentRun] = Relationship(back_populates="messages")
