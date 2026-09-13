from __future__ import annotations

import asyncio
import logging
from typing import Any, cast

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.utils import utcnow
from app.agents.base import AgentContext, TargetIds
from app.agents.outline import OutlineAgent
from app.agents.plan import PlanAgent
from app.agents.render import RenderAgent
from app.agents.compose import ComposeAgent
from app.agents.review_rules import ReviewAgent
from app.config import Settings
from app.models.agent_run import AgentMessage, AgentRun
from app.models.message import Message
from app.models.project import Character, Project, Shot
from app.schemas.project import GenerateRequest
from app.orchestration.driver import drive_graph_until_idle, gate_name_from_interrupt
from app.orchestration.graph import build_phase2_graph
from app.orchestration.persistence import build_postgres_checkpointer
from app.orchestration.runtime import (
    build_graph_config,
    build_phase2_runtime_context,
    build_stage_recovery_config,
)
from app.orchestration.state import Phase2Stage, next_production_stage, workflow_progress_for_stage
from app.skills.catalog import resolve_skill_entry
from app.services.creative_control import collect_project_blocking_clips
from app.services.file_cleaner import delete_files
from app.services.image_factory import create_image_service
from app.services.provider_resolution import settings_with_provider_snapshot
from app.services.run_recovery import PHASE2_STAGE_ORDER, build_recovery_summary
from app.services.text_factory import create_text_service
from app.services.video_factory import create_video_service
from app.ws.manager import ConnectionManager

logger = logging.getLogger(__name__)


def _next_phase2_stage(stage: str | None) -> str | None:
    if not isinstance(stage, str) or stage not in PHASE2_STAGE_ORDER:
        return None
    next_index = PHASE2_STAGE_ORDER.index(stage) + 1
    if next_index >= len(PHASE2_STAGE_ORDER):
        return None
    return PHASE2_STAGE_ORDER[next_index]


STAGE_AGENT_MAP = {
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

GRAPH_STAGE_FOR_AGENT = {
    "outline": "plan_outline",
    "plan": "plan_characters",
    "render": "render_characters",
    "compose": "compose_videos",
    "review": "review",
    "critic": "critique_character_images",
}
AGENT_STAGE_MAP = STAGE_AGENT_MAP
RESUME_AGENT_FOR_STAGE = STAGE_AGENT_MAP


def _resume_agent_for_stage(stage: str | None) -> str:
    if not isinstance(stage, str):
        return "plan"
    return RESUME_AGENT_FOR_STAGE.get(stage, "plan")


def _video_generation_skipped_in_result(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    return bool(result.get("video_generation_skipped"))


# Agent 完成后的描述信息
AGENT_COMPLETION_INFO = {
    "outline": {
        "completed": "已完成故事大纲",
        "details": "生成了三幕结构和视觉方向",
        "next": "确认后将进入角色设计",
        "question": "故事大纲方向是否满意？",
    },
    "plan": {
        "completed": "已完成创作方案规划",
        "details": "生成了角色设定和分镜脚本",
        "next": "接下来将为角色和分镜生成参考图片",
        "question": "创作方案是否符合您的预期？如果需要修改，请告诉我具体的调整意见。",
    },
    "render": {
        "completed": "已完成角色形象和分镜画面渲染",
        "details": "角色形象和分镜画面均已渲染完成",
        "next": "接下来将根据分镜生成视频片段并合成",
        "question": "角色形象和分镜画面是否满意？如果需要重新生成，请告诉我。",
    },
    "critic": {
        "completed": "已完成质量审查",
        "details": "已对生成的图像进行一致性、质量和构图审查",
        "next": "审查通过，继续下一步",
        "question": "审查结果是否满意？",
    },
    "compose": {
        "completed": "已完成视频合成",
        "next": "您的漫剧已经准备就绪！可以下载或分享了。",
        "question": "最终视频效果满意吗？",
    },
}


# ---------------------------------------------------------------------------
# Run confirm signal + awaiting payload（agentrun 列；替代原 Redis 实现）
# 信号位跨进程可见，编排侧轮询消费；payload 用于 WS 重连补发。
# ---------------------------------------------------------------------------

_CONFIRM_POLL_INTERVAL_S = 0.3


async def _update_run_columns(run_id: int, **values: Any) -> None:
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


class GenerationOrchestrator:
    def __init__(self, *, settings: Settings, ws: ConnectionManager, session: AsyncSession):
        self.settings = settings
        self.ws = ws
        self.session = session
        self._last_user_feedback_id: int | None = None
        self.agents = [
            OutlineAgent(),
            PlanAgent(),
            RenderAgent(),
            ComposeAgent(),
            ReviewAgent(),  # 处理用户反馈并路由重新生成（不会参与正常生成流程）
        ]

    def _agent_index(self, agent_name: str) -> int:
        for idx, agent in enumerate(self.agents):
            if agent.name == agent_name:
                return idx
        raise ValueError(f"Unknown agent: {agent_name}")

    async def _delete_project_shots(self, project_id: int) -> None:
        await self.session.execute(delete(Shot).where(Shot.project_id == project_id))

    async def _delete_project_characters(self, project_id: int) -> None:
        await self.session.execute(delete(Character).where(Character.project_id == project_id))

    async def _clear_character_images(
        self, project_id: int, character_ids: list[int] | None = None
    ) -> None:
        """清空角色图片（先删除文件再清空 URL）。ids=None 表示全项目。"""
        query = select(Character).where(Character.project_id == project_id)
        if character_ids:
            query = query.where(Character.id.in_(character_ids))
        res = await self.session.execute(query)
        chars = res.scalars().all()
        delete_files([char.image_url for char in chars])
        for char in chars:
            char.image_url = None
            self.session.add(char)

    async def _clear_shot_images(
        self, project_id: int, shot_ids: list[int] | None = None
    ) -> None:
        """清空分镜首帧图片。ids=None 表示全项目。"""
        query = select(Shot).where(Shot.project_id == project_id)
        if shot_ids:
            query = query.where(Shot.id.in_(shot_ids))
        res = await self.session.execute(query)
        shots = res.scalars().all()
        delete_files([shot.image_url for shot in shots])
        for shot in shots:
            shot.image_url = None
            self.session.add(shot)

    async def _clear_shot_videos(
        self, project_id: int, shot_ids: list[int] | None = None
    ) -> None:
        """清空分镜视频。ids=None 表示全项目。"""
        query = select(Shot).where(Shot.project_id == project_id)
        if shot_ids:
            query = query.where(Shot.id.in_(shot_ids))
        res = await self.session.execute(query)
        shots = res.scalars().all()
        delete_files([shot.video_url for shot in shots])
        for shot in shots:
            shot.video_url = None
            self.session.add(shot)

    async def _cleanup_for_rerun(
        self,
        project_id: int,
        start_agent: str,
        mode: str = "full",
        target_ids: TargetIds | None = None,
    ) -> None:
        """清理逻辑：根据重新运行的 agent 和模式清理数据。

        incremental + target_ids 时只清理目标实体的媒体，避免误伤其他格。
        """
        cleared_types: list[str] = []
        char_ids = target_ids.character_ids if target_ids and target_ids.character_ids else None
        shot_ids = target_ids.shot_ids if target_ids and target_ids.shot_ids else None
        scoped = bool(char_ids or shot_ids)

        if mode == "incremental":
            if start_agent in {"outline"}:
                await self._clear_character_images(project_id)
                await self._clear_shot_images(project_id)
                await self._clear_shot_videos(project_id)
                project = await self.session.get(Project, project_id)
                if project is not None:
                    project.outline_approved = False
                    self.session.add(project)
            elif start_agent in {"plan"}:
                # Scoped: only clear the selected entity media (never expand None → all).
                if scoped:
                    if char_ids:
                        await self._clear_character_images(project_id, char_ids)
                    if shot_ids:
                        await self._clear_shot_images(project_id, shot_ids)
                        await self._clear_shot_videos(project_id, shot_ids)
                else:
                    await self._clear_character_images(project_id)
                    await self._clear_shot_images(project_id)
                    await self._clear_shot_videos(project_id)
            elif start_agent == "render":
                if scoped:
                    if char_ids:
                        await self._clear_character_images(project_id, char_ids)
                    if shot_ids:
                        await self._clear_shot_images(project_id, shot_ids)
                        await self._clear_shot_videos(project_id, shot_ids)
                else:
                    await self._clear_character_images(project_id)
                    await self._clear_shot_images(project_id)
                    await self._clear_shot_videos(project_id)
            elif start_agent == "compose":
                if scoped:
                    if shot_ids:
                        await self._clear_shot_videos(project_id, shot_ids)
                else:
                    await self._clear_shot_videos(project_id)
            else:
                raise ValueError(f"Unsupported start_agent for cleanup: {start_agent}")
        else:
            if start_agent in {"outline"}:
                await self._delete_project_shots(project_id)
                await self._delete_project_characters(project_id)
                project = await self.session.get(Project, project_id)
                if project is not None:
                    project.story_outline = {}
                    project.visual_bible = None
                    project.outline_approved = False
                    self.session.add(project)
                cleared_types = ["characters", "shots", "outline"]
            elif start_agent in {"plan"}:
                await self._delete_project_shots(project_id)
                await self._delete_project_characters(project_id)
                cleared_types = ["characters", "shots"]
            elif start_agent == "render":
                await self._clear_character_images(project_id)
                await self._clear_shot_images(project_id)
                await self._clear_shot_videos(project_id)
            elif start_agent == "compose":
                await self._clear_shot_videos(project_id)
            else:
                raise ValueError(f"Unsupported start_agent for cleanup: {start_agent}")

        await self.session.commit()

        if cleared_types:
            await self.ws.send_event(
                project_id,
                {
                    "type": "data_cleared",
                    "data": {
                        "cleared_types": cleared_types,
                        "start_agent": start_agent,
                        "mode": mode,
                    },
                },
            )

    async def _set_run(self, run: AgentRun, **fields) -> AgentRun:
        for k, v in fields.items():
            setattr(run, k, v)
        run.updated_at = utcnow()
        if self.session:
            self.session.add(run)
            await self.session.commit()
            await self.session.refresh(run)
        return run

    async def _log(self, run_id: int, *, agent: str, role: str, content: str) -> None:
        msg = AgentMessage(run_id=run_id, agent=agent, role=role, content=content)
        self.session.add(msg)
        await self.session.commit()

    async def _handle_run_failure(
        self, project_id: int, run: AgentRun, run_id: int, error: Exception, context: str = "Run"
    ) -> None:
        await self.session.rollback()
        try:
            await self._log(
                run_id, agent="orchestrator", role="system", content=f"{context} failed: {error!r}"
            )
            await self._set_run(run, status="failed", error=str(error))

            # 项目级错误消息：页面加载查的是 Message 表而非 run 级 AgentMessage，
            # 落一条 role=error 让失败原因在刷新后依然可见（MessageList 已有渲染分支）
            self.session.add(
                Message(
                    project_id=project_id,
                    run_id=run_id,
                    agent="orchestrator",
                    role="error",
                    content=f"生成失败：{error}",
                )
            )
            await self.session.commit()

            project = await self.session.get(Project, project_id)
            if project is not None:
                project.status = "failed"
                self.session.add(project)
                await self.session.commit()
                blocking_clips = await collect_project_blocking_clips(self.session, project)
                await self.ws.send_event(
                    project_id,
                    {
                        "type": "project_updated",
                        "data": {
                            "project": {
                                "id": project_id,
                                "status": project.status,
                                "video_url": project.video_url,
                                "blocking_clips": blocking_clips,
                            }
                        },
                    },
                )
        except Exception:
            pass
        await self.ws.send_event(
            project_id,
            {
                "type": "run_failed",
                "data": {"run_id": run_id, "project_id": project_id, "error": str(error)},
            },
        )

    async def _complete_run(
        self,
        project_id: int,
        run: AgentRun,
        run_id: int,
        final_stage: str,
        video_generation_skipped: bool,
    ) -> None:
        completed_agent = getattr(run, "current_agent", None)
        await self._set_run(run, status="succeeded", current_agent=None, progress=1.0)
        completed_data: dict = {
            "run_id": run_id,
            "project_id": project_id,
            "current_stage": final_stage,
            "current_agent": completed_agent,
        }
        if video_generation_skipped:
            completed_data["message"] = "视频未配置，已完成文本和图片生成"
            completed_data["video_generation_pending"] = True
        await self.ws.send_event(project_id, {"type": "run_completed", "data": completed_data})

    async def _cleanup_run(self, run_id: int) -> None:
        await clear_confirm_signal(run_id)
        await clear_awaiting_payload(run_id)

    async def _wait_for_confirm(
        self, project_id: int, run: AgentRun, agent_name: str, agent_ctx: AgentContext | None = None
    ) -> str | None:
        current_stage = GRAPH_STAGE_FOR_AGENT.get(agent_name, "plan")
        next_stage = _next_phase2_stage(current_stage)
        recovery_summary = await build_recovery_summary(
            session=self.session,
            database_url=self.settings.database_url,
            run=run,
        )
        run_pk = run.id or 0

        if agent_ctx and agent_ctx.completion_info:
            completed = agent_ctx.completion_info.completed or f"「{agent_name}」已完成"
            details = agent_ctx.completion_info.details
            next_step = agent_ctx.completion_info.next or "继续下一步"
            question = agent_ctx.completion_info.question or "是否继续？"
        else:
            info = AGENT_COMPLETION_INFO.get(agent_name, {})
            completed = info.get("completed", f"「{agent_name}」已完成")
            details = info.get("details", "")
            next_step = info.get("next", "继续下一步")
            question = info.get("question", "是否继续？")

        # 构建详细消息
        message_parts = [completed]
        if details:
            message_parts.append(f"{details}")
        message_parts.append(next_step)
        message_parts.append(question)

        full_message = "\n".join(message_parts)

        # 清理上一轮遗留的 confirm（避免误触导致直接跳过等待）
        await clear_confirm_signal(run_pk)

        awaiting_payload = {
            "run_id": run_pk,
            "project_id": project_id,
            "agent": agent_name,
            "gate": agent_name,
            "current_stage": current_stage,
            "stage": current_stage,
            "next_stage": next_stage,
            "recovery_summary": recovery_summary.model_dump(mode="json"),
            "preserved_stages": recovery_summary.preserved_stages,
            "message": full_message,
            "completed": completed,
            "next_step": next_step,
            "question": question,
        }
        if agent_name == "outline" and agent_ctx is not None:
            outline = getattr(agent_ctx.project, "story_outline", None)
            if isinstance(outline, dict):
                awaiting_payload["story_outline"] = outline
                awaiting_payload["visual_bible"] = getattr(agent_ctx.project, "visual_bible", None)

        # 缓存 payload 以便 WS 重连补发（事件本身可能在客户端未连接时丢失）
        await store_awaiting_payload(run_pk, awaiting_payload)

        await self.ws.send_event(
            project_id,
            {
                "type": "run_awaiting_confirm",
                "data": awaiting_payload,
            },
        )

        try:
            ok = await wait_for_confirm_signal(run_pk, timeout=1800)
            if not ok:
                raise asyncio.TimeoutError()
        except asyncio.TimeoutError:
            await clear_awaiting_payload(run_pk)
            raise RuntimeError(f"等待确认超时（agent: {agent_name}）")

        await clear_awaiting_payload(run_pk)

        confirmed_recovery = await build_recovery_summary(
            session=self.session,
            database_url=self.settings.database_url,
            run=run,
        )

        post_approval_stage = _next_phase2_stage(next_stage)

        await self.ws.send_event(
            project_id,
            {
                "type": "run_confirmed",
                "data": {
                    "run_id": run_pk,
                    "project_id": project_id,
                    "agent": agent_name,
                    "gate": agent_name,
                    "current_stage": post_approval_stage,
                    "stage": post_approval_stage,
                    "next_stage": _next_phase2_stage(post_approval_stage)
                    if post_approval_stage
                    else None,
                    "recovery_summary": confirmed_recovery.model_dump(mode="json"),
                },
            },
        )

        # 刷新 session 以确保能读取到其他 session 提交的新数据
        await self.session.commit()  # 提交当前事务

        # 读取本次确认携带的最新用户反馈（若有）
        res = await self.session.execute(
            select(AgentMessage)
            .where(AgentMessage.run_id == run_pk)
            .where(AgentMessage.role == "user")
            .order_by(AgentMessage.created_at.desc())
            .limit(1)
        )
        msg = res.scalars().first()
        if msg and msg.id != self._last_user_feedback_id and msg.content.strip():
            self._last_user_feedback_id = msg.id
            return msg.content.strip()

        return None

    async def _send_auto_approval_events(
        self, project_id: int, run: AgentRun, agent_name: str, agent_ctx: AgentContext | None = None
    ) -> None:
        current_stage = GRAPH_STAGE_FOR_AGENT.get(agent_name, "plan")
        approval_stage = _next_phase2_stage(current_stage)
        post_approval_stage = _next_phase2_stage(approval_stage) if approval_stage else None
        recovery_summary = await build_recovery_summary(
            session=self.session,
            database_url=self.settings.database_url,
            run=run,
        )
        run_pk = run.id or 0

        if agent_ctx and agent_ctx.completion_info:
            completed = agent_ctx.completion_info.completed or f"「{agent_name}」已完成"
            next_step = agent_ctx.completion_info.next or "继续下一步"
            question = agent_ctx.completion_info.question or "是否继续？"
        else:
            info = AGENT_COMPLETION_INFO.get(agent_name, {})
            completed = info.get("completed", f"「{agent_name}」已完成")
            next_step = info.get("next", "继续下一步")
            question = info.get("question", "是否继续？")

        message_parts = [completed, next_step, question, "[auto]"]
        full_message = "\n".join(message_parts)

        await self.ws.send_event(
            project_id,
            {
                "type": "run_awaiting_confirm",
                "data": {
                    "run_id": run_pk,
                    "project_id": project_id,
                    "agent": agent_name,
                    "gate": agent_name,
                    "current_stage": current_stage,
                    "stage": current_stage,
                    "next_stage": approval_stage,
                    "recovery_summary": recovery_summary.model_dump(mode="json"),
                    "preserved_stages": recovery_summary.preserved_stages,
                    "message": full_message,
                    "completed": completed,
                    "next_step": next_step,
                    "question": question,
                    "auto_mode": True,
                    "story_outline": getattr(agent_ctx.project, "story_outline", None)
                    if agent_name == "outline" and agent_ctx is not None
                    else None,
                    "visual_bible": getattr(agent_ctx.project, "visual_bible", None)
                    if agent_name == "outline" and agent_ctx is not None
                    else None,
                },
            },
        )

        confirmed_recovery = await build_recovery_summary(
            session=self.session,
            database_url=self.settings.database_url,
            run=run,
        )

        await self.ws.send_event(
            project_id,
            {
                "type": "run_confirmed",
                "data": {
                    "run_id": run_pk,
                    "project_id": project_id,
                    "agent": agent_name,
                    "gate": agent_name,
                    "current_stage": post_approval_stage,
                    "stage": post_approval_stage,
                    "next_stage": _next_phase2_stage(post_approval_stage)
                    if post_approval_stage
                    else None,
                    "recovery_summary": confirmed_recovery.model_dump(mode="json"),
                    "auto_mode": True,
                },
            },
        )

    def _build_agent_context(
        self,
        *,
        project: Project,
        run: AgentRun,
        request: GenerateRequest,
    ) -> AgentContext:
        context_settings = settings_with_provider_snapshot(
            self.settings,
            run.provider_snapshot,
        )
        from app.skills.context import resolve_project_skill_id

        skill_id = resolve_project_skill_id(
            request_skill_id=getattr(request, "skill_id", None),
            project_skill_id=getattr(project, "skill_id", None),
        )
        return AgentContext(
            settings=context_settings,
            session=self.session,
            ws=self.ws,
            project=project,
            run=run,
            llm=cast(Any, create_text_service(context_settings)),
            image=create_image_service(context_settings),
            video=cast(Any, create_video_service(context_settings)),
            skill_id=skill_id,
        )

    def _build_phase2_state(
        self,
        *,
        project_id: int,
        run_id: int,
        thread_id: str,
        start_stage: str,
        skill_id: str | None = None,
        focus_entity_type: str | None = None,
        focus_entity_id: int | None = None,
        route_mode: str = "full",
    ) -> dict[str, Any]:
        state: dict[str, Any] = {
            "project_id": project_id,
            "run_id": run_id,
            "thread_id": thread_id,
            "current_stage": start_stage,
            "stage_history": [],
            "approval_history": [],
            "artifact_lineage": [],
            "review_requested": False,
            "approval_feedback": "",
            "route_stage": start_stage,
            "route_mode": route_mode,
            "video_generation_skipped": False,
        }
        if skill_id:
            state["skill_id"] = skill_id
        if focus_entity_type:
            state["focus_entity_type"] = focus_entity_type
        if focus_entity_id is not None:
            state["focus_entity_id"] = focus_entity_id
        return state

    async def _invoke_phase2_graph(
        self,
        *,
        project: Project,
        run: AgentRun,
        ctx: AgentContext,
        compiled_graph: Any,
        graph_config: dict[str, dict[str, str]],
        runtime_context: Any,
        initial_payload: Any,
        auto_mode: bool,
    ) -> tuple[bool, str]:
        if project.id is None or run.id is None:
            raise RuntimeError("Project and run must be persisted before graph execution")
        project_pk = int(project.id)
        run_pk = int(run.id)

        async def _on_interrupt(interrupt_item: Any) -> dict[str, Any]:
            gate_agent = gate_name_from_interrupt(interrupt_item)
            logger.debug(
                "[graph] run=%s interrupt gate=%s auto_mode=%s", run_pk, gate_agent, auto_mode
            )
            feedback = ""
            action = "approve"
            if not auto_mode:
                feedback = (
                    await self._wait_for_confirm(project_pk, run, gate_agent, agent_ctx=ctx) or ""
                )
            else:
                await self._send_auto_approval_events(
                    project_pk, run, gate_agent, agent_ctx=ctx
                )
            if feedback:
                action = "feedback"
            logger.debug(
                "[graph] run=%s resume with feedback=%r action=%s", run_pk, feedback, action
            )
            return {"action": action, "feedback": feedback}

        graph_result = await drive_graph_until_idle(
            compiled_graph,
            initial_payload=initial_payload,
            graph_config=graph_config,
            runtime_context=runtime_context,
            on_interrupt=_on_interrupt,
            run_id=run_pk,
        )
        video_generation_skipped = graph_result.video_generation_skipped
        final_stage = graph_result.final_stage
        saw_compose_stage = graph_result.saw_compose_stage

        # Preserve legacy detection if state flags differ
        if _video_generation_skipped_in_result(graph_result.state):
            video_generation_skipped = True

        await self.session.refresh(ctx.project)

        if saw_compose_stage and not video_generation_skipped and final_stage.startswith("compose"):
            blocking_clips = await collect_project_blocking_clips(self.session, ctx.project)
            project_video_url = getattr(ctx.project, "video_url", None)
            if not project_video_url or blocking_clips:
                reasons: list[str] = []
                if not project_video_url:
                    reasons.append("final project video_url is empty")
                if blocking_clips:
                    reasons.append(f"{len(blocking_clips)} blocking clips remain")
                raise RuntimeError(
                    "Compose finished without a usable final video: " + "; ".join(reasons)
                )

        ctx.project.status = "ready"
        self.session.add(ctx.project)
        await self.session.commit()

        return video_generation_skipped, final_stage

    async def _run_phase2_graph(
        self,
        *,
        project: Project,
        run: AgentRun,
        request: GenerateRequest,
        ctx: AgentContext,
        agent_name: str,
        auto_mode: bool,
    ) -> tuple[bool, str]:
        if agent_name not in GRAPH_STAGE_FOR_AGENT:
            raise ValueError(f"Unsupported agent for graph execution: {agent_name}")
        if agent_name == "outline" and not self.settings.outline_enabled:
            agent_name = "plan"

        if agent_name == "review":
            latest_feedback = (ctx.user_feedback or request.notes or "").strip()
            if latest_feedback:
                ctx.user_feedback = latest_feedback

        start_stage = cast(Phase2Stage, GRAPH_STAGE_FOR_AGENT[agent_name])
        if agent_name == "outline" and (not self.settings.outline_enabled or project.outline_approved):
            start_stage = "plan_characters"
            agent_name = "plan"

        from app.skills.context import resolve_project_skill_id

        effective_skill_id = resolve_project_skill_id(
            request_skill_id=getattr(request, "skill_id", None),
            project_skill_id=getattr(project, "skill_id", None),
        )
        # Skill entry may override start stage when launching a full generate.
        skill_resolution = resolve_skill_entry(
            effective_skill_id,
            auto_mode=auto_mode,
            outline_enabled=self.settings.outline_enabled,
        )
        ctx.skill_id = effective_skill_id
        if effective_skill_id and agent_name in ("outline", "plan") and not ctx.user_feedback:
            start_stage = skill_resolution.start_stage
            agent_name = skill_resolution.start_agent
            auto_mode = skill_resolution.auto_mode
            if skill_resolution.notes_suffix:
                notes = (request.notes or "").strip()
                request.notes = f"{notes}\n{skill_resolution.notes_suffix}".strip()
            # Apply default shot count when project has none
            if (
                skill_resolution.default_target_shot_count is not None
                and getattr(project, "target_shot_count", None) is None
            ):
                project.target_shot_count = skill_resolution.default_target_shot_count
                self.session.add(project)
                await self.session.commit()

        if project.id is None or run.id is None:
            raise RuntimeError("Project and run must be persisted before graph execution")
        graph_config = cast(Any, build_graph_config(run))
        thread_id = graph_config["configurable"]["thread_id"]
        if not run.thread_id:
            await self._set_run(run, thread_id=thread_id)
        runtime_context = build_phase2_runtime_context(
            orchestrator=self,
            agent_context=ctx,
            start_stage=start_stage,
            auto_mode=auto_mode,
            skill_id=effective_skill_id,
        )
        route_mode = getattr(ctx, "rerun_mode", None) or "full"
        initial_state = self._build_phase2_state(
            project_id=int(project.id),
            run_id=int(run.id),
            thread_id=graph_config["configurable"]["thread_id"],
            start_stage=start_stage,
            skill_id=effective_skill_id,
            focus_entity_type=getattr(ctx, "entity_type", None)
            or getattr(request, "entity_type", None),
            focus_entity_id=(
                getattr(ctx, "entity_id", None)
                if getattr(ctx, "entity_id", None) is not None
                else getattr(request, "entity_id", None)
            ),
            route_mode=route_mode,
        )

        async with build_postgres_checkpointer(self.settings.database_url) as checkpointer:
            compiled_graph = build_phase2_graph().compile(checkpointer=cast(Any, checkpointer))
            return await self._invoke_phase2_graph(
                project=project,
                run=run,
                ctx=ctx,
                compiled_graph=compiled_graph,
                graph_config=graph_config,
                runtime_context=runtime_context,
                initial_payload=initial_state,
                auto_mode=auto_mode,
            )

    async def resume_from_recovery(
        self,
        *,
        project_id: int,
        run_id: int,
        auto_mode: bool = False,
    ) -> None:
        project = await self.session.get(Project, project_id)
        run = await self.session.get(AgentRun, run_id)
        if not project or not run:
            return

        recovery = await build_recovery_summary(
            session=self.session,
            database_url=self.settings.database_url,
            run=run,
        )
        resume_stage = cast(Phase2Stage, recovery.next_stage or recovery.current_stage)
        resume_agent = _resume_agent_for_stage(resume_stage)

        graph_config = cast(Any, build_graph_config(run))
        thread_id = graph_config["configurable"]["thread_id"]
        if not run.thread_id:
            await self._set_run(run, thread_id=thread_id)

        try:
            self._agent_index(resume_agent)
            await self._set_run(
                run,
                status="running",
                current_agent=_resume_agent_for_stage(resume_stage),
                progress=workflow_progress_for_stage(resume_stage),
                error=None,
            )

            resume_skill_id = getattr(project, "skill_id", None)
            ctx = self._build_agent_context(
                project=project,
                run=run,
                request=GenerateRequest(skill_id=resume_skill_id),
            )
            ctx.user_feedback = None
            ctx.skill_id = resume_skill_id

            await self.ws.send_event(
                project_id,
                {
                    "type": "run_started",
                    "data": {
                        "run_id": run_id,
                        "project_id": project_id,
                        "provider_snapshot": run.provider_snapshot,
                        "current_stage": resume_stage,
                        "stage": resume_stage,
                        "next_stage": recovery.next_stage,
                        "progress": workflow_progress_for_stage(resume_stage),
                        "current_agent": _resume_agent_for_stage(resume_stage),
                        "recovery_summary": recovery.model_dump(mode="json"),
                    },
                },
            )
            await self._log(
                run_id,
                agent="orchestrator",
                role="system",
                content=(
                    f"Resuming from checkpoint at {resume_stage}"
                    f" skill={resume_skill_id!r}: {recovery!r}"
                ),
            )

            async with build_postgres_checkpointer(self.settings.database_url) as checkpointer:
                compiled_graph = build_phase2_graph().compile(checkpointer=cast(Any, checkpointer))
                resume_config = cast(
                    Any,
                    await build_stage_recovery_config(
                        compiled_graph,
                        run,
                        before_stage=recovery.next_stage or recovery.current_stage,
                    ),
                )
                runtime_context = build_phase2_runtime_context(
                    orchestrator=self,
                    agent_context=ctx,
                    start_stage=resume_stage,
                    auto_mode=auto_mode,
                    skill_id=resume_skill_id,
                )
                video_generation_skipped, final_stage = await self._invoke_phase2_graph(
                    project=project,
                    run=run,
                    ctx=ctx,
                    compiled_graph=compiled_graph,
                    graph_config=resume_config,
                    runtime_context=runtime_context,
                    initial_payload=None,
                    auto_mode=auto_mode,
                )

            await self._complete_run(project_id, run, run_id, final_stage, video_generation_skipped)
        except Exception as e:
            await self._handle_run_failure(project_id, run, run_id, e, context="Resume")
        finally:
            await self._cleanup_run(run_id)

    async def run_from_agent(
        self,
        *,
        project_id: int,
        run_id: int,
        request: GenerateRequest,
        agent_name: str,
        auto_mode: bool = False,
        feedback_type: str | None = None,
        entity_type: str | None = None,
        entity_id: int | None = None,
        entity_ids: list[int] | None = None,
    ) -> None:
        project = await self.session.get(Project, project_id)
        run = await self.session.get(AgentRun, run_id)
        if not project or not run:
            return

        try:
            if agent_name == "outline" and not self.settings.outline_enabled:
                agent_name = "plan"
            self._agent_index(agent_name)

            initial_stage = GRAPH_STAGE_FOR_AGENT[agent_name]
            if agent_name == "outline" and project.outline_approved:
                agent_name = "plan"
                initial_stage = GRAPH_STAGE_FOR_AGENT[agent_name]

            await self._set_run(
                run,
                status="running",
                current_agent=agent_name,
                progress=workflow_progress_for_stage(initial_stage),
                error=None,
            )
            await self.ws.send_event(
                project_id,
                {
                    "type": "run_started",
                    "data": {
                        "run_id": run_id,
                        "project_id": project_id,
                        "provider_snapshot": run.provider_snapshot,
                        "current_stage": initial_stage,
                        "stage": initial_stage,
                        "next_stage": next_production_stage(initial_stage),
                        "progress": workflow_progress_for_stage(initial_stage),
                        "current_agent": agent_name,
                    },
                },
            )
            await self._log(
                run_id,
                agent="orchestrator",
                role="system",
                content=f"Generate started from {agent_name}: {request!r}",
            )

            ctx = self._build_agent_context(project=project, run=run, request=request)
            # Propagate selection focus for partial re-runs (canvas → Agent).
            if entity_type and not getattr(ctx, "entity_type", None):
                ctx.entity_type = entity_type
            if entity_id is not None and getattr(ctx, "entity_id", None) is None:
                ctx.entity_id = entity_id
            if entity_ids:
                ctx.entity_ids = list(dict.fromkeys(entity_ids))
                if getattr(ctx, "entity_id", None) is None and ctx.entity_ids:
                    ctx.entity_id = ctx.entity_ids[0]
            req_entity_type = getattr(request, "entity_type", None)
            req_entity_id = getattr(request, "entity_id", None)
            if req_entity_type and not getattr(ctx, "entity_type", None):
                ctx.entity_type = req_entity_type
            if req_entity_id is not None and getattr(ctx, "entity_id", None) is None:
                ctx.entity_id = req_entity_id

            # 初始化当前 run 已存在的用户反馈消息（避免后续确认不带反馈时误读历史反馈）
            stmt = (
                select(AgentMessage.id)
                .where(AgentMessage.run_id == run.id)
                .where(AgentMessage.role == "user")
                .order_by(AgentMessage.created_at.desc())
                .limit(1)
            )
            res = await ctx.session.execute(stmt)
            self._last_user_feedback_id = res.scalar_one_or_none()

            if agent_name == "review":
                # 让后续 agent 能直接读取用户反馈（例如编剧需要遵循数量限制等）
                stmt = (
                    select(AgentMessage)
                    .where(AgentMessage.run_id == run.id)
                    .where(AgentMessage.role == "user")
                .order_by(AgentMessage.created_at.desc())
                    .limit(1)
                )
                res = await ctx.session.execute(stmt)
                msg = res.scalars().first()
                if msg and msg.content.strip():
                    ctx.user_feedback = msg.content.strip()
                elif request.notes and request.notes.strip():
                    ctx.user_feedback = request.notes.strip()

                ctx.feedback_type = feedback_type
                ctx.entity_type = entity_type
                ctx.entity_id = entity_id
                if entity_ids:
                    ctx.entity_ids = list(dict.fromkeys(entity_ids))
                    if ctx.entity_id is None and ctx.entity_ids:
                        ctx.entity_id = ctx.entity_ids[0]

                review_agent = cast(ReviewAgent, self.agents[self._agent_index("review")])

                await self._set_run(run, current_agent=review_agent.name, progress=0.0)
                await self.ws.send_event(
                    project_id,
                    {
                        "type": "run_progress",
                        "data": {
                            "run_id": run_id,
                            "current_agent": review_agent.name,
                            "current_stage": GRAPH_STAGE_FOR_AGENT.get(review_agent.name, "review"),
                            "stage": GRAPH_STAGE_FOR_AGENT.get(review_agent.name, "review"),
                            "next_stage": _next_phase2_stage(
                                GRAPH_STAGE_FOR_AGENT.get(review_agent.name, "review")
                            ),
                            "progress": 0.0,
                        },
                    },
                )

                routing = await review_agent.run(ctx)
                start_agent = routing.get("start_agent") if isinstance(routing, dict) else None
                # 直接从 routing 读取 mode（review.py 已经解析好了）
                mode = "full"
                if isinstance(routing, dict):
                    m = routing.get("mode")
                    if isinstance(m, str) and m.strip() in ("incremental", "full"):
                        mode = m.strip()
                    # Apply per-entity target_ids from review routing (canvas selection)
                    targets = routing.get("target_ids")
                    if targets is not None:
                        ctx.target_ids = targets
                if not (isinstance(start_agent, str) and start_agent.strip()):
                    start_agent = "plan"
                agent_name = start_agent.strip()
                if agent_name == "outline" and not self.settings.outline_enabled:
                    agent_name = "plan"
                self._agent_index(agent_name)  # validate
                ctx.rerun_mode = mode
                await self._log(
                    run_id,
                    agent="orchestrator",
                    role="system",
                    content=f"Review routed to {agent_name} (mode={mode}): {routing!r}",
                )

            await self._cleanup_for_rerun(
                project_id,
                agent_name,
                mode=getattr(ctx, "rerun_mode", "full"),
                target_ids=getattr(ctx, "target_ids", None),
            )

            # 刷新 project 对象，因为 cleanup 可能修改了它
            await self.session.refresh(ctx.project)

            video_generation_skipped, final_stage = await self._run_phase2_graph(
                project=project,
                run=run,
                request=request,
                ctx=ctx,
                agent_name=agent_name,
                auto_mode=auto_mode,
            )

            await self._complete_run(project_id, run, run_id, final_stage, video_generation_skipped)
        except Exception as e:
            await self._handle_run_failure(project_id, run, run_id, e, context="Run")
        finally:
            await self._cleanup_run(run_id)

    async def run(
        self, *, project_id: int, run_id: int, request: GenerateRequest, auto_mode: bool = False
    ) -> None:
        from app.skills.context import resolve_project_skill_id

        project = await self.session.get(Project, project_id)
        effective_skill_id = resolve_project_skill_id(
            request_skill_id=request.skill_id,
            project_skill_id=getattr(project, "skill_id", None) if project else None,
        )
        if project is not None and effective_skill_id and not getattr(project, "skill_id", None):
            project.skill_id = effective_skill_id
            self.session.add(project)
            await self.session.commit()
        # Keep request skill aligned so graph/state resolve consistently
        if effective_skill_id and not request.skill_id:
            request.skill_id = effective_skill_id

        skill = resolve_skill_entry(
            effective_skill_id,
            auto_mode=auto_mode or request.auto_mode,
            outline_enabled=self.settings.outline_enabled,
        )
        await self.run_from_agent(
            project_id=project_id,
            run_id=run_id,
            request=request,
            agent_name=skill.start_agent,
            auto_mode=skill.auto_mode,
            entity_type=request.entity_type,
            entity_id=request.entity_id,
            entity_ids=getattr(request, "entity_ids", None),
        )
