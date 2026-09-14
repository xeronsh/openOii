"""Run 生命周期：唯一的「创建 run 并让它跑起来」入口。

设计意图（KISS + 单一路径）
--------------------------
只存在**一种**执行体：openOii Engine（ADR 0008）。编排 run 与局部 run
（单体定向重绘 / 单镜重合成 / 补齐空格）都只是「给引擎的指令 + 实体范围」，
差别仅在于 stage 与 target ids：引擎自己决定该跑哪些 stage。

之前这里有两种执行体：局部 run 由 Python 侧的 Render/Compose agent 在进程内
执行。那是被删除的违规形状——FastAPI 决定下一步做什么。现在 route 只负责
「校验 + 说明要做什么」，编排决策全部在引擎里。

对外契约
--------
- 同一资源上已有活跃 run → `RunConflict`（由 route 转 409）。
- 派发失败（引擎不可达）→ `EngineUnavailableError` 冒泡（转 503）。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun
from app.models.project import Project
from app.services.engine_client import engine_start_run
from app.ws.manager import ConnectionManager

# resource_type 的合法取值（也是细粒度锁的粒度）
ResourceType = Literal["project", "character", "shot"]


class RunConflict(Exception):
    """同一资源上已有活跃 run。"""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class TargetedRunSpec:
    """一次定向 run（重绘 / 重合成 / 补齐）。

    这里**没有** agent 列表：调用方只描述「对哪些实体做什么」，
    由引擎（唯一 orchestration runtime）决定跑哪些 stage。
    """

    project_id: int
    resource_type: ResourceType
    resource_id: int | None
    #: Engine stage to start from; the engine narrows it to the needed stages.
    stage: str
    target_character_ids: Sequence[int] = field(default_factory=tuple)
    target_shot_ids: Sequence[int] = field(default_factory=tuple)


@dataclass(frozen=True)
class TargetedRunResult:
    run: AgentRun


async def assert_resource_idle(
    session: AsyncSession,
    *,
    project_id: int,
    resource_type: ResourceType,
    resource_id: int,
) -> None:
    """同一资源已有活跃 run 时拒绝重复提交（细粒度锁）。

    粒度是 (project, resource_type, resource_id)：一个角色在重绘时，
    另一个角色仍可并行重绘，这是刻意的。
    """
    res = await session.execute(
        select(AgentRun.id)
        .where(AgentRun.project_id == project_id)
        .where(AgentRun.status.in_(("queued", "running")))
        .where(AgentRun.resource_type == resource_type)
        .where(AgentRun.resource_id == resource_id)
        .limit(1)
    )
    if res.first() is not None:
        raise RunConflict(f"This {resource_type} is already being processed")


async def create_local_run(
    session: AsyncSession,
    *,
    settings: Any,
    ws: ConnectionManager,
    spec: TargetedRunSpec,
) -> TargetedRunResult:
    """建 run 并把它派发给引擎 —— 定向 run 的唯一入口。

    状态语义与编排 run 一致：`queued` 表示命令已持久化，`running` 由拿到
    fencing lease 的引擎设置。这里只落 `queued`，不再预先写 `running`。
    """
    run = AgentRun(
        project_id=spec.project_id,
        status="queued",
        current_agent=None,
        progress=0.0,
        error=None,
        resource_type=spec.resource_type,
        resource_id=spec.resource_id,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    from app.api.deps import require_run_id

    run_id = require_run_id(run)

    # 派发失败（引擎不可达）会抛 EngineUnavailableError，由 route 转 503；
    # run 行保持 queued，调用方可重试 / 由恢复流程接管。
    await engine_start_run(
        settings.engine_url,
        project_id=spec.project_id,
        run_id=run_id,
        stage=spec.stage,
        auto_mode=True,
        target_character_ids=spec.target_character_ids or None,
        target_shot_ids=spec.target_shot_ids or None,
    )
    await session.refresh(run)
    return TargetedRunResult(run=run)


async def project_updated_event(
    session: AsyncSession, project: Project
) -> dict[str, Any]:
    """`project_updated` 的规范 payload —— 之前 3 个 route 各拼一遍。"""
    from app.services.creative_control import collect_project_blocking_clips

    return {
        "type": "project_updated",
        "data": {
            "project": {
                "id": project.id,
                "video_url": project.video_url,
                "status": project.status,
                "blocking_clips": await collect_project_blocking_clips(session, project),
            }
        },
    }
