from __future__ import annotations

from datetime import datetime
from typing import Any, cast

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.agents.base import TargetIds
from app.agents.compose import ComposeAgent
from app.agents.render import RenderAgent
from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404
from app.config import Settings
from app.db.utils import utcnow
from app.models.agent_run import AgentRun
from app.models.message import Message
from app.models.project import Character, Project, Shot
from app.models.universe import Universe, UniverseProjectLink
from app.schemas.project import (
    AgentRunRead,
    CharacterRead,
    FillEmptyShotsRequest,
    MessageRead,
    ProjectCreate,
    ProjectBatchDeleteRequest,
    ProjectProviderSettingsRead,
    ProjectListRead,
    ProjectRead,
    ProjectUpdate,
    ShotReorderRead,
    ShotReorderRequest,
    ShotRead,
    StoryOutlineRead,
    StoryOutlineUpdate,
)
from app.services.run_lifecycle import (
    LocalRunSpec,
    create_local_run,
    project_updated_event,
)
from app.services.creative_control import (
    invalidate_shot_clip_output,
    invalidate_shot_storyboard_outputs,
)
from app.services.file_cleaner import get_local_path
from app.services.project_deletion import delete_project_by_id, delete_projects_by_ids
from app.services.provider_resolution import resolve_project_provider_settings_async
from app.ws.manager import ConnectionManager

router = APIRouter()


async def _project_provider_settings(
    project: Project, settings: Settings
) -> ProjectProviderSettingsRead:
    return (
        await resolve_project_provider_settings_async(project, settings, probe_mode="cache_only")
    ).as_project_provider_settings()


async def _project_read_model(project: Project, settings: Settings) -> ProjectRead:
    return ProjectRead(
        id=project.id if project.id is not None else 0,
        title=project.title,
        story=project.story,
        style=project.style,
        summary=project.summary,
        story_outline=StoryOutlineRead.model_validate(project.story_outline)
        if isinstance(project.story_outline, dict)
        else None,
        visual_bible=project.visual_bible,
        outline_approved=bool(project.outline_approved),
        video_url=project.video_url,
        status=project.status,
        target_shot_count=project.target_shot_count,
        character_hints=project.character_hints or [],
        creation_mode=project.creation_mode,
        reference_images=project.reference_images or [],
        exports=project.exports or [],
        provider_settings=await _project_provider_settings(project, settings),
        created_at=project.created_at,
        updated_at=project.updated_at,
        universe_id=project.universe_id,
        chapter_number=project.chapter_number,
        chapter_title=project.chapter_title,
        skill_id=getattr(project, "skill_id", None),
    )


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
):
    from app.skills.context import apply_skill_defaults_to_create

    universe: Universe | None = None
    if payload.universe_id is not None:
        universe = await session.get(Universe, payload.universe_id)
        if universe is None:
            raise HTTPException(status_code=404, detail="Universe not found")

    skill_defaults = apply_skill_defaults_to_create(
        skill_id=payload.skill_id,
        story=payload.story,
        style=payload.style,
        target_shot_count=payload.target_shot_count,
        creation_mode=payload.creation_mode,
    )
    style = skill_defaults["style"]
    project = Project(
        title=payload.title,
        story=skill_defaults["story"],
        style=style,
        status=payload.status or "draft",
        target_shot_count=skill_defaults["target_shot_count"],
        character_hints=payload.character_hints or [],
        creation_mode=skill_defaults["creation_mode"],
        reference_images=payload.reference_images or [],
        exports=payload.exports or [],
        text_provider_override=payload.text_provider_override,
        image_provider_override=payload.image_provider_override,
        video_provider_override=payload.video_provider_override,
        universe_id=payload.universe_id,
        chapter_number=payload.chapter_number,
        chapter_title=payload.chapter_title,
        skill_id=skill_defaults["skill_id"],
    )
    session.add(project)
    await session.commit()
    await session.refresh(project)

    if universe is not None:
        link = UniverseProjectLink(
            universe_id=universe.id,
            project_id=project.id,
            chapter_number=payload.chapter_number,
            chapter_title=payload.chapter_title,
            is_main_story=True,
        )
        session.add(link)
        await session.commit()

    return await _project_read_model(project, settings)


@router.get("", response_model=ProjectListRead)
async def list_projects(session: AsyncSession = SessionDep, settings: Settings = SettingsDep):
    project_created_at_col = cast(InstrumentedAttribute[datetime], cast(object, Project.created_at))
    res = await session.execute(select(Project).order_by(project_created_at_col.desc()))
    items = res.scalars().all()
    return {
        "items": [await _project_read_model(p, settings) for p in items],
        "total": len(items),
    }


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: int,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
):
    project = await get_or_404(session, Project, project_id)
    return await _project_read_model(project, settings)


@router.get("/{project_id}/outline", response_model=StoryOutlineRead | None)
async def get_project_outline(project_id: int, session: AsyncSession = SessionDep):
    project = await get_or_404(session, Project, project_id)
    if not project.story_outline:
        return None
    return StoryOutlineRead.model_validate(project.story_outline)


@router.put("/{project_id}/outline", response_model=StoryOutlineRead)
async def update_project_outline(
    project_id: int,
    payload: StoryOutlineUpdate,
    session: AsyncSession = SessionDep,
):
    project = await get_or_404(session, Project, project_id)
    outline = dict(project.story_outline or {})
    data = payload.model_dump(exclude_unset=True)
    visual_bible = data.pop("visual_bible", None)
    summary = data.pop("summary", None)
    outline_approved = data.pop("outline_approved", None)
    if "acts" in data and data["acts"] is not None:
        data["acts"] = [act.model_dump() for act in data["acts"]]
    outline.update({key: value for key, value in data.items() if value is not None})
    project.story_outline = outline
    if visual_bible is not None:
        project.visual_bible = visual_bible
    if summary is not None:
        project.summary = summary
    if outline_approved is not None:
        project.outline_approved = outline_approved
    else:
        project.outline_approved = False
    project.updated_at = utcnow()
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return StoryOutlineRead.model_validate(project.story_outline)


@router.get("/{project_id}/final-video")
async def download_final_video(project_id: int, session: AsyncSession = SessionDep):
    project = await get_or_404(session, Project, project_id, detail="Final video not found")
    if not project.video_url:
        raise HTTPException(status_code=404, detail="Final video not found")

    path = get_local_path(project.video_url)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Final video not found")

    return FileResponse(path, filename=path.name)


@router.put("/{project_id}", response_model=ProjectRead)
@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: int,
    payload: ProjectUpdate,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
):
    project = await get_or_404(session, Project, project_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k == "style":
            v = (v or "").strip() or "anime"
        setattr(project, k, v)
    project.updated_at = utcnow()
    session.add(project)
    await session.commit()
    await session.refresh(project)
    return await _project_read_model(project, settings)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: int, session: AsyncSession = SessionDep):
    """完全删除项目及所有关联数据（包括文件）"""
    await delete_project_by_id(session, project_id)
    return None


@router.post("/batch-delete", status_code=status.HTTP_204_NO_CONTENT)
async def batch_delete_projects(
    payload: ProjectBatchDeleteRequest, session: AsyncSession = SessionDep
):
    await delete_projects_by_ids(session, payload.ids)
    return None


@router.post("/{project_id}/upload-reference", response_model=dict)
async def upload_reference_image(
    project_id: int,
    file: UploadFile = File(...),
    session: AsyncSession = SessionDep,
):
    import uuid
    from pathlib import Path

    project = await get_or_404(session, Project, project_id)

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are accepted")

    ref_dir = Path(__file__).parent.parent.parent / "static" / "references"
    ref_dir.mkdir(parents=True, exist_ok=True)

    ext = file.content_type.split("/")[-1]
    if ext == "jpeg":
        ext = "jpg"
    filename = f"{uuid.uuid4().hex[:12]}.{ext}"
    dest = ref_dir / filename

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image must be under 10MB")

    dest.write_bytes(content)

    url_path = f"/static/references/{filename}"

    images = list(project.reference_images or [])
    images.append(url_path)
    project.reference_images = images
    project.updated_at = utcnow()
    session.add(project)
    await session.commit()

    return {"url": url_path, "reference_images": images}


@router.get("/{project_id}/characters", response_model=list[CharacterRead])
async def list_characters(project_id: int, session: AsyncSession = SessionDep):
    await get_or_404(session, Project, project_id)
    character_project_id_col = cast(InstrumentedAttribute[int], cast(object, Character.project_id))
    res = await session.execute(select(Character).where(character_project_id_col == project_id))
    return [CharacterRead.model_validate(c) for c in res.scalars().all()]


@router.get("/{project_id}/shots", response_model=list[ShotRead])
async def list_shots(project_id: int, session: AsyncSession = SessionDep):
    await get_or_404(session, Project, project_id)
    shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
    shot_order_col = cast(InstrumentedAttribute[int], cast(object, Shot.order))
    res = await session.execute(
        select(Shot).where(shot_project_id_col == project_id).order_by(shot_order_col.asc())
    )
    return [ShotRead.model_validate(s) for s in res.scalars().all()]


@router.patch("/{project_id}/shots/reorder", response_model=ShotReorderRead)
async def reorder_shots(
    project_id: int,
    payload: ShotReorderRequest,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    project = await get_or_404(session, Project, project_id)
    items = payload.items
    shot_ids = [item.shot_id for item in items]
    if len(set(shot_ids)) != len(shot_ids):
        raise HTTPException(status_code=400, detail="Duplicate shot_id in reorder payload")

    orders = [item.order for item in items]
    expected_orders = list(range(1, len(items) + 1))
    if sorted(orders) != expected_orders:
        raise HTTPException(
            status_code=400,
            detail="Shot order must be continuous starting at 1",
        )

    shot_project_id_col = cast(InstrumentedAttribute[int], cast(object, Shot.project_id))
    shot_id_col = cast(InstrumentedAttribute[int | None], cast(object, Shot.id))
    shot_order_col = cast(InstrumentedAttribute[int], cast(object, Shot.order))
    res = await session.execute(
        select(Shot)
        .where(shot_project_id_col == project_id)
        .where(shot_id_col.in_(shot_ids))
    )
    shots = list(res.scalars().all())
    if len(shots) != len(shot_ids):
        found_ids = {shot.id for shot in shots}
        missing_ids = [shot_id for shot_id in shot_ids if shot_id not in found_ids]
        raise HTTPException(
            status_code=400,
            detail=f"Unknown shot_ids for project: {missing_ids}",
        )

    order_by_id = {item.shot_id: item.order for item in items}
    for shot in shots:
        if shot.id is None:
            raise HTTPException(status_code=400, detail="Shot id is missing")
        shot.order = order_by_id[shot.id]
        session.add(shot)

    if project.video_url:
        project.status = "superseded"
        session.add(project)

    await session.commit()

    ordered_res = await session.execute(
        select(Shot).where(shot_project_id_col == project_id).order_by(shot_order_col.asc())
    )
    ordered_shots = list(ordered_res.scalars().all())
    shot_payload = [ShotRead.model_validate(shot).model_dump(mode="json") for shot in ordered_shots]

    await ws.send_event(
        project_id,
        {
            "type": "shots_reordered",
            "data": {"project_id": project_id, "shots": shot_payload},
        },
    )
    if project.video_url:
        await ws.send_event(
            project_id,
            {
                "type": "project_updated",
                "data": {
                    "project": {
                        "id": project_id,
                        "status": project.status,
                        "video_url": project.video_url,
                    },
                },
            },
        )

    return ShotReorderRead(shots=[ShotRead.model_validate(shot) for shot in ordered_shots])


@router.post(
    "/{project_id}/shots/fill-empty",
    response_model=AgentRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def fill_empty_shots(
    project_id: int,
    payload: FillEmptyShotsRequest | None = None,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    """补齐九宫格空格：一次 run 只渲染/合成缺少产物的分镜。"""
    if payload is None:
        payload = FillEmptyShotsRequest(type="image")

    project = await get_or_404(session, Project, project_id)

    active = await session.execute(
        select(AgentRun.id)
        .where(AgentRun.project_id == project_id)
        .where(AgentRun.status.in_(("queued", "running")))
        .limit(1)
    )
    if active.first() is not None:
        raise HTTPException(status_code=409, detail="Project already has an active run")

    shot_res = await session.execute(
        select(Shot).where(Shot.project_id == project_id).order_by(Shot.order.asc())
    )
    shots = list(shot_res.scalars().all())
    if not shots:
        raise HTTPException(status_code=400, detail="No shots to fill")

    if payload.type == "image":
        empty = [s for s in shots if s.id is not None and not s.image_url]
        if not empty:
            raise HTTPException(status_code=400, detail="All shot cells already have images")
        for shot in empty:
            await invalidate_shot_storyboard_outputs(session, project, shot)
        agent_plan: list[Any] = [RenderAgent()]
        resource_type = "shot_fill_image"
    else:
        empty = [s for s in shots if s.id is not None and not s.video_url]
        if not empty:
            raise HTTPException(status_code=400, detail="All shot cells already have videos")
        await invalidate_shot_clip_output(session, project)
        agent_plan = [ComposeAgent()]
        resource_type = "shot_fill_video"

    await session.commit()
    await session.refresh(project)

    await ws.send_event(project_id, await project_updated_event(session, project))

    result = await create_local_run(
        session,
        settings=settings,
        ws=ws,
        spec=LocalRunSpec(
            project_id=project_id,
            resource_type="project",
            resource_id=None,
            agent_plan=agent_plan,
            target_ids=TargetIds(
                shot_ids=[s.id for s in empty if s.id is not None],
                character_ids=[],
            ),
        ),
    )
    run = result.run
    # 保留 resource_type 细分（shot_fill_image / shot_fill_video），
    # 前端用它区分补齐的是首帧还是视频。
    run.resource_type = resource_type
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return AgentRunRead.model_validate(run)


@router.get("/{project_id}/messages", response_model=list[MessageRead])
async def list_messages(project_id: int, session: AsyncSession = SessionDep):
    """获取项目的所有消息记录"""
    await get_or_404(session, Project, project_id)
    message_project_id_col = cast(InstrumentedAttribute[int], cast(object, Message.project_id))
    message_created_at_col = cast(InstrumentedAttribute[datetime], cast(object, Message.created_at))
    res = await session.execute(
        select(Message)
        .where(message_project_id_col == project_id)
        .order_by(message_created_at_col.asc())
    )
    return [MessageRead.model_validate(m) for m in res.scalars().all()]
