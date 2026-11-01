"""Universe / IP 宇宙 API 路由。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SessionDep, get_or_404
from app.models.universe import Universe, SharedCharacter, UniverseProjectLink
from app.models.project import Project, Character, Shot
from app.schemas.universe import (
    UniverseCreate,
    UniverseUpdate,
    UniverseRead,
    UniverseDetailRead,
    UniverseProjectLinkCreate,
    UniverseProjectLinkRead,
    UniverseTimelineChapterRead,
    UniverseTimelineRead,
    ImportedCharacterRead,
    ImportSharedCastRead,
    SharedCharacterRead,
    SharedCharacterPromote,
    SharedCharacterManualCreate,
)
from app.services.universe_service import UniverseService

router = APIRouter()


async def _active_universe_or_404(session: AsyncSession, universe_id: int) -> Universe:
    """Deleted universes are soft-deleted: hide them everywhere, not only from the list."""
    universe = await get_or_404(session, Universe, universe_id)
    if not universe.is_active:
        raise HTTPException(status_code=404, detail="Universe not found")
    return universe


def _universe_read(universe: Universe, projects_count: int = 0, shared_characters_count: int = 0) -> dict:
    return UniverseRead(
        id=universe.id,
        name=universe.name,
        description=universe.description,
        world_setting=universe.world_setting,
        style_rules=universe.style_rules,
        cover_image_url=universe.cover_image_url,
        is_active=universe.is_active,
        created_at=universe.created_at,
        updated_at=universe.updated_at,
        projects_count=projects_count,
        shared_characters_count=shared_characters_count,
    ).model_dump(mode="json")


def _shared_character_read(sc: SharedCharacter) -> SharedCharacterRead:
    return SharedCharacterRead(
        id=sc.id,
        universe_id=sc.universe_id,
        name=sc.name,
        description=sc.description,
        visual_notes=sc.visual_notes,
        canonical_image_url=sc.canonical_image_url,
        reference_images=sc.reference_images or [],
        face_embedding=sc.face_embedding,  # type: ignore[call-arg]
        character_tags=sc.character_tags,
        source_project_id=sc.source_project_id,
        source_character_id=sc.source_character_id,
        version=sc.version,
        is_active=sc.is_active,
        created_at=sc.created_at,
        updated_at=sc.updated_at,
        reference_images_count=len(sc.reference_images or []),
        has_embedding=bool(sc.face_embedding),
    ).model_dump(mode="json")


# ── Universe CRUD ──────────────────────────────────────────────


@router.post("", response_model=UniverseRead, status_code=status.HTTP_201_CREATED)
async def create_universe(
    payload: UniverseCreate,
    session: AsyncSession = SessionDep,
):
    svc = UniverseService(session)
    universe = await svc.create_universe(
        name=payload.name,
        description=payload.description,
        world_setting=payload.world_setting,
        style_rules=payload.style_rules,
        cover_image_url=payload.cover_image_url,
    )
    return _universe_read(universe)


@router.get("", response_model=list[UniverseRead])
async def list_universes(
    session: AsyncSession = SessionDep,
):
    svc = UniverseService(session)
    universes = await svc.list_universes()

    results = []
    for u in universes:
        # count projects
        pc_result = await session.execute(
            select(func.count()).select_from(UniverseProjectLink).where(
                UniverseProjectLink.universe_id == u.id
            )
        )
        projects_count = pc_result.scalar() or 0

        # count shared characters
        sc_result = await session.execute(
            select(func.count()).select_from(SharedCharacter).where(
                SharedCharacter.universe_id == u.id,
                SharedCharacter.is_active == True,  # noqa: E712
            )
        )
        shared_characters_count = sc_result.scalar() or 0

        results.append(_universe_read(u, projects_count, shared_characters_count))

    return results


@router.get("/{universe_id}", response_model=UniverseDetailRead)
async def get_universe(
    universe_id: int,
    session: AsyncSession = SessionDep,
):
    universe = await _active_universe_or_404(session, universe_id)
    svc = UniverseService(session)

    chapters = await svc.get_universe_chapters(universe_id)
    shared_chars = await svc.get_universe_shared_characters(universe_id)

    # Enrich chapters with project title
    chapter_reads = []
    for ch in chapters:
        project = await session.get(Project, ch.project_id)
        chapter_reads.append(
            UniverseProjectLinkRead(
                id=ch.id,
                universe_id=ch.universe_id,
                project_id=ch.project_id,
                chapter_number=ch.chapter_number,
                chapter_title=ch.chapter_title,
                is_main_story=ch.is_main_story,
                created_at=ch.created_at,
                project_title=project.title if project else None,
            ).model_dump(mode="json")
        )

    return UniverseDetailRead(
        id=universe.id,
        name=universe.name,
        description=universe.description,
        world_setting=universe.world_setting,
        style_rules=universe.style_rules,
        cover_image_url=universe.cover_image_url,
        is_active=universe.is_active,
        created_at=universe.created_at,
        updated_at=universe.updated_at,
        projects_count=len(chapters),
        shared_characters_count=len(shared_chars),
        chapters=chapter_reads,
        shared_characters=[_shared_character_read(sc) for sc in shared_chars],
    ).model_dump(mode="json")


@router.get("/{universe_id}/timeline", response_model=UniverseTimelineRead)
async def get_universe_timeline(
    universe_id: int,
    current_project_id: int | None = None,
    session: AsyncSession = SessionDep,
):
    """跨章节时间线：章节状态、摘要、镜头/角色计数，供工作台 continuity 面板。"""
    universe = await _active_universe_or_404(session, universe_id)
    svc = UniverseService(session)
    chapters = await svc.get_universe_chapters(universe_id)
    shared_chars = await svc.get_universe_shared_characters(universe_id)

    chapter_reads: list[UniverseTimelineChapterRead] = []
    for ch in chapters:
        project = await session.get(Project, ch.project_id)
        if project is None:
            continue
        char_count_res = await session.execute(
            select(func.count()).select_from(Character).where(Character.project_id == project.id)
        )
        shot_count_res = await session.execute(
            select(func.count()).select_from(Shot).where(Shot.project_id == project.id)
        )
        chapter_reads.append(
            UniverseTimelineChapterRead(
                project_id=project.id if project.id is not None else 0,
                chapter_number=ch.chapter_number or project.chapter_number,
                chapter_title=ch.chapter_title or project.chapter_title,
                title=project.title,
                summary=project.summary,
                status=project.status,
                is_main_story=ch.is_main_story,
                is_current=bool(
                    current_project_id is not None and project.id == current_project_id
                ),
                character_count=int(char_count_res.scalar() or 0),
                shot_count=int(shot_count_res.scalar() or 0),
                has_video=bool(project.video_url),
                style=project.style,
            )
        )

    return UniverseTimelineRead(
        universe_id=universe.id if universe.id is not None else 0,
        universe_name=universe.name,
        world_setting=universe.world_setting,
        style_rules=universe.style_rules,
        chapters=chapter_reads,
        shared_character_count=len(shared_chars),
        shared_characters=[_shared_character_read(sc) for sc in shared_chars],
    )


@router.put("/{universe_id}", response_model=UniverseRead)
async def update_universe(
    universe_id: int,
    payload: UniverseUpdate,
    session: AsyncSession = SessionDep,
):
    universe = await _active_universe_or_404(session, universe_id)
    svc = UniverseService(session)

    update_data = payload.model_dump(exclude_unset=True)
    universe = await svc.update_universe(universe, **update_data)

    # compute counts
    pc_result = await session.execute(
        select(func.count()).select_from(UniverseProjectLink).where(
            UniverseProjectLink.universe_id == universe.id
        )
    )
    projects_count = pc_result.scalar() or 0
    sc_result = await session.execute(
        select(func.count()).select_from(SharedCharacter).where(
            SharedCharacter.universe_id == universe.id,
            SharedCharacter.is_active == True,  # noqa: E712
        )
    )
    shared_characters_count = sc_result.scalar() or 0

    return _universe_read(universe, projects_count, shared_characters_count)


@router.delete("/{universe_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_universe(
    universe_id: int,
    session: AsyncSession = SessionDep,
):
    """删除 IP 宇宙（软删除，清除关联项目的外键引用）"""
    universe = await _active_universe_or_404(session, universe_id)
    svc = UniverseService(session)
    await svc.delete_universe(universe)


# ── Universe-Project 关联 ─────────────────────────────────────


@router.post(
    "/{universe_id}/projects",
    response_model=UniverseProjectLinkRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_project_to_universe(
    universe_id: int,
    payload: UniverseProjectLinkCreate,
    session: AsyncSession = SessionDep,
):
    await _active_universe_or_404(session, universe_id)
    project = await get_or_404(session, Project, payload.project_id)

    svc = UniverseService(session)
    link = await svc.add_project_to_universe(
        universe_id=universe_id,
        project_id=payload.project_id,
        chapter_number=payload.chapter_number,
        chapter_title=payload.chapter_title,
        is_main_story=payload.is_main_story,
    )

    return UniverseProjectLinkRead(
        id=link.id,
        universe_id=link.universe_id,
        project_id=link.project_id,
        chapter_number=link.chapter_number,
        chapter_title=link.chapter_title,
        is_main_story=link.is_main_story,
        created_at=link.created_at,
        project_title=project.title,
    ).model_dump(mode="json")


@router.delete(
    "/{universe_id}/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_project_from_universe(
    universe_id: int,
    project_id: int,
    session: AsyncSession = SessionDep,
):
    await _active_universe_or_404(session, universe_id)
    await get_or_404(session, Project, project_id)

    svc = UniverseService(session)
    removed = await svc.remove_project_from_universe(universe_id, project_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Project not in this universe")


# ── Shared Character ──────────────────────────────────────────


@router.post(
    "/{universe_id}/shared-characters",
    response_model=SharedCharacterRead,
    status_code=status.HTTP_201_CREATED,
)
async def promote_character(
    universe_id: int,
    payload: SharedCharacterPromote,
    session: AsyncSession = SessionDep,
):
    await _active_universe_or_404(session, universe_id)

    svc = UniverseService(session)
    shared_char = await svc.promote_character_to_shared(
        character_id=payload.character_id,
        universe_id=universe_id,
    )
    return _shared_character_read(shared_char)


@router.get(
    "/{universe_id}/shared-characters",
    response_model=list[SharedCharacterRead],
)
async def list_shared_characters(
    universe_id: int,
    session: AsyncSession = SessionDep,
):
    await _active_universe_or_404(session, universe_id)
    svc = UniverseService(session)
    shared_chars = await svc.get_universe_shared_characters(universe_id)
    return [_shared_character_read(sc) for sc in shared_chars]


@router.post(
    "/{universe_id}/shared-characters/manual",
    response_model=SharedCharacterRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_shared_character_manual(
    universe_id: int,
    payload: SharedCharacterManualCreate,
    session: AsyncSession = SessionDep,
):
    await _active_universe_or_404(session, universe_id)

    sc = SharedCharacter(
        universe_id=universe_id,
        name=payload.name,
        description=payload.description,
        visual_notes=payload.visual_notes,
        canonical_image_url=payload.canonical_image_url,
        character_tags=payload.character_tags,
        reference_images=[],
    )
    session.add(sc)
    await session.commit()
    await session.refresh(sc)
    return _shared_character_read(sc)


@router.post(
    "/projects/{project_id}/import-character/{shared_character_id}",
    response_model=ImportedCharacterRead,
    status_code=status.HTTP_201_CREATED,
)
async def import_character_to_project(
    project_id: int,
    shared_character_id: int,
    session: AsyncSession = SessionDep,
):
    project = await get_or_404(session, Project, project_id)
    shared_char = await get_or_404(session, SharedCharacter, shared_character_id)

    # 防止跨宇宙静默覆盖：目标项目必须属于该共享角色所在宇宙
    if project.universe_id != shared_char.universe_id:
        raise HTTPException(
            status_code=400,
            detail="Project does not belong to this universe",
        )

    svc = UniverseService(session)
    character = await svc.import_shared_character_to_project(
        shared_character_id=shared_character_id,
        project_id=project_id,
    )
    return {
        "id": character.id,
        "name": character.name,
        "project_id": character.project_id,
    }


@router.post(
    "/projects/{project_id}/import-shared-cast",
    response_model=ImportSharedCastRead,
    status_code=status.HTTP_200_OK,
)
async def import_shared_cast_to_project(
    project_id: int,
    session: AsyncSession = SessionDep,
):
    """将宇宙全部共享角色导入当前章节项目（跳过已存在同名）。"""
    project = await get_or_404(session, Project, project_id)
    if not project.universe_id:
        raise HTTPException(
            status_code=400,
            detail="Project is not linked to a universe",
        )

    svc = UniverseService(session)
    shared = await svc.get_universe_shared_characters(project.universe_id)
    existing_res = await session.execute(
        select(Character).where(Character.project_id == project_id)
    )
    existing_names = {c.name for c in existing_res.scalars().all()}
    skipped = sum(1 for sc in shared if sc.name in existing_names)

    imported = await svc.auto_import_shared_characters(project_id, mode="all")
    return ImportSharedCastRead(
        project_id=project_id,
        imported_count=len(imported),
        imported=[
            ImportedCharacterRead(
                id=c.id if c.id is not None else 0,
                name=c.name,
                project_id=c.project_id,
            )
            for c in imported
        ],
        skipped_existing=skipped,
    )


@router.post("/characters/{character_id}/sync-to-universe", response_model=SharedCharacterRead)
async def sync_character_to_universe(
    character_id: int,
    session: AsyncSession = SessionDep,
):
    await get_or_404(session, Character, character_id)

    svc = UniverseService(session)
    shared_char = await svc.sync_character_back(character_id)
    if not shared_char:
        raise HTTPException(
            status_code=404,
            detail="No shared character found for this project character",
        )
    return _shared_character_read(shared_char)
