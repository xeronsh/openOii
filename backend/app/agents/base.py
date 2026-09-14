"""Agent primitives shared by the in-process agents.

Note on the architecture constraint (ADR 0008): openOii Engine is the only
orchestration runtime, and `BaseAgent` subclasses under `app/agents/` that run a
loop are violations being removed. `agents/review_rules.py` is the sanctioned
use of this module: it classifies a rerun start point and runs no agent loop.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.agent_run import AgentRun
from app.models.message import Message
from app.models.project import Project
from app.schemas.project import CharacterRead, ShotRead
from app.services.image_factory import ImageServiceProtocol
from app.services.llm import LLMResponse
from app.services.text_factory import TextServiceProtocol
from app.services.video_factory import VideoServiceProtocol
from app.ws.manager import ConnectionManager

if TYPE_CHECKING:
    from app.models.project import Character

logger = logging.getLogger(__name__)


@dataclass
class TargetIds:
    """精细化控制的目标 ID"""

    character_ids: list[int] = field(default_factory=list)
    shot_ids: list[int] = field(default_factory=list)

    def has_targets(self) -> bool:
        """是否有指定的目标"""
        return bool(self.character_ids or self.shot_ids)


@dataclass
class CompletionInfo:
    """Agent 完成时的确认信息，由 agent 在 run() 结束时设置"""

    completed: str = ""
    details: str = ""
    next: str = ""
    question: str = ""


@dataclass
class AgentContext:
    settings: Settings
    session: AsyncSession
    ws: ConnectionManager
    project: Project
    run: AgentRun
    llm: TextServiceProtocol
    image: ImageServiceProtocol
    video: VideoServiceProtocol
    user_feedback: str | None = None
    feedback_type: str | None = None  # "plan" | "character" | "shot" | "compose"
    entity_type: str | None = None  # "character" | "shot"
    entity_id: int | None = None  # primary per-entity feedback target
    entity_ids: list[int] | None = None  # multi-select 九宫格 / cast targets
    skill_id: str | None = None  # durable skill policy for LLM injection
    rerun_mode: str = "full"  # "full" or "incremental"
    target_ids: TargetIds | None = None  # 精细化控制的目标 ID
    completion_info: CompletionInfo | None = None
    plan_data: dict | None = None  # Cached LLM response from plan_characters for plan_shots


class BaseAgent:
    name: str = "base"

    async def send_message(
        self,
        ctx: AgentContext,
        content: str,
        summary: str | None = None,
        progress: float | None = None,
        is_loading: bool = False,
    ) -> None:
        """发送消息

        Args:
            ctx: Agent 上下文
            content: 消息内容
            summary: 摘要（用于确认环节显示）
            progress: 进度值（0-1 之间）
            is_loading: 是否显示加载动画
        """
        data: dict[str, Any] = {
            "agent": self.name,
            "role": "assistant",
            "content": content,
            "project_id": ctx.project.id,
            "run_id": ctx.run.id,
        }
        if summary is not None:
            data["summary"] = summary
        if progress is not None:
            data["progress"] = progress
        if is_loading:
            data["isLoading"] = True

        # 保存到数据库
        message = Message(
            project_id=ctx.project.id,
            run_id=ctx.run.id,
            agent=self.name,
            role="assistant",
            content=content,
            summary=summary,
            progress=progress,
            is_loading=is_loading,
        )
        ctx.session.add(message)
        await ctx.session.commit()

        # 发送 WebSocket 事件
        assert ctx.project.id is not None
        await ctx.ws.send_event(
            ctx.project.id,
            {"type": "run_message", "data": data},
        )

    # Phase visibility map for detail levels
    _PHASE_VISIBILITY: dict[str, set[str]] = {
        "minimal": {"decision"},
        "normal": {"decision", "reviewing"},
        "verbose": {"reasoning", "decision", "planning", "reviewing"},
    }

    async def send_thinking(
        self,
        ctx: AgentContext,
        phase: Literal["reasoning", "decision", "planning", "reviewing"],
        content: str,
        details: str | None = None,
    ) -> None:
        """发送思考链消息

        根据 thinking_chain_enabled 和 thinking_chain_detail_level 过滤推送。
        消息推送为轻量 WS 写入，不会显著阻塞主流程。

        Args:
            ctx: Agent 上下文
            phase: 思考阶段 (reasoning/decision/planning/reviewing)
            content: 思考内容
            details: 可选补充详情
        """
        if not ctx.settings.thinking_chain_enabled:
            return

        detail_level = getattr(ctx.settings, "thinking_chain_detail_level", "normal") or "normal"
        visible_phases = self._PHASE_VISIBILITY.get(detail_level, self._PHASE_VISIBILITY["normal"])
        if phase not in visible_phases:
            return

        try:
            # 1. Send dedicated agent_thinking WS event
            assert ctx.project.id is not None
            await ctx.ws.send_event(
                ctx.project.id,
                {
                    "type": "agent_thinking",
                    "data": {
                        "agent": self.name,
                        "phase": phase,
                        "content": content,
                        "details": details,
                    },
                },
            )
            # 2. Also send as run_message with role="thinking" for backward-compatible display
            data: dict[str, Any] = {
                "agent": self.name,
                "role": "thinking",
                "content": content,
                "project_id": ctx.project.id,
                "run_id": ctx.run.id,
            }
            if details:
                data["summary"] = content
                data["content"] = f"{content}\n{details}"
            await ctx.ws.send_event(
                ctx.project.id,
                {"type": "run_message", "data": data},
            )
        except Exception:
            logger.debug("send_thinking failed (non-critical)", exc_info=True)

    async def send_character_event(
        self, ctx: AgentContext, character: Any, event_type: str = "character_created"
    ) -> None:
        """发送角色创建/更新事件"""
        assert ctx.project.id is not None
        payload = CharacterRead.model_validate(character).model_dump(mode="json")
        await ctx.ws.send_event(
            ctx.project.id,
            {
                "type": event_type,
                "data": {"character": payload},
            },
        )

    async def send_shot_event(
        self, ctx: AgentContext, shot: Any, event_type: str = "shot_created"
    ) -> None:
        """发送分镜创建/更新事件"""
        assert ctx.project.id is not None
        payload = ShotRead.model_validate(shot).model_dump(mode="json")
        await ctx.ws.send_event(
            ctx.project.id,
            {
                "type": event_type,
                "data": {"shot": payload},
            },
        )

    async def generate_and_cache_image(
        self,
        ctx: AgentContext,
        prompt: str,
        image_bytes: bytes | None = None,
        timeout_s: float | None = None,
        **kwargs: Any,
    ) -> str:
        """生成图片并缓存到本地

        Args:
            ctx: Agent 上下文
            prompt: 图片生成 prompt
            image_bytes: 可选的参考图片字节流（用于 I2I）
            timeout_s: 仅对 generate_url 阶段生效的超时（秒）；缓存/下载不受此超时影响
            **kwargs: 传递给 generate_url 的额外参数

        Returns:
            缓存后的图片 URL
        """
        generate_url_coro = ctx.image.generate_url(
            prompt=prompt,
            image_bytes=image_bytes,
            **kwargs,
        )
        if timeout_s is not None:
            try:
                url = await asyncio.wait_for(generate_url_coro, timeout=timeout_s)
            except asyncio.TimeoutError as exc:
                raise RuntimeError(f"图片生成超时（超过{timeout_s:.0f}秒）") from exc
        else:
            url = await generate_url_coro
        return await ctx.image.cache_external_image(url)

    async def get_project_characters(self, ctx: AgentContext) -> list["Character"]:
        """获取项目的所有角色

        Args:
            ctx: Agent 上下文

        Returns:
            角色列表
        """
        from app.models.project import Character
        from sqlalchemy import select

        res = await ctx.session.execute(
            select(Character).where(Character.project_id == ctx.project.id)
        )
        return list(res.scalars().all())

    async def send_progress_batch(
        self,
        ctx: AgentContext,
        total: int,
        current: int,
        message: str,
    ) -> None:
        """发送批处理进度消息

        Args:
            ctx: Agent 上下文
            total: 总数
            current: 当前索引（从 0 开始）
            message: 进度消息
        """
        progress = (current + 1) / total if total > 0 else 0.0
        if progress < 0.0:
            progress = 0.0
        if progress > 1.0:
            progress = 1.0
        await self.send_message(ctx, message, progress=progress, is_loading=True)

    async def call_llm(
        self,
        ctx: AgentContext,
        system_prompt: str,
        user_prompt: str,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 2048,
        stream_to_ws: bool = False,
    ) -> LLMResponse:
        """调用 LLM 并返回最终响应。

        Args:
            stream_to_ws: 是否将流式文本推送到 WebSocket（默认关闭，因为 JSON 输出不适合直接展示）
        """

        messages: list[dict[str, Any]] = [{"role": "user", "content": user_prompt}]

        final: LLMResponse | None = None
        buffer = ""

        async for event in ctx.llm.stream(
            messages=messages, system=system_prompt, tools=tools, max_tokens=max_tokens
        ):
            event_type = event.get("type")
            if event_type == "text":
                delta = event.get("text", "")
                if not isinstance(delta, str) or not delta:
                    continue
                buffer += delta
                # 只有明确要求时才流式推送（JSON 输出不适合直接展示给用户）
                if stream_to_ws and (
                    len(buffer) >= 80 or buffer.endswith(("\n", "。", ".", "!", "?", "！", "？"))
                ):
                    await self.send_message(ctx, buffer)
                    buffer = ""
            elif event_type == "final":
                resp = event.get("response")
                if isinstance(resp, LLMResponse):
                    final = resp

        if stream_to_ws and buffer:
            await self.send_message(ctx, buffer)

        if final is None:  # pragma: no cover
            raise RuntimeError("LLM stream finished without final response")
        return final

    async def run(self, ctx: AgentContext) -> None:  # pragma: no cover
        raise NotImplementedError
