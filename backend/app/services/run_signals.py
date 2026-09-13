"""Run confirm signal + awaiting payload (agentrun 列；替代原 Redis 实现).

信号位跨进程可见（Python 与 pi 引擎 sidecar 经共享 SQLite 读写同一列），
编排侧轮询消费；payload 用于 WS 重连补发。

Stage/agent 映射常量同住这里：route 层、WS 层与 agent_runner 都依赖它们，
而它们是纯数据，不该拖着编排执行体一起被 import。
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select, update

from app.models.agent_run import AgentRun

_CONFIRM_POLL_INTERVAL_S = 0.3

# 阶段 → 执行该阶段的 agent
STAGE_AGENT_MAP: dict[str, str] = {
    "plan_outline": "outline",
    "outline_approval": "outline",
    "plan_characters": "plan",
    "characters_approval": "plan",
    "plan_shots": "plan",
    "shots_approval": "plan",
    "render_characters": "render",
    "character_images_approval": "render",
    "critique_character_images": "critic",
    "render_shots": "render",
    "shot_images_approval": "render",
    "critique_shot_images": "critic",
    "compose_videos": "compose",
    "compose_merge": "compose",
    "add_audio": "compose",
    "compose_approval": "compose",
    "review": "review",
}

# agent → 具有代表性的图阶段（WS 进度回放用）
GRAPH_STAGE_FOR_AGENT: dict[str, str] = {
    "outline": "plan_outline",
    "plan": "plan_characters",
    "render": "render_characters",
    "compose": "compose_videos",
    "review": "review",
    "critic": "critique_character_images",
}

AGENT_STAGE_MAP = STAGE_AGENT_MAP
RESUME_AGENT_FOR_STAGE = STAGE_AGENT_MAP


def resume_agent_for_stage(stage: str | None) -> str:
    if not isinstance(stage, str):
        return "plan"
    return RESUME_AGENT_FOR_STAGE.get(stage, "plan")


async def _update_run_columns(run_id: int, **values: object) -> None:
    from app.db.session import async_session_maker

    async with async_session_maker() as session:
        await session.execute(update(AgentRun).where(AgentRun.id == run_id).values(**values))
        await session.commit()


async def trigger_confirm_signal(run_id: int) -> bool:
    """设置 run 的审批信号位（替代原 Redis confirm key）。"""
    await _update_run_columns(run_id, confirm_requested=True)
    return True


async def clear_confirm_signal(run_id: int) -> None:
    await _update_run_columns(run_id, confirm_requested=False)


async def wait_for_confirm_signal(run_id: int, timeout: int = 1800) -> bool:
    """轮询等待审批信号；使用独立 session，不复用编排会话。"""
    from app.db.session import async_session_maker

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        async with async_session_maker() as session:
            res = await session.execute(
                select(AgentRun.confirm_requested).where(AgentRun.id == run_id)
            )
            requested = res.scalar()
        if requested:
            await _update_run_columns(run_id, confirm_requested=False)
            return True
        await asyncio.sleep(_CONFIRM_POLL_INTERVAL_S)
    return False


async def store_awaiting_payload(run_id: int, payload: dict) -> None:
    """记录当前 run 在 gate 等待，附带 run_awaiting_confirm 事件 payload"""
    await _update_run_columns(run_id, awaiting_payload=payload)


async def clear_awaiting_payload(run_id: int) -> None:
    await _update_run_columns(run_id, awaiting_payload=None)


async def get_awaiting_payload(run_id: int) -> dict | None:
    from app.db.session import async_session_maker

    async with async_session_maker() as session:
        res = await session.execute(
            select(AgentRun.awaiting_payload).where(AgentRun.id == run_id)
        )
        payload = res.scalar()
    return payload if isinstance(payload, dict) else None
