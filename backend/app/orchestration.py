from __future__ import annotations

from app.generated.workflow_contract import (
    APPROVAL_TO_PRODUCED_STAGE,
    CRITIQUE_TO_PRODUCED_STAGE,
    GATE_AGENT,
    GRAPH_STAGE_FOR_AGENT,
    NEXT_STAGE,
    PHASE2_STAGE_ORDER,
    PRODUCTION_STAGE_SEQUENCE,
    STAGE_AGENT_MAP,
    STAGE_TO_UI,
    WORKFLOW_VERSION,
    StageId,
)

# Backward-compatible domain name used by skills/tests. The actual literal
# union is generated from contracts/workflow.json.
Phase2Stage = StageId

# Historical private names kept only for callers/tests that imported them.
_APPROVAL_TO_PRODUCED_STAGE = APPROVAL_TO_PRODUCED_STAGE
_CRITIQUE_TO_PRODUCED_STAGE = CRITIQUE_TO_PRODUCED_STAGE


def _resolve_base_stage(stage: str) -> str | None:
    """Map any stage (production, approval or critique) to its production stage."""
    if stage in PRODUCTION_STAGE_SEQUENCE:
        return stage
    base = APPROVAL_TO_PRODUCED_STAGE.get(stage)
    if base is not None:
        return base
    return CRITIQUE_TO_PRODUCED_STAGE.get(stage)


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


__all__ = [
    "APPROVAL_TO_PRODUCED_STAGE",
    "CRITIQUE_TO_PRODUCED_STAGE",
    "GATE_AGENT",
    "GRAPH_STAGE_FOR_AGENT",
    "NEXT_STAGE",
    "PHASE2_STAGE_ORDER",
    "PRODUCTION_STAGE_SEQUENCE",
    "Phase2Stage",
    "STAGE_AGENT_MAP",
    "STAGE_TO_UI",
    "WORKFLOW_VERSION",
    "StageId",
    "next_production_stage",
    "workflow_progress_for_stage",
]
