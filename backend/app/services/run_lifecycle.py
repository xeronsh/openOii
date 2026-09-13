"""Run 生命周期：唯一的「创建 run 并让它跑起来」入口。

设计意图（KISS + 单一路径）
--------------------------
项目里有两种实际执行体，但它们对调用方应当是同一件事：

1. **编排 run**：整片生成 / 反馈重跑 —— 交给 pi 引擎（`pipeline/runner.ts`）。
2. **局部 run**：单体重绘/单镜重合成/补齐空格 —— 仍由 Python 侧的
   Render/Compose agent 进程内执行（引擎尚未移植角色一致性渲染，
   见 ADR 0005 与 agents/render.py 的能力说明）。

之前这两条路径在 3 个 route 里各抄了一份约 90 行的骨架：细粒度并发锁、
产物失效、WS 通知、建 run、起 task、注册 task_manager。任何一处改错都要
改三遍。这里把骨架收成一处，route 只负责「校验 + 说明要做什么」。

对外契约
--------
- 同一资源上已有活跃 run → `RunConflict`（由 route 转 409）。
- 编排 run 派发失败（引擎不可达）→ `EngineUnavailableError` 冒泡（转 503）。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.base import TargetIds
from app.models.agent_run import AgentRun
from app.models.project import Project
from app.services.agent_runner import run_agent_plan
from app.services.task_manager import task_manager
from app.ws.manager import ConnectionManager

# resource_type 的合法取值（也是细粒度锁的粒度）
ResourceType = Literal["project", "character", "shot"]


class RunConflict(Exception):
    """同一资源上已有活跃 run。"""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class LocalRunSpec:
    """一次 Python 进程内的局部 run（重绘 / 重合成 / 补齐）。"""

    project_id: int
    resource_type: ResourceType
    resource_id: int | None
    agent_plan: list[Any]
    target_ids: TargetIds


@dataclass(frozen=True)
class LocalRunResult:
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


def _agent_name(agent_plan: list[Any]) -> str | None:
    if not agent_plan:
        return None
    return getattr(agent_plan[0], "name", None)


async def create_local_run(
    session: AsyncSession,
    *,
    settings: Any,
    ws: ConnectionManager,
    spec: LocalRunSpec,
) -> LocalRunResult:
    """建 run、起 task、注册取消句柄 —— 局部 run 的唯一入口。"""
    run = AgentRun(
        project_id=spec.project_id,
        status="running",
        current_agent=_agent_name(spec.agent_plan),
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
    task = asyncio.create_task(
        run_agent_plan(
            project_id=spec.project_id,
            run_id=run_id,
            agent_plan=spec.agent_plan,
            settings=settings,
            ws=ws,
            target_ids=spec.target_ids,
        )
    )
    # 按 run_id 登记：同项目下的多个局部 run 可以并行（锁粒度是具体资源）。
    task_manager.register(run_id, spec.project_id, task)
    return LocalRunResult(run=run)


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
