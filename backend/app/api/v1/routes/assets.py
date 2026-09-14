from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SessionDep
from app.models.asset import Asset
from app.models.project import Character, Shot
from app.schemas.project import (
    AssetCreate,
    AssetListRead,
    AssetRead,
    CharacterRead,
    ShotRead,
    UseAssetInProjectRequest,
)
from app.services.file_cleaner import STATIC_DIR

router = APIRouter()


@router.post("/upload-image", response_model=dict)
async def upload_asset_image(file: UploadFile = File(...)):
    """上传资产图片到 /static/assets/ 目录，返回 URL 路径"""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are accepted")

    assets_dir = STATIC_DIR / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    ext = file.content_type.split("/")[-1]
    if ext == "jpeg":
        ext = "jpg"
    filename = f"{uuid4().hex[:12]}.{ext}"
    dest = assets_dir / filename

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image must be under 10MB")

    dest.write_bytes(content)

    url_path = f"/static/assets/{filename}"
    return {"url": url_path}


@router.get("", response_model=AssetListRead)
async def list_assets(
    asset_type: str | None = None,
    search: str | None = None,
    tag: str | None = None,
    session: AsyncSession = SessionDep,
):
    q = select(Asset).order_by(Asset.updated_at.desc())
    if asset_type:
        q = q.where(Asset.asset_type == asset_type)
    if search:
        pattern = f"%{search}%"
        q = q.where(or_(Asset.name.ilike(pattern), Asset.description.ilike(pattern)))
    if tag:
        q = q.where(Asset.tags.ilike(f"%{tag}%"))
    res = await session.execute(q)
    items = res.scalars().all()
    return AssetListRead(items=[AssetRead.model_validate(a) for a in items], total=len(items))


@router.post("", response_model=AssetRead, status_code=status.HTTP_201_CREATED)
async def create_asset(payload: AssetCreate, session: AsyncSession = SessionDep):
    asset = Asset(
        name=payload.name,
        asset_type=payload.asset_type,
        description=payload.description,
        image_url=payload.image_url,
        metadata_json=payload.metadata_json,
        source_project_id=payload.source_project_id,
        tags=payload.tags,
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return AssetRead.model_validate(asset)


@router.post(
    "/from-character/{character_id}", response_model=AssetRead, status_code=status.HTTP_201_CREATED
)
async def create_asset_from_character(character_id: int, session: AsyncSession = SessionDep):
    character = await session.get(Character, character_id)
    if not character:
        raise HTTPException(status_code=404, detail="Character not found")
    asset = Asset(
        name=character.approved_name or character.name,
        asset_type="character",
        description=character.approved_description or character.description,
        image_url=character.approved_image_url or character.image_url,
        source_project_id=character.project_id,
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return AssetRead.model_validate(asset)


@router.post("/from-shot/{shot_id}", response_model=AssetRead, status_code=status.HTTP_201_CREATED)
async def create_asset_from_shot(shot_id: int, session: AsyncSession = SessionDep):
    """将镜头保存为场景资产"""
    import json

    shot = await session.get(Shot, shot_id)
    if not shot:
        raise HTTPException(status_code=404, detail="Shot not found")

    name = shot.scene or shot.description[:50] or f"镜头 {shot.order}"
    metadata: dict = {}
    if shot.lighting:
        metadata["lighting"] = shot.lighting
    if shot.camera:
        metadata["camera"] = shot.camera
    if shot.duration:
        metadata["duration"] = shot.duration
    if shot.motion_note:
        metadata["motion_note"] = shot.motion_note

    asset = Asset(
        name=name,
        asset_type="scene",
        description=shot.description,
        image_url=shot.image_url,
        metadata_json=json.dumps(metadata, ensure_ascii=False) if metadata else None,
        source_project_id=shot.project_id,
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return AssetRead.model_validate(asset)


@router.get("/{asset_id}", response_model=AssetRead)
async def get_asset(asset_id: int, session: AsyncSession = SessionDep):
    asset = await session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return AssetRead.model_validate(asset)


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(asset_id: int, session: AsyncSession = SessionDep):
    asset = await session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    await session.delete(asset)
    await session.commit()
    return None


@router.post(
    "/{asset_id}/use-in-project",
    response_model=CharacterRead | ShotRead,
)
async def use_asset_in_project(
    asset_id: int,
    payload: UseAssetInProjectRequest,
    session: AsyncSession = SessionDep,
):
    """将资产拉入目标项目：character→创建角色，scene/style→创建镜头"""
    asset = await session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    from app.db.utils import utcnow

    if asset.asset_type == "character":
        character = Character(
            project_id=payload.project_id,
            name=asset.name,
            description=asset.description,
            image_url=asset.image_url,
            approval_version=1,
            approved_at=utcnow(),
            approved_name=asset.name,
            approved_description=asset.description,
            approved_image_url=asset.image_url,
        )
        session.add(character)
        await session.commit()
        await session.refresh(character)
        return CharacterRead.model_validate(character)

    if asset.asset_type == "scene":
        import json

        metadata = {}
        if asset.metadata_json:
            try:
                metadata = json.loads(asset.metadata_json)
            except (json.JSONDecodeError, TypeError):
                pass

        # 计算新镜头的 order
        from sqlalchemy import func

        max_order = await session.execute(
            select(func.max(Shot.order)).where(Shot.project_id == payload.project_id)
        )
        next_order = (max_order.scalar() or -1) + 1

        shot = Shot(
            project_id=payload.project_id,
            order=next_order,
            description=asset.description or asset.name,
            image_url=asset.image_url,
            scene=asset.name,
            lighting=metadata.get("lighting"),
            camera=metadata.get("camera"),
            duration=metadata.get("duration"),
            motion_note=metadata.get("motion_note"),
            approval_version=1,
            approved_at=utcnow(),
            approved_description=asset.description or asset.name,
            approved_scene=asset.name,
        )
        session.add(shot)
        await session.commit()
        await session.refresh(shot)
        return ShotRead.model_validate(shot)

    raise HTTPException(
        status_code=400,
        detail=f"Asset type '{asset.asset_type}' is not supported",
    )
