from __future__ import annotations

from typing import Literal


Phase2Stage = Literal[
    "plan_outline",
    "outline_approval",
    "plan_characters",
    "characters_approval",
    "plan_shots",
    "shots_approval",
    "render_characters",
    "character_images_approval",
    "critique_character_images",
    "render_shots",
    "shot_images_approval",
    "critique_shot_images",
    "compose_videos",
    "compose_merge",
    "add_audio",
    "compose_approval",
    "review",
]

# Full gate-inclusive stage order (production + approval + critique).
# Canonical: engine/src/contract.ts NEXT_STAGE mirrors this.
PHASE2_STAGE_ORDER: tuple[str, ...] = (
    "plan_outline",
    "outline_approval",
    "plan_characters",
    "characters_approval",
    "plan_shots",
    "shots_approval",
    "render_characters",
    "character_images_approval",
    "critique_character_images",
    "render_shots",
    "shot_images_approval",
    "critique_shot_images",
    "compose_videos",
    "compose_merge",
    "add_audio",
    "compose_approval",
    "review",
)

# Ordered sequence of production stages (excludes approval gates).
PRODUCTION_STAGE_SEQUENCE: tuple[str, ...] = (
    "plan_outline",
    "plan_characters",
    "plan_shots",
    "render_characters",
    "render_shots",
    "compose_videos",
    "compose_merge",
    "add_audio",
)


# Approval gate → the production stage it comes right after
_APPROVAL_TO_PRODUCED_STAGE: dict[str, str] = {
    "outline_approval": "plan_outline",
    "characters_approval": "plan_characters",
    "shots_approval": "plan_shots",
    "character_images_approval": "render_characters",
    "shot_images_approval": "render_shots",
    "compose_approval": "add_audio",
}

_CRITIQUE_TO_PRODUCED_STAGE: dict[str, str] = {
    "critique_character_images": "render_characters",
    "critique_shot_images": "render_shots",
}


def _resolve_base_stage(stage: str) -> str | None:
    """Map any stage (production or approval or critique) to its production stage."""
    if stage in PRODUCTION_STAGE_SEQUENCE:
        return stage
    base = _APPROVAL_TO_PRODUCED_STAGE.get(stage)
    if base is not None:
        return base
    return _CRITIQUE_TO_PRODUCED_STAGE.get(stage)


def next_production_stage(stage: str | None) -> str | None:
    if not isinstance(stage, str):
        return None
    base = _resolve_base_stage(stage)
    if base is None:
        return None
    next_index = PRODUCTION_STAGE_SEQUENCE.index(base) + 1
    if next_index >= len(PRODUCTION_STAGE_SEQUENCE):
        return None
    return PRODUCTION_STAGE_SEQUENCE[next_index]


def workflow_progress_for_stage(stage: str, *, within_stage: float = 0.0) -> float:
    base = _resolve_base_stage(stage)
    if base is None:
        return 0.0

    clamped_within = max(0.0, min(within_stage, 1.0))
    stage_index = PRODUCTION_STAGE_SEQUENCE.index(base)
    total = len(PRODUCTION_STAGE_SEQUENCE)
    return min((stage_index + clamped_within) / total, 1.0)


