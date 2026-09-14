from __future__ import annotations

import pytest

from app.orchestration import workflow_progress_for_stage, PRODUCTION_STAGE_SEQUENCE


TOTAL = len(PRODUCTION_STAGE_SEQUENCE)


def test_unknown_stage_returns_zero():
    assert workflow_progress_for_stage("nonexistent") == 0.0


def test_first_stage_zero_within():
    assert workflow_progress_for_stage("plan_outline") == 0.0


def test_first_stage_full_within():
    result = workflow_progress_for_stage("plan_outline", within_stage=1.0)
    assert result == pytest.approx(1.0 / TOTAL)


def test_last_stage_zero_within():
    # add_audio was removed: compose_merge is the final production stage.
    result = workflow_progress_for_stage(PRODUCTION_STAGE_SEQUENCE[-1])
    assert result == pytest.approx((TOTAL - 1) / TOTAL)


def test_last_stage_full_within():
    result = workflow_progress_for_stage(PRODUCTION_STAGE_SEQUENCE[-1], within_stage=1.0)
    assert result == 1.0


def test_mid_stage():
    # render_characters is at index 3 in PRODUCTION_STAGE_SEQUENCE
    idx = PRODUCTION_STAGE_SEQUENCE.index("render_characters")
    result = workflow_progress_for_stage("render_characters", within_stage=0.5)
    assert result == pytest.approx((idx + 0.5) / TOTAL)


def test_within_stage_clamped_above():
    result = workflow_progress_for_stage("plan_outline", within_stage=2.0)
    assert result == pytest.approx(1.0 / TOTAL)


def test_within_stage_clamped_below():
    result = workflow_progress_for_stage("plan_outline", within_stage=-0.5)
    assert result == 0.0
