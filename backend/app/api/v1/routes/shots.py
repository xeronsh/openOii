from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404
from app.config import Settings
from app.models.project import Character, Project, Shot, ShotCharacterBinding
from app.schemas.project import AgentRunRead, RegenerateRequest, ShotRead, ShotUpdate
from app.services.run_lifecycle import (
    TargetedRunSpec,
    RunConflict,
    assert_resource_idle,
    create_local_run,
    project_updated_event,
)
from app.services.revision import assert_expected_revision, commit_versioned
from app.ws.manager import ConnectionManager

router = APIRouter()


def _shot_read(shot: Shot) -> dict[str, Any]:
    return ShotRead.model_validate(shot).model_dump(mode="json")


def _validate_shot_approval_ready(shot: Shot) -> None:
    # prompt / image_prompt are rebuilt at render time (an edit clears them) and
    # the planner never writes motion_note, so neither can block approval.
    missing = []
    if not shot.description:
        missing.append("描述")
    if shot.duration is None:
        missing.append("时长")
    if not shot.camera:
        missing.append("镜头")
    if not shot.character_ids:
        missing.append("出场角色")

    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"批准镜头前请先补全：{'、'.join(missing)}",
        )


async def _sync_shot_character_bindings(session: AsyncSession, shot: Shot) -> None:
    shot_id_col = cast(InstrumentedAttribute[int], cast(object, ShotCharacterBinding.shot_id))
    await session.execute(delete(ShotCharacterBinding).where(shot_id_col == shot.id))
    shot_id = shot.id
    if shot.character_ids:
        if shot_id is None:
            raise RuntimeError("Shot binding sync requires a persisted shot id")
        session.add_all(
            [
                ShotCharacterBinding(shot_id=shot_id, character_id=character_id)
                for character_id in shot.character_ids
            ]
        )


async def _validate_shot_character_ids(
    session: AsyncSession, project_id: int, character_ids: list[int]
) -> None:
    if not character_ids:
        return

    character_id_col = cast(InstrumentedAttribute[int | None], cast(object, Character.id))
    character_project_id_col = cast(InstrumentedAttribute[int], cast(object, Character.project_id))
    res = await session.execute(
        select(character_id_col).where(
            character_project_id_col == project_id,
            character_id_col.in_(character_ids),
        )
    )
    found_ids = {character_id for character_id in res.scalars().all() if character_id is not None}
    missing_ids = [character_id for character_id in character_ids if character_id not in found_ids]
    if missing_ids:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown character_ids for project: {missing_ids}",
        )


# Fields the image_prompt / prompt are derived from.
_PROMPT_SOURCE_FIELDS = ("description", "scene", "action", "expression", "lighting")


def _changed(shot: Shot, data: dict, field: str) -> bool:
    return field in data and (data[field] or "") != (getattr(shot, field) or "")


@router.put("/{shot_id}", response_model=ShotRead)
@router.patch("/{shot_id}", response_model=ShotRead)
async def update_shot(
    shot_id: int,
    payload: ShotUpdate,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    shot = await get_or_404(session, Shot, shot_id)

    project_id = shot.project_id

    data = payload.model_dump(exclude_unset=True)
    data.pop("expected_revision", None)
    assert_expected_revision(shot, payload.expected_revision, entity="shot")
    character_ids_updated = False
    if "character_ids" in data:
        character_ids = list(
            dict.fromkeys(int(character_id) for character_id in data.pop("character_ids") or [])
        )
        await _validate_shot_character_ids(session, project_id, character_ids)
        shot.character_ids = character_ids
        character_ids_updated = True
    # The saved image/video prompts were written from the old description; once
    # the content changes they would silently keep rendering the old shot. Drop
    # them so the next render rebuilds them from the edited description. A
    # prompt the same edit changes is the user's own and is kept; the inspector
    # form resends unchanged prompts, which count as not edited.
    if any(_changed(shot, data, field) for field in _PROMPT_SOURCE_FIELDS):
        for field in ("image_prompt", "prompt"):
            if not _changed(shot, data, field):
                data[field] = None
        # The existing image/video still shows the old description, so its
        # visual review no longer applies.
        if shot.image_url or shot.video_url:
            data["review_status"] = "unchecked"
            data["review_note"] = "描述已修改，画面还没按新描述重画"
    for k, v in data.items():
        setattr(shot, k, v)

    session.add(shot)
    if character_ids_updated:
        await _sync_shot_character_bindings(session, shot)
    await commit_versioned(session, shot, entity="shot")
    await session.refresh(shot)

    await ws.send_event(
        project_id,
        {"type": "shot_updated", "data": {"shot": _shot_read(shot)}},
    )
    return _shot_read(shot)


@router.post("/{shot_id}/approve", response_model=ShotRead)
async def approve_shot(
    shot_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    shot = await get_or_404(session, Shot, shot_id)

    _validate_shot_approval_ready(shot)
    await _validate_shot_character_ids(session, shot.project_id, list(shot.character_ids))
    shot.freeze_approval()
    session.add(shot)
    await commit_versioned(session, shot, entity="shot")
    await session.refresh(shot)

    payload = _shot_read(shot)
    await ws.send_event(
        shot.project_id,
        {"type": "shot_updated", "data": {"shot": payload}},
    )
    return payload


@router.post(
    "/{shot_id}/regenerate", response_model=AgentRunRead, status_code=status.HTTP_201_CREATED
)
async def regenerate_shot(
    shot_id: int,
    payload: RegenerateRequest | None = None,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    if payload is None:
        payload = RegenerateRequest(type="video")

    shot = await get_or_404(session, Shot, shot_id)
    project = await get_or_404(session, Project, shot.project_id)
    project_id = shot.project_id

    try:
        await assert_resource_idle(
            session, project_id=project_id, resource_type="shot", resource_id=shot_id
        )
    except RunConflict as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc

    # The current cut stays current until the engine commits the new keyframe
    # or clip (it marks the project superseded then); a regenerate that fails
    # leaves nothing changed, so it must not mark the film 已过期.
    if payload.type == "image":
        await ws.send_event(
            project_id, {"type": "shot_updated", "data": {"shot": _shot_read(shot)}}
        )
        stage = "render_shots"
    else:
        stage = "compose_videos"

    await ws.send_event(project_id, await project_updated_event(session, project))

    result = await create_local_run(
        session,
        settings=settings,
        ws=ws,
        spec=TargetedRunSpec(
            project_id=project_id,
            resource_type="shot",
            resource_id=shot_id,
            stage=stage,
            target_shot_ids=(shot_id,),
            force_regenerate=True,
        ),
    )
    return AgentRunRead.model_validate(result.run)


@router.delete("/{shot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_shot(
    shot_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    shot = await get_or_404(session, Shot, shot_id)

    project_id = shot.project_id

    # 删除项目最终视频（因为分镜变化了）
    project = await session.get(Project, project_id)
    cleared_project_video = False
    if project and project.video_url:
        project.video_url = None
        session.add(project)
        cleared_project_video = True

    # 删除数据库记录
    await session.delete(shot)
    await commit_versioned(session, shot, entity="shot")

    # 发送 WebSocket 事件
    await ws.send_event(project_id, {"type": "shot_deleted", "data": {"shot_id": shot_id}})
    if cleared_project_video:
        await ws.send_event(
            project_id,
            {"type": "project_updated", "data": {"project": {"id": project_id, "video_url": None}}},
        )

    return None
