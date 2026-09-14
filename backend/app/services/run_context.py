"""Build the immutable execution context for one workflow run.

Secrets are deliberately not copied into the snapshot. Provider identity,
model, endpoint and generation policy are pinned; credentials remain referenced
by their config key so operators can rotate secrets without rewriting history.
"""

from __future__ import annotations

from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.config import Settings
from app.generated.workflow_contract import WORKFLOW_VERSION
from app.models.config_item import ConfigItem
from app.models.project import Project
from app.models.style_template import StyleTemplate
from app.models.universe import SharedCharacter, Universe
from app.schemas.project import ProviderResolution
from app.skills.catalog import get_skill


def _setting_value(settings: Settings, key: str) -> object | None:
    field = key.lower()
    return getattr(settings, field, None)


async def _effective_provider_config(session: AsyncSession, settings: Settings) -> dict[str, object]:
    rows = (await session.execute(select(ConfigItem))).scalars().all()
    db = {row.key.upper(): row.value for row in rows}

    def pick(key: str) -> object | None:
        value = db.get(key)
        if value not in (None, ""):
            return value
        return _setting_value(settings, key)

    return {
        "ANTHROPIC_BASE_URL": pick("ANTHROPIC_BASE_URL"),
        "ANTHROPIC_MODEL": pick("ANTHROPIC_MODEL"),
        "TEXT_BASE_URL": pick("TEXT_BASE_URL"),
        "TEXT_MODEL": pick("TEXT_MODEL"),
        "TEXT_ENDPOINT": pick("TEXT_ENDPOINT"),
        "IMAGE_BASE_URL": pick("IMAGE_BASE_URL"),
        "IMAGE_MODEL": pick("IMAGE_MODEL"),
        "IMAGE_ENDPOINT": pick("IMAGE_ENDPOINT"),
        "ENABLE_IMAGE_TO_IMAGE": pick("ENABLE_IMAGE_TO_IMAGE"),
        "VIDEO_BASE_URL": pick("VIDEO_BASE_URL"),
        "VIDEO_MODEL": pick("VIDEO_MODEL"),
        "VIDEO_ENDPOINT": pick("VIDEO_ENDPOINT"),
        "VIDEO_MODE": pick("VIDEO_MODE"),
        "ENABLE_IMAGE_TO_VIDEO": pick("ENABLE_IMAGE_TO_VIDEO"),
        "DOUBAO_VIDEO_MODEL": pick("DOUBAO_VIDEO_MODEL"),
        "DOUBAO_VIDEO_DURATION": pick("DOUBAO_VIDEO_DURATION"),
        "DOUBAO_VIDEO_RATIO": pick("DOUBAO_VIDEO_RATIO"),
        "TTS_ENABLED": pick("TTS_ENABLED"),
        "BGM_ENABLED": pick("BGM_ENABLED"),
        "CRITIQUE_ENABLED": pick("CRITIQUE_ENABLED"),
        "CRITIQUE_SCORE_THRESHOLD": pick("CRITIQUE_SCORE_THRESHOLD"),
        "CRITIQUE_MAX_ROUNDS": pick("CRITIQUE_MAX_ROUNDS"),
        "THINKING_CHAIN_ENABLED": pick("THINKING_CHAIN_ENABLED"),
        "THINKING_CHAIN_DETAIL_LEVEL": pick("THINKING_CHAIN_DETAIL_LEVEL"),
    }


async def _universe_snapshot(session: AsyncSession, project: Project) -> dict[str, object] | None:
    if project.universe_id is None:
        return None
    universe = await session.get(Universe, project.universe_id)
    if universe is None:
        return None

    universe_id_col = cast(
        InstrumentedAttribute[int], cast(object, SharedCharacter.universe_id)
    )
    active_col = cast(InstrumentedAttribute[bool], cast(object, SharedCharacter.is_active))
    shared = (
        await session.execute(
            select(SharedCharacter).where(
                universe_id_col == project.universe_id,
                active_col.is_(True),
            )
        )
    ).scalars().all()

    project_universe_col = cast(InstrumentedAttribute[int | None], cast(object, Project.universe_id))
    project_id_col = cast(InstrumentedAttribute[int], cast(object, Project.id))
    siblings = (
        await session.execute(
            select(Project)
            .where(project_universe_col == project.universe_id)
            .where(project_id_col != project.id)
            .order_by(Project.chapter_number.asc(), Project.id.asc())  # type: ignore[union-attr]
            .limit(20)
        )
    ).scalars().all()

    return {
        "id": universe.id,
        "name": universe.name,
        "description": universe.description,
        "world_setting": universe.world_setting,
        "style_rules": universe.style_rules,
        "revision": universe.updated_at.isoformat(),
        "shared_characters": [
            {
                "id": item.id,
                "name": item.name,
                "description": item.description,
                "visual_notes": item.visual_notes,
                "reference_images": list(item.reference_images or []),
                "canonical_image_url": item.canonical_image_url,
                "version": item.version,
            }
            for item in shared
        ],
        "sibling_chapters": [
            {
                "id": item.id,
                "chapter_number": item.chapter_number,
                "chapter_title": item.chapter_title,
                "title": item.title,
                "summary": item.summary,
                "story_outline": item.story_outline,
                "status": item.status,
            }
            for item in siblings
        ],
    }


async def _style_snapshot(session: AsyncSession, project: Project) -> dict[str, object] | None:
    slug_col = cast(InstrumentedAttribute[str], cast(object, StyleTemplate.slug))
    result = await session.execute(select(StyleTemplate).where(slug_col == project.style).limit(1))
    style = result.scalars().first()
    if style is None:
        return None
    return {
        "id": style.id,
        "slug": style.slug,
        "name": style.name,
        "style_prompt": style.style_prompt,
        "negative_prompt": style.negative_prompt,
        "color_palette": list(style.color_palette or []),
        "revision": style.updated_at.isoformat(),
    }


async def build_run_context_snapshot(
    *,
    session: AsyncSession,
    settings: Settings,
    project: Project,
    provider_resolution: ProviderResolution,
) -> dict[str, Any]:
    provider_config = await _effective_provider_config(session, settings)
    skill = get_skill(project.skill_id)

    text_key = provider_resolution.text.resolved_key
    image_key = provider_resolution.image.resolved_key
    video_key = provider_resolution.video.resolved_key

    text: dict[str, object | None] = {"provider": text_key}
    if text_key == "anthropic":
        text.update(
            base_url=provider_config["ANTHROPIC_BASE_URL"],
            model=provider_config["ANTHROPIC_MODEL"],
            credential_keys=["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
        )
    elif text_key == "openai":
        text.update(
            base_url=provider_config["TEXT_BASE_URL"],
            model=provider_config["TEXT_MODEL"],
            endpoint=provider_config["TEXT_ENDPOINT"],
            credential_keys=["TEXT_API_KEY"],
        )
    else:
        text.update(model="fake", credential_keys=[])

    image: dict[str, object | None] = {
        "provider": image_key,
        "base_url": provider_config["IMAGE_BASE_URL"],
        "model": provider_config["IMAGE_MODEL"],
        "endpoint": provider_config["IMAGE_ENDPOINT"],
        "enable_image_to_image": provider_config["ENABLE_IMAGE_TO_IMAGE"],
        "credential_keys": [] if image_key == "fake" else ["IMAGE_API_KEY"],
    }
    video: dict[str, object | None] = {
        "provider": video_key,
        "base_url": provider_config["VIDEO_BASE_URL"],
        "model": (
            provider_config["DOUBAO_VIDEO_MODEL"]
            if video_key == "doubao"
            else provider_config["VIDEO_MODEL"]
        ),
        "endpoint": provider_config["VIDEO_ENDPOINT"],
        "video_mode": provider_config["VIDEO_MODE"],
        "enable_image_to_video": provider_config["ENABLE_IMAGE_TO_VIDEO"],
        "duration": provider_config["DOUBAO_VIDEO_DURATION"] if video_key == "doubao" else None,
        "ratio": provider_config["DOUBAO_VIDEO_RATIO"] if video_key == "doubao" else None,
        "credential_keys": [] if video_key == "fake" else [
            "DOUBAO_API_KEY" if video_key == "doubao" else "VIDEO_API_KEY"
        ],
    }

    return {
        "workflow_version": WORKFLOW_VERSION,
        "project": {
            "id": project.id,
            "title": project.title,
            "story": project.story,
            "style": project.style,
            "summary": project.summary,
            "target_shot_count": project.target_shot_count,
            "character_hints": list(project.character_hints or []),
            "creation_mode": project.creation_mode,
            "reference_images": list(project.reference_images or []),
            "skill_id": project.skill_id,
            "revision": project.updated_at.isoformat(),
        },
        "providers": {"text": text, "image": image, "video": video},
        "policy": {
            "critique_enabled": provider_config["CRITIQUE_ENABLED"],
            "critique_score_threshold": provider_config["CRITIQUE_SCORE_THRESHOLD"],
            "critique_max_rounds": provider_config["CRITIQUE_MAX_ROUNDS"],
            "thinking_chain_enabled": provider_config["THINKING_CHAIN_ENABLED"],
            "thinking_chain_detail_level": provider_config["THINKING_CHAIN_DETAIL_LEVEL"],
            "tts_enabled": provider_config["TTS_ENABLED"],
            "bgm_enabled": provider_config["BGM_ENABLED"],
        },
        "skill": (
            {
                "id": skill.id,
                "title": skill.title,
                "directives": skill.directives,
                "pipeline_hints": skill.pipeline_hints,
                "start_stage": skill.start_stage,
                "start_agent": skill.start_agent,
            }
            if skill is not None
            else None
        ),
        "universe_context": await _universe_snapshot(session, project),
        "style_template": await _style_snapshot(session, project),
    }
