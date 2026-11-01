from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun
from app.models.project import Character, Project, Shot

def _blocking_clip_reason(status: str) -> str:
    return {
        "missing": "当前分镜视频尚未生成",
        "generating": "当前分镜视频仍在生成中",
        "failed": "当前分镜视频生成失败",
    }.get(status, "当前分镜视频不可用于最终拼接")


async def collect_project_blocking_clips(
    session: AsyncSession, project: Project
) -> list[dict[str, Any]]:
    if project.id is None:
        return []

    shot_res = await session.execute(
        select(Shot).where(Shot.project_id == project.id).order_by(Shot.order.asc())
    )
    shots = list(shot_res.scalars().all())

    run_res = await session.execute(
        select(AgentRun)
        .where(AgentRun.project_id == project.id)
        .where(AgentRun.resource_type == "shot")
        .where(AgentRun.resource_id.isnot(None))
        .order_by(AgentRun.updated_at.desc())
    )
    runs = list(run_res.scalars().all())

    latest_status_by_shot: dict[int, str] = {}
    for run in runs:
        if run.resource_id is None:
            continue
        if run.resource_id in latest_status_by_shot:
            continue
        latest_status_by_shot[run.resource_id] = run.status

    blocking_clips: list[dict[str, Any]] = []
    for shot in shots:
        if shot.id is None:
            continue

        run_status = latest_status_by_shot.get(shot.id)
        clip_status = "complete"
        if run_status in {"queued", "running"}:
            clip_status = "generating"
        elif run_status == "failed" and not shot.video_url:
            clip_status = "failed"
        elif not shot.video_url:
            clip_status = "missing"

        if clip_status == "complete":
            continue

        blocking_clips.append(
            {
                "shot_id": shot.id,
                "order": shot.order,
                "status": clip_status,
                "reason": _blocking_clip_reason(clip_status),
            }
        )

    return blocking_clips


async def apply_character_rerun_edits(
    session: AsyncSession,
    character: Character,
    *,
    description: str | None = None,
    image_url: str | None = None,
) -> Character:
    if description is not None:
        character.description = description
    if image_url is not None:
        character.image_url = image_url
    session.add(character)
    await session.flush()
    return character


async def invalidate_character_downstream_outputs(
    session: AsyncSession,
    project: Project,
    character_id: int,
) -> None:
    if project.video_url:
        project.status = "superseded"
    session.add(project)
    await session.flush()


async def invalidate_shot_storyboard_outputs(
    session: AsyncSession,
    project: Project,
    shot: Shot,
) -> None:
    if project.video_url:
        project.status = "superseded"
    session.add(project)
    await session.flush()


async def invalidate_shot_clip_output(
    session: AsyncSession,
    project: Project,
) -> None:
    if project.video_url:
        project.status = "superseded"
    session.add(project)
    await session.flush()
