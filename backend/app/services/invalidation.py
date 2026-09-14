"""Deterministic feedback invalidation policy.

The review model may classify intent and choose a workflow boundary, but it does
not own destructive persistence decisions. This module maps that boundary plus
explicit UI entity bindings to a durable, auditable plan.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from app.orchestration import PHASE2_STAGE_ORDER

EntityType = Literal["character", "shot"]


class InvalidationScope(TypedDict):
    entity_type: EntityType | None
    entity_ids: list[int]


class InvalidationPlan(TypedDict):
    version: int
    start_stage: str
    checkpoint_from: str
    scope: InvalidationScope
    invalidates: list[str]


_INVALIDATES_BY_STAGE: dict[str, tuple[str, ...]] = {
    "plan_outline": (
        "project.outline",
        "characters.definitions",
        "characters.images",
        "shots.definitions",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "outline_approval": (
        "characters.definitions",
        "characters.images",
        "shots.definitions",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "plan_characters": (
        "characters.definitions",
        "characters.images",
        "shots.definitions",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "plan_shots": (
        "shots.definitions",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "plan_approval": (
        "characters.images",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "render_characters": (
        "characters.images",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "critique_character_images": (
        "characters.images",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "character_images_approval": (
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "render_shots": (
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "critique_shot_images": (
        "shots.images",
        "shots.videos",
        "project.final_video",
    ),
    "shot_images_approval": (
        "shots.videos",
        "project.final_video",
    ),
    "compose_videos": ("shots.videos", "project.final_video"),
    "compose_merge": ("project.final_video",),
    "compose_approval": ("project.final_video",),
}


def _normalize_scope(
    entity_type: str | None,
    entity_id: int | None,
    entity_ids: list[int] | None,
) -> InvalidationScope:
    normalized_type: EntityType | None = (
        entity_type if entity_type in {"character", "shot"} else None
    )
    ids: list[int] = []
    if entity_ids:
        ids.extend(value for value in entity_ids if isinstance(value, int) and value > 0)
    if entity_id is not None and entity_id > 0:
        ids.append(entity_id)
    ids = list(dict.fromkeys(ids))
    if normalized_type is None:
        ids = []
    return {"entity_type": normalized_type, "entity_ids": ids}


def build_invalidation_plan(
    *,
    start_stage: str,
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_ids: list[int] | None = None,
) -> InvalidationPlan:
    """Return the deterministic downstream invalidation plan for one rerun.

    Unknown stages are deliberately promoted to a full outline rerun rather than
    allowing an unrecognized model value to bypass dependencies.
    """
    canonical_stage = start_stage if start_stage in PHASE2_STAGE_ORDER else "plan_outline"
    return {
        "version": 1,
        "start_stage": canonical_stage,
        "checkpoint_from": canonical_stage,
        "scope": _normalize_scope(entity_type, entity_id, entity_ids),
        "invalidates": list(_INVALIDATES_BY_STAGE.get(canonical_stage, _INVALIDATES_BY_STAGE["plan_outline"])),
    }
