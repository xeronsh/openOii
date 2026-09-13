from __future__ import annotations

import logging
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import InstrumentedAttribute

from app.agents.base import AgentContext, BaseAgent, CompletionInfo
from app.agents.utils import build_character_context
from app.models.project import Character, Shot
from app.orchestration import workflow_progress_for_stage
from app.services.audio_service import AudioService
from app.services.character_bible import build_character_bible
from app.services.creative_control import collect_project_blocking_clips
from app.services.doubao_video import DoubaoVideoService
from app.services.image_composer import ImageComposer
from app.services.shot_binding import resolve_shot_bound_approved_characters
from app.services.style_prompts import (
    VIDEO_CONTINUITY_LOCK,
    resolve_style_prompt,
)

logger = logging.getLogger(__name__)


class ComposeAgent(BaseAgent):
    name = "compose"

    def __init__(self):
        super().__init__()
        self.image_composer = ImageComposer()

    async def _build_video_prompt(
        self,
        shot: Shot,
        characters: list[Character],
        *,
        style: str,
        session,
        user_feedback: str | None = None,
    ) -> str:
        desc = shot.prompt or shot.description
        parts = [desc.strip()]
        for char in characters:
            bible_text = build_character_bible(char)
            if bible_text:
                parts.append(f"Character {char.name}: {bible_text}")
        char_context = build_character_context(characters)
        if char_context:
            parts.append(char_context)
        resolved_style = await resolve_style_prompt(session, style)
        if characters:
            parts.append(f"Continuity lock: {VIDEO_CONTINUITY_LOCK}")
        parts.append(f"Visual style lock: {resolved_style.style_prompt}")
        parts.append(f"Avoid: {resolved_style.negative_prompt}")
        if user_feedback and user_feedback.strip():
            # Strip focus prefix noise for the video model
            fb = user_feedback.strip()
            if fb.startswith("[focus:"):
                closing = fb.find("] ")
                if closing != -1:
                    fb = fb[closing + 2 :].strip()
            if fb:
                parts.append(f"用户反馈：{fb}")
        return ", ".join(parts)

    def _build_i2v_prompt(self, prompt: str, *, image_mode: str) -> str:
        guidance = (
            "Use the provided image as the first-frame visual anchor. Preserve the same "
            "visible characters, outfits, hair colors, scene layout, framing, and camera "
            "distance. Keep the same 2D comic/anime rendering style. Do not convert the image "
            "to live-action, photorealistic, hyperrealistic, or 3D realistic footage. Do not "
            "replace a clear character shot with a wide establishing shot. Do not redesign "
            "characters or change their face, hair, outfit, accessories, or color palette."
        )
        if image_mode == "nine_grid":
            guidance += (
                " The reference is a 3x3 storyboard board: top-middle and bottom-right are the "
                "current shot first frame; top-left/top-right are previous/next continuity frames; "
                "middle and bottom rows are character identity panels. Animate ONLY from the "
                "current shot first frame. Use neighbor frames for motion continuity and character "
                "panels only to lock identity. Do not pan across the whole grid or invent a "
                "montage of all nine cells."
            )
        elif image_mode == "reference":
            guidance += (
                " If the reference image contains a scene frame plus character panels, animate "
                "the scene frame and use the character panels only to preserve identity."
            )
        return f"{guidance} {prompt}"

    async def _neighbor_shot_images(
        self,
        ctx: AgentContext,
        shot: Shot,
    ) -> tuple[str | None, str | None]:
        """Return previous/next shot image URLs by storyboard order."""
        res = await ctx.session.execute(
            select(Shot)
            .where(Shot.project_id == ctx.project.id)
            .order_by(Shot.order.asc(), Shot.id.asc())
        )
        ordered = list(res.scalars().all())
        idx = next((i for i, item in enumerate(ordered) if item.id == shot.id), None)
        if idx is None:
            return None, None
        prev_url = ordered[idx - 1].image_url if idx > 0 else None
        next_url = ordered[idx + 1].image_url if idx + 1 < len(ordered) else None
        return prev_url, next_url

    async def _compose_i2v_reference(
        self,
        ctx: AgentContext,
        shot: Shot,
        characters: list[Character],
        *,
        as_url: bool,
    ) -> tuple[str | None, bytes | None, str]:
        """Build I2V reference image.

        Prefers 3×3 nine-grid board for continuity + identity. Falls back to
        legacy first_frame / reference strip when nine-grid fails.
        """
        if not shot.image_url:
            return None, None, "none"

        char_image_urls = [c.image_url for c in characters if c.image_url]
        prev_url, next_url = await self._neighbor_shot_images(ctx, shot)
        try:
            if as_url:
                url = await self.image_composer.compose_and_save_nine_grid_reference_image(
                    current_image_url=shot.image_url,
                    previous_image_url=prev_url,
                    next_image_url=next_url,
                    character_image_urls=char_image_urls,
                )
                return url, None, "nine_grid"
            data = await self.image_composer.compose_nine_grid_reference_image(
                current_image_url=shot.image_url,
                previous_image_url=prev_url,
                next_image_url=next_url,
                character_image_urls=char_image_urls,
            )
            return None, data, "nine_grid"
        except Exception as exc:
            logger.warning("Nine-grid I2V reference failed for shot %s: %s", shot.id, exc)

        image_mode = (ctx.settings.video_image_mode or "first_frame").strip().lower()
        try:
            if as_url:
                if image_mode == "reference":
                    url = await self.image_composer.compose_and_save_reference_image(
                        shot_image_url=shot.image_url,
                        character_image_urls=char_image_urls,
                    )
                    return url, None, "reference"
                return shot.image_url, None, "first_frame"
            if image_mode == "reference":
                data = await self.image_composer.compose_reference_image(
                    shot_image_url=shot.image_url,
                    character_image_urls=char_image_urls,
                )
            else:
                data = await self.image_composer.compose_reference_image(
                    shot_image_url=shot.image_url,
                    character_image_urls=[],
                )
            return None, data, image_mode if image_mode in {"reference", "first_frame"} else "first_frame"
        except Exception as exc:
            logger.warning("Legacy I2V reference failed for shot %s: %s", shot.id, exc)
            return (shot.image_url if as_url else None), None, "first_frame"

    def _get_duration(self, shot: Shot, default_duration: float) -> float:
        if shot.duration and shot.duration > 0:
            return shot.duration
        return default_duration

    async def _generate_videos(self, ctx: AgentContext) -> int:
        query = select(Shot).where(
            Shot.project_id == ctx.project.id,
            Shot.video_url.is_(None),
        )
        if ctx.target_ids and ctx.target_ids.shot_ids:
            query = query.where(Shot.id.in_(ctx.target_ids.shot_ids))
        res = await ctx.session.execute(query)
        shots = res.scalars().all()

        if not shots:
            await self.send_message(ctx, "所有分镜已有视频。")
            return 0

        use_image_mode = ctx.settings.use_i2v()
        is_doubao = isinstance(ctx.video, DoubaoVideoService)
        default_duration = float(ctx.settings.doubao_video_duration) if is_doubao else 5.0
        image_mode = (ctx.settings.video_image_mode or "first_frame").strip().lower()

        total = len(shots)
        updated_count = 0
        mode_desc = "图生视频" if use_image_mode else "文生视频"

        # Thinking: planning phase — starting video generation
        await self.send_thinking(
            ctx,
            phase="planning",
            content=f"准备为 {total} 个分镜生成视频，模式：{mode_desc}",
            details=f"视频服务商：{'豆包' if is_doubao else 'OpenAI 兼容'}",
        )

        await self.send_message(
            ctx, f"开始为 {total} 个分镜生成视频（{mode_desc}）...", progress=0.0, is_loading=True
        )

        for i, shot in enumerate(shots):
            try:
                shot_progress = i / max(total, 1)
                await self.send_progress_batch(
                    ctx, total=total, current=i, message=f"   正在生成视频 {i + 1}/{total}..."
                )
                await ctx.ws.send_event(
                    ctx.project.id,
                    {
                        "type": "run_progress",
                        "data": {
                            "run_id": ctx.run.id,
                            "current_agent": "compose",
                            "current_stage": "compose",
                            "stage": "compose",
                            "next_stage": None,
                            "progress": workflow_progress_for_stage(
                                "compose", within_stage=shot_progress
                            ),
                        },
                    },
                )
                characters = await resolve_shot_bound_approved_characters(ctx.session, shot)
                entity_fb = (
                    ctx.user_feedback
                    if ctx.user_feedback
                    and (
                        ctx.entity_type in {"shot", "video"}
                        and (ctx.entity_id is None or ctx.entity_id == shot.id)
                    )
                    else None
                )
                video_prompt = await self._build_video_prompt(
                    shot,
                    characters,
                    style=ctx.project.style,
                    session=ctx.session,
                    user_feedback=entity_fb,
                )
                i2v_mode = image_mode
                duration = self._get_duration(shot, default_duration)

                if is_doubao:
                    image_url: str | None = None
                    if use_image_mode and shot.image_url:
                        image_url, _, i2v_mode = await self._compose_i2v_reference(
                            ctx, shot, characters, as_url=True
                        )
                        video_prompt = self._build_i2v_prompt(
                            video_prompt, image_mode=i2v_mode
                        )

                    await self.send_thinking(
                        ctx,
                        phase="reasoning",
                        content=(
                            f"分镜 #{shot.order} 视频提示词：{video_prompt[:80]}..."
                            f"（I2V参考={i2v_mode if use_image_mode else 'off'}）"
                        ),
                    )

                    video_url = await ctx.video.generate_url(
                        prompt=video_prompt,
                        image_url=image_url,
                        duration=int(duration) if duration in (5, 10) else 5,
                        ratio=ctx.settings.doubao_video_ratio,
                        generate_audio=ctx.settings.doubao_generate_audio,
                    )
                else:
                    reference_image_bytes: bytes | None = None
                    if use_image_mode and shot.image_url:
                        _, reference_image_bytes, i2v_mode = await self._compose_i2v_reference(
                            ctx, shot, characters, as_url=False
                        )
                        video_prompt = self._build_i2v_prompt(
                            video_prompt, image_mode=i2v_mode
                        )

                    await self.send_thinking(
                        ctx,
                        phase="reasoning",
                        content=(
                            f"分镜 #{shot.order} 视频提示词：{video_prompt[:80]}..."
                            f"（I2V参考={i2v_mode if use_image_mode else 'off'}）"
                        ),
                    )

                    video_url = await ctx.video.generate_url(
                        prompt=video_prompt,
                        image_bytes=reference_image_bytes,
                        duration=duration,
                    )

                shot.video_url = video_url
                shot.duration = duration
                ctx.session.add(shot)
                await ctx.session.flush()
                await self.send_shot_event(ctx, shot, "shot_updated")
                updated_count += 1
            except Exception as e:
                await self.send_message(ctx, f"镜头 {shot.order} 视频生成失败: {e}")

        await ctx.session.commit()
        return updated_count

    async def _merge_videos(self, ctx: AgentContext) -> None:
        project_id = ctx.project.id
        if project_id is None:
            raise RuntimeError("Project must be persisted before final assembly")

        if (
            ctx.project.video_url
            and ctx.project.status != "superseded"
            and ctx.rerun_mode == "full"
        ):
            await self.send_message(ctx, "项目已有最终视频。")
            return

        blocking_clips = await collect_project_blocking_clips(ctx.session, ctx.project)
        if blocking_clips:
            if ctx.project.video_url:
                ctx.project.status = "superseded"
            ctx.session.add(ctx.project)
            await ctx.session.commit()
            await ctx.session.refresh(ctx.project)
            await self.send_message(
                ctx, "当前仍有分镜视频未满足拼接条件，请先完成这些分镜。", progress=1.0
            )
            await ctx.ws.send_event(
                project_id,
                {
                    "type": "project_updated",
                    "data": {
                        "project": {
                            "id": ctx.project.id,
                            "video_url": ctx.project.video_url,
                            "status": ctx.project.status,
                            "blocking_clips": blocking_clips,
                        }
                    },
                },
            )
            return

        shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
        shot_video_url_col = cast(InstrumentedAttribute[str | None], cast(object, Shot.video_url))
        shot_order_col = cast(InstrumentedAttribute[int], cast(object, Shot.order))
        res = await ctx.session.execute(
            select(Shot)
            .where(shot_project_id_col == project_id, shot_video_url_col.is_not(None))
            .order_by(shot_order_col.asc())
        )
        shots = res.scalars().all()

        if not shots:
            await self.send_message(ctx, "没有可拼接的分镜视频。")
            return

        video_urls = [shot.video_url for shot in shots if shot.video_url]
        if not video_urls:
            await self.send_message(ctx, "没有有效的视频 URL 可拼接。")
            return

        try:
            await self.send_message(
                ctx, f"开始拼接 {len(video_urls)} 个分镜视频...", progress=0.0, is_loading=True
            )
            merged_url = await ctx.video.merge_urls(video_urls)

            ctx.project.video_url = merged_url
            ctx.project.status = "ready"
            ctx.session.add(ctx.project)
            await ctx.session.commit()
            await ctx.session.refresh(ctx.project)

            await ctx.ws.send_event(
                project_id,
                {
                    "type": "project_updated",
                    "data": {
                        "project": {
                            "id": ctx.project.id,
                            "video_url": merged_url,
                            "status": ctx.project.status,
                            "blocking_clips": [],
                        }
                    },
                },
            )

            summary = f"将{len(video_urls)}个分镜拼接为完整视频"
            first_shot = shots[0] if shots else None
            shot_hint = (
                f"「{first_shot.description[:15]}…」"
                if first_shot and first_shot.description
                else ""
            )
            ctx.completion_info = CompletionInfo(
                completed=f"已将 {len(video_urls)} 个分镜拼接为完整视频",
                next="您的漫剧已经准备就绪！可以下载或分享了。",
                question="最终视频效果满意吗？",
            )
            await self.send_message(
                ctx,
                f"漫剧制作完成！{shot_hint}等 {len(video_urls)} 个分镜已拼接为完整视频。",
                summary=summary,
                progress=1.0,
            )
        except Exception as e:
            await self.send_message(ctx, f"视频拼接失败: {e}。您可以稍后手动拼接。", progress=1.0)

    async def _add_audio_to_videos(self, ctx: AgentContext) -> None:
        """为分镜视频添加 TTS 配音 + BGM 背景音乐

        容错设计：
        - TTS 失败时跳过，仅加 BGM
        - BGM 失败时跳过
        - 整个阶段失败不阻塞主流程
        """
        settings = ctx.settings
        tts_enabled = settings.tts_enabled
        bgm_enabled = settings.bgm_enabled

        if not tts_enabled and not bgm_enabled:
            await self.send_message(ctx, "TTS 和 BGM 均未启用，跳过音频阶段。")
            return

        audio_service = AudioService(settings)

        # 获取所有有视频的分镜
        shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
        shot_video_url_col = cast(InstrumentedAttribute[str | None], cast(object, Shot.video_url))
        shot_order_col = cast(InstrumentedAttribute[int], cast(object, Shot.order))
        res = await ctx.session.execute(
            select(Shot)
            .where(shot_project_id_col == ctx.project.id, shot_video_url_col.is_not(None))
            .order_by(shot_order_col.asc())
        )
        shots = list(res.scalars().all())

        # 获取项目角色列表（用于 TTS 语音选择）
        characters = await self.get_project_characters(ctx)

        total = len(shots)
        audio_count = 0

        await self.send_message(
            ctx,
            f"开始添加音频：TTS={'开启' if tts_enabled else '关闭'}，BGM={'开启' if bgm_enabled else '关闭'}...",
            progress=0.0,
            is_loading=True,
        )

        for i, shot in enumerate(shots):
            try:
                await self.send_progress_batch(
                    ctx,
                    total=total,
                    current=i,
                    message=f"   正在处理音频 {i + 1}/{total}...",
                )

                tts_url: str | None = None
                bgm_type: str | None = None
                bgm_path: str | None = None

                # 1. 生成 TTS（如果有对白）
                if tts_enabled and shot.dialogue:
                    # 从 character_ids 找角色名
                    character_name = ""
                    if shot.character_ids:
                        for char in characters:
                            if char.id in shot.character_ids:
                                character_name = char.name
                                break

                    tts_url = await audio_service.generate_character_tts(
                        dialogue=shot.dialogue,
                        character_name=character_name,
                        characters=characters,
                    )
                    if tts_url:
                        shot.tts_url = tts_url

                # 2. 匹配 BGM
                if bgm_enabled:
                    bgm_path = audio_service.match_bgm(
                        scene=shot.scene,
                        expression=shot.expression,
                    )
                    if bgm_path:
                        # 提取 BGM 类型名称
                        bgm_type = bgm_path.rsplit("/", 1)[-1].replace(".mp3", "")
                        shot.bgm_type = bgm_type

                # 3. 混入视频（如果有 TTS 或 BGM）
                if tts_url or bgm_path:
                    new_video_url = await audio_service.mix_audio_into_video(
                        video_path=shot.video_url,
                        tts_path=tts_url,
                        bgm_path=bgm_path,
                    )
                    if new_video_url != shot.video_url:
                        shot.video_url = new_video_url
                        audio_count += 1

                # 更新分镜
                ctx.session.add(shot)
                await ctx.session.flush()

                # 发送音频生成事件
                await ctx.ws.send_event(
                    ctx.project.id,
                    {
                        "type": "audio_generated",
                        "data": {
                            "shot_id": shot.id,
                            "tts_url": shot.tts_url,
                            "bgm_type": shot.bgm_type,
                            "duration": shot.duration,
                        },
                    },
                )

            except Exception as e:
                logger.warning("Audio processing failed for shot %s: %s", shot.id, e)
                await self.send_message(ctx, f"分镜 {shot.order} 音频处理失败: {e}，跳过。")

        # 4. 如果分镜视频已混入配音，重新拼接最终视频，确保成片包含 TTS。
        if audio_count > 0:
            updated_video_urls = [shot.video_url for shot in shots if shot.video_url]
            if updated_video_urls:
                try:
                    await self.send_message(
                        ctx,
                        "音频已写入分镜，正在重新拼接最终视频...",
                        progress=0.8,
                        is_loading=True,
                    )
                    merged_url = await ctx.video.merge_urls(updated_video_urls)
                    ctx.project.video_url = merged_url
                    ctx.project.status = "ready"
                    ctx.session.add(ctx.project)
                    await ctx.session.flush()
                    await ctx.ws.send_event(
                        ctx.project.id,
                        {
                            "type": "project_updated",
                            "data": {
                                "project": {
                                    "id": ctx.project.id,
                                    "video_url": merged_url,
                                    "status": ctx.project.status,
                                    "blocking_clips": [],
                                }
                            },
                        },
                    )
                except Exception as e:
                    logger.warning("Final video re-merge after audio failed: %s", e)
                    await self.send_message(ctx, f"音频分镜重新拼接失败: {e}，保留原最终视频。")

        # 5. 为最终合并视频匹配 BGM
        if bgm_enabled and ctx.project.video_url:
            try:
                # 使用所有分镜的场景信息综合匹配
                scenes = [s.scene for s in shots if s.scene]
                expressions = [s.expression for s in shots if s.expression]
                combined = " ".join(scenes + expressions)
                final_bgm_path = audio_service.match_bgm(
                    scene=combined if combined else None,
                    expression=None,
                    genre=ctx.project.style,
                )
                if final_bgm_path:
                    new_project_url = await audio_service.mix_bgm_into_video(
                        video_path=ctx.project.video_url,
                        bgm_path=final_bgm_path,
                    )
                    if new_project_url != ctx.project.video_url:
                        ctx.project.video_url = new_project_url
                        ctx.session.add(ctx.project)
            except Exception as e:
                logger.warning("Final video BGM mixing failed: %s", e)

        await ctx.session.commit()

        if audio_count > 0:
            ctx.completion_info = CompletionInfo(
                completed=f"已为 {audio_count} 个分镜添加音频",
                next="音频处理完成，请查看最终效果",
                question="配音和背景音乐效果如何？",
            )
        else:
            ctx.completion_info = CompletionInfo(
                completed="音频阶段完成",
                next="",
                question="",
            )

        await self.send_message(
            ctx,
            f"音频处理完成！为 {audio_count} 个分镜添加了音频。",
            progress=1.0,
        )

    async def run_videos(self, ctx: AgentContext) -> int:
        """Generate shot videos only (sub-step 1)."""
        await self.send_message(ctx, "开始生成分镜视频...", progress=0.0, is_loading=True)
        video_count = await self._generate_videos(ctx)
        if video_count > 0:
            ctx.completion_info = CompletionInfo(
                completed=f"已生成 {video_count} 个分镜视频",
                next="接下来拼接完整视频",
                question="分镜视频效果如何？",
            )
        else:
            ctx.completion_info = CompletionInfo(
                completed="无视频可生成",
                next="跳过拼接",
                question="",
            )
        return video_count

    async def run_merge(self, ctx: AgentContext) -> None:
        """Merge shot videos into final video (sub-step 2)."""
        await self._merge_videos(ctx)

    async def run_add_audio(self, ctx: AgentContext) -> None:
        """Add TTS dubbing and BGM to shot videos and final merged video (sub-step 3)."""
        await self._add_audio_to_videos(ctx)

    async def run(self, ctx: AgentContext) -> None:
        """Legacy entry point — runs both sub-steps sequentially."""
        await self.send_message(
            ctx, "开始合成：先生成分镜视频，再拼接完整视频...", progress=0.0, is_loading=True
        )
        video_count = await self.run_videos(ctx)
        if video_count > 0:
            await self.run_merge(ctx)
        else:
            await self.send_message(ctx, "无视频可合成。", progress=1.0)
