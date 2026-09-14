from __future__ import annotations

from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.models.agent_run import AgentMessage, AgentRun
from app.models.artifact_version import ArtifactVersion
from app.models.consistency_report import ConsistencyReport
from app.models.message import Message
from app.models.project import Character, Project, Shot, ShotCharacterBinding
from app.models.universe import SharedCharacter, UniverseProjectLink
from app.services.file_cleaner import delete_file, delete_files


async def delete_project_files(session: AsyncSession, project: Project, project_id: int) -> None:
    """删除项目关联的所有文件（视频、角色图片、分镜图片/视频）"""
    delete_file(project.video_url)

    character_project_id_col = cast(InstrumentedAttribute[int], cast(object, Character.project_id))
    chars_res = await session.execute(
        select(Character).where(character_project_id_col == project_id)
    )
    chars = chars_res.scalars().all()
    delete_files([c.image_url for c in chars])

    shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
    shots_res = await session.execute(select(Shot).where(shot_project_id_col == project_id))
    shots = shots_res.scalars().all()
    delete_files([s.image_url for s in shots])
    delete_files([s.video_url for s in shots])


async def delete_project_data(session: AsyncSession, project_id: int) -> None:
    """删除项目关联的所有数据库记录"""
    # 删除 assets（source_project_id 引用 project.id）
    from app.models.asset import Asset

    asset_source_project_id_col = cast(
        InstrumentedAttribute[int | None], cast(object, Asset.source_project_id)
    )
    await session.execute(delete(Asset).where(asset_source_project_id_col == project_id))

    universe_link_project_id_col = cast(
        InstrumentedAttribute[int], cast(object, UniverseProjectLink.project_id)
    )
    await session.execute(
        delete(UniverseProjectLink).where(universe_link_project_id_col == project_id)
    )

    shared_character_project_id_col = cast(
        InstrumentedAttribute[int | None], cast(object, SharedCharacter.source_project_id)
    )
    await session.execute(
        update(SharedCharacter)
        .where(shared_character_project_id_col == project_id)
        .values(source_project_id=None)
    )

    message_project_id_col = cast(InstrumentedAttribute[int], cast(object, Message.project_id))
    await session.execute(delete(Message).where(message_project_id_col == project_id))

    agent_run_id_col = cast(InstrumentedAttribute[int | None], cast(object, AgentRun.id))
    agent_run_project_id_col = cast(InstrumentedAttribute[int], cast(object, AgentRun.project_id))
    agent_message_run_id_col = cast(
        InstrumentedAttribute[int | None], cast(object, AgentMessage.run_id)
    )
    run_ids_subq = select(agent_run_id_col).where(agent_run_project_id_col == project_id)
    await session.execute(delete(AgentMessage).where(agent_message_run_id_col.in_(run_ids_subq)))

    artifact_version_project_id_col = cast(
        InstrumentedAttribute[int], cast(object, ArtifactVersion.project_id)
    )
    await session.execute(
        delete(ArtifactVersion).where(artifact_version_project_id_col == project_id)
    )

    consistency_report_project_id_col = cast(
        InstrumentedAttribute[int], cast(object, ConsistencyReport.project_id)
    )
    await session.execute(
        delete(ConsistencyReport).where(consistency_report_project_id_col == project_id)
    )

    await session.execute(delete(AgentRun).where(agent_run_project_id_col == project_id))

    shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
    shot_id_col = cast(InstrumentedAttribute[int | None], cast(object, Shot.id))
    shot_ids_subq = select(shot_id_col).where(shot_project_id_col == project_id)

    character_project_id_col = cast(InstrumentedAttribute[int], cast(object, Character.project_id))
    character_id_col = cast(InstrumentedAttribute[int | None], cast(object, Character.id))
    character_ids_subq = select(character_id_col).where(character_project_id_col == project_id)

    binding_shot_id_col = cast(InstrumentedAttribute[int], cast(object, ShotCharacterBinding.shot_id))
    binding_character_id_col = cast(
        InstrumentedAttribute[int], cast(object, ShotCharacterBinding.character_id)
    )
    await session.execute(
        delete(ShotCharacterBinding).where(
            binding_shot_id_col.in_(shot_ids_subq)
            | binding_character_id_col.in_(character_ids_subq)
        )
    )

    await session.execute(delete(Shot).where(shot_project_id_col == project_id))
    await session.execute(delete(Character).where(character_project_id_col == project_id))



async def delete_project_by_id(session: AsyncSession, project_id: int) -> None:
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    agent_run_project_id_col = cast(InstrumentedAttribute[int], cast(object, AgentRun.project_id))
    agent_run_status_col = cast(InstrumentedAttribute[str], cast(object, AgentRun.status))
    await session.execute(
        update(AgentRun)
        .where(agent_run_project_id_col == project_id)
        .where(agent_run_status_col.in_(("queued", "running")))
        .values(status="cancelled")
    )

    await delete_project_files(session, project, project_id)
    await delete_project_data(session, project_id)

    await session.delete(project)
    await session.commit()


async def delete_projects_by_ids(session: AsyncSession, project_ids: list[int]) -> list[int]:
    """删除多个项目（非破坏性批量）。不存在的 ID 将被忽略。"""

    deleted_ids: list[int] = []

    # 去重并保持稳定顺序，避免重复删除导致额外无效 SQL
    seen: set[int] = set()
    unique_ids: list[int] = []
    for pid in project_ids:
        if pid not in seen:
            seen.add(pid)
            unique_ids.append(pid)

    for project_id in unique_ids:
        try:
            await delete_project_by_id(session, project_id)
            deleted_ids.append(project_id)
        except HTTPException as exc:
            if exc.status_code != status.HTTP_404_NOT_FOUND:
                raise

    return deleted_ids
