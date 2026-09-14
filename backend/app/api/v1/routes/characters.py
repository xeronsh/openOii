from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SessionDep, SettingsDep, WsManagerDep, get_or_404
from app.config import Settings
from app.models.project import Character, Project
from app.schemas.project import (
    AgentRunRead,
    CharacterBibleRead,
    CharacterBibleUpdate,
    CharacterRead,
    CharacterUpdate,
    ReferenceImageCreate,
    RegenerateRequest,
)
from app.services.character_bible import (
    compute_face_embedding,
    find_similar_characters,
)
from app.services.run_lifecycle import (
    TargetedRunSpec,
    RunConflict,
    assert_resource_idle,
    create_local_run,
    project_updated_event,
)
from app.services.creative_control import (
    apply_character_rerun_edits,
    invalidate_character_downstream_outputs,
)
from app.services.file_cleaner import delete_file
from app.services.revision import assert_expected_revision, commit_versioned
from app.ws.manager import ConnectionManager

router = APIRouter()


def _character_read(character: Character) -> dict[str, Any]:
    return CharacterRead.model_validate(character).model_dump(mode="json")


@router.put("/{character_id}", response_model=CharacterRead)
@router.patch("/{character_id}", response_model=CharacterRead)
async def update_character(
    character_id: int,
    payload: CharacterUpdate,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    character = await get_or_404(session, Character, character_id)

    data = payload.model_dump(exclude_unset=True)
    data.pop("expected_revision", None)
    assert_expected_revision(character, payload.expected_revision, entity="character")
    for k, v in data.items():
        setattr(character, k, v)

    session.add(character)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)

    await ws.send_event(
        character.project_id,
        {"type": "character_updated", "data": {"character": _character_read(character)}},
    )
    return _character_read(character)


@router.post("/{character_id}/approve", response_model=CharacterRead)
async def approve_character(
    character_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    character = await get_or_404(session, Character, character_id)

    character.freeze_approval()
    session.add(character)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)

    payload = _character_read(character)
    await ws.send_event(
        character.project_id,
        {"type": "character_updated", "data": {"character": payload}},
    )
    return payload


@router.post(
    "/{character_id}/regenerate",
    response_model=AgentRunRead,
    status_code=status.HTTP_201_CREATED,
)
async def regenerate_character(
    character_id: int,
    payload: RegenerateRequest,
    session: AsyncSession = SessionDep,
    settings: Settings = SettingsDep,
    ws: ConnectionManager = WsManagerDep,
):
    if payload.type != "image":
        raise HTTPException(
            status_code=400, detail="Character regeneration only supports type=image"
        )

    character = await get_or_404(session, Character, character_id)
    project = await get_or_404(session, Project, character.project_id)
    project_id = character.project_id

    try:
        await assert_resource_idle(
            session, project_id=project_id, resource_type="character", resource_id=character_id
        )
    except RunConflict as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc

    await apply_character_rerun_edits(
        session,
        character,
        description=payload.description,
        image_url=payload.image_url,
    )
    await invalidate_character_downstream_outputs(session, project, character_id)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)
    await session.refresh(project)

    await ws.send_event(
        project_id,
        {"type": "character_updated", "data": {"character": _character_read(character)}},
    )
    await ws.send_event(project_id, await project_updated_event(session, project))

    result = await create_local_run(
        session,
        settings=settings,
        ws=ws,
        spec=TargetedRunSpec(
            project_id=project_id,
            resource_type="character",
            resource_id=character_id,
            stage="render_characters",
            target_character_ids=(character_id,),
        ),
    )
    return AgentRunRead.model_validate(result.run)


@router.delete("/{character_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_character(
    character_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    character = await get_or_404(session, Character, character_id)

    project_id = character.project_id

    # 删除角色图片文件
    delete_file(character.image_url)

    # 删除数据库记录
    await session.delete(character)
    await commit_versioned(session, character, entity="character")

    # 发送 WebSocket 事件
    await ws.send_event(
        project_id, {"type": "character_deleted", "data": {"character_id": character_id}}
    )

    return None


# ─── Character Bible Routes ─────────────────────────────────────────────────


async def _send_bible_updated_event(
    ws: ConnectionManager,
    character: Character,
    visual_notes_updated: bool = False,
) -> None:
    """Send bible_updated WebSocket event."""
    await ws.send_event(
        character.project_id,
        {
            "type": "bible_updated",
            "data": {
                "character_id": character.id,
                "visual_notes": visual_notes_updated,
                "reference_images_count": len(character.reference_images or []),
                "has_embedding": bool(character.face_embedding),
            },
        },
    )


@router.get("/{character_id}/bible", response_model=CharacterBibleRead)
async def get_character_bible(
    character_id: int,
    session: AsyncSession = SessionDep,
):
    """Get character bible (visual_notes + reference_images + embedding similarity)."""
    character = await get_or_404(session, Character, character_id)

    similarity_scores: list[dict[str, object]] = []
    if character.face_embedding:
        import json as _json

        try:
            embedding = _json.loads(character.face_embedding)
            similar = await find_similar_characters(
                embedding, character.project_id, session, exclude_id=character.id
            )
            similarity_scores = [
                {"character_id": c.id, "name": c.name, "similarity": round(s, 3)}
                for c, s in similar
            ]
        except (_json.JSONDecodeError, ValueError):
            pass

    assert character.id is not None
    return CharacterBibleRead(
        character_id=character.id,
        name=character.name,
        description=character.description,
        visual_notes=character.visual_notes,
        reference_images=character.reference_images or [],
        has_embedding=bool(character.face_embedding),
        similarity_scores=similarity_scores,
    )


@router.put("/{character_id}/bible", response_model=CharacterBibleRead)
async def update_character_bible(
    character_id: int,
    payload: CharacterBibleUpdate,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Update character bible (visual_notes / reference_images)."""
    character = await get_or_404(session, Character, character_id)

    visual_notes_updated = False
    data = payload.model_dump(exclude_unset=True)
    data.pop("expected_revision", None)
    assert_expected_revision(character, payload.expected_revision, entity="character")

    if "visual_notes" in data:
        character.visual_notes = data["visual_notes"]
        visual_notes_updated = True
    if "reference_images" in data:
        character.reference_images = data["reference_images"]

    session.add(character)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)

    await _send_bible_updated_event(ws, character, visual_notes_updated=visual_notes_updated)

    assert character.id is not None
    return CharacterBibleRead(
        character_id=character.id,
        name=character.name,
        description=character.description,
        visual_notes=character.visual_notes,
        reference_images=character.reference_images or [],
        has_embedding=bool(character.face_embedding),
        similarity_scores=[],
    )


@router.post(
    "/{character_id}/reference-images",
    response_model=CharacterBibleRead,
)
async def add_reference_image(
    character_id: int,
    payload: ReferenceImageCreate,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Add a reference image URL to the character bible."""
    character = await get_or_404(session, Character, character_id)

    images = list(character.reference_images or [])
    images.append(payload.image_url)
    character.reference_images = images

    session.add(character)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)

    await _send_bible_updated_event(ws, character)

    assert character.id is not None
    return CharacterBibleRead(
        character_id=character.id,
        name=character.name,
        description=character.description,
        visual_notes=character.visual_notes,
        reference_images=character.reference_images or [],
        has_embedding=bool(character.face_embedding),
        similarity_scores=[],
    )


@router.delete(
    "/{character_id}/reference-images/{index}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_reference_image(
    character_id: int,
    index: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Delete a reference image by index."""
    character = await get_or_404(session, Character, character_id)

    images = list(character.reference_images or [])
    if index < 0 or index >= len(images):
        raise HTTPException(status_code=400, detail=f"Invalid reference image index: {index}")

    images.pop(index)
    character.reference_images = images

    session.add(character)
    await commit_versioned(session, character, entity="character")

    await _send_bible_updated_event(ws, character)

    return None


@router.post(
    "/{character_id}/compute-embedding",
    response_model=CharacterRead,
)
async def compute_character_embedding(
    character_id: int,
    session: AsyncSession = SessionDep,
    ws: ConnectionManager = WsManagerDep,
):
    """Manually trigger embedding computation for a character."""
    character = await get_or_404(session, Character, character_id)

    # Use primary image_url, or first reference_image as fallback
    image_url = character.image_url
    if not image_url and character.reference_images:
        image_url = character.reference_images[0]

    if not image_url:
        raise HTTPException(
            status_code=400, detail="No image available for embedding computation"
        )

    embedding = await compute_face_embedding(image_url)
    if embedding is None:
        raise HTTPException(
            status_code=422, detail="Could not detect face in the image for embedding"
        )

    import json as _json

    character.face_embedding = _json.dumps(embedding)
    session.add(character)
    await commit_versioned(session, character, entity="character")
    await session.refresh(character)

    await _send_bible_updated_event(ws, character)
    return _character_read(character)
