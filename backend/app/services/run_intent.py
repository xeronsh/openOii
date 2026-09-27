"""Shape durable rerun intent; downstream invalidation belongs to Engine."""

from __future__ import annotations

from typing import Literal, TypedDict

EntityType = Literal["character", "shot"]


class RerunScope(TypedDict):
    entity_type: EntityType | None
    entity_ids: list[int]


class RerunIntent(TypedDict):
    version: int
    start_stage: str
    scope: RerunScope


def _normalize_scope(
    entity_type: str | None,
    entity_id: int | None,
    entity_ids: list[int] | None,
) -> RerunScope:
    normalized_type: EntityType | None = (
        entity_type if entity_type in {"character", "shot"} else None
    )
    ids = [value for value in entity_ids or [] if value > 0]
    if entity_id is not None and entity_id > 0:
        ids.append(entity_id)
    if normalized_type is None:
        ids = []
    return {"entity_type": normalized_type, "entity_ids": list(dict.fromkeys(ids))}


def build_rerun_intent(
    *,
    start_stage: str,
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_ids: list[int] | None = None,
) -> RerunIntent:
    return {
        "version": 1,
        "start_stage": start_stage,
        "scope": _normalize_scope(entity_type, entity_id, entity_ids),
    }
