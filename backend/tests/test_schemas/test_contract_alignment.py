"""FE/BE contract guards — keep HTTP + WS payloads from drifting silently."""

from __future__ import annotations

from app.api.v1.routes.skills import SkillRead
from app.schemas.project import (
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
)
from app.schemas.universe import ImportSharedCastRead, UniverseTimelineRead
from app.schemas.ws import DataClearedEventData, ProjectUpdatedPayload, WsEventType
from app.skills.catalog import list_skills


def test_project_create_update_share_skill_id():
    assert "skill_id" in ProjectCreate.model_fields
    assert "skill_id" in ProjectUpdate.model_fields
    assert "skill_id" in ProjectRead.model_fields


def test_data_cleared_event_preserves_rerun_metadata():
    payload = DataClearedEventData.model_validate(
        {
            "cleared_types": ["characters", "shots"],
            "start_agent": "plan",
            "mode": "full",
        }
    )
    dumped = payload.model_dump()
    assert dumped["cleared_types"] == ["characters", "shots"]
    assert dumped["start_agent"] == "plan"
    assert dumped["mode"] == "full"


def test_project_updated_payload_includes_skill_id():
    assert "skill_id" in ProjectUpdatedPayload.model_fields


def test_ws_event_types_cover_core_run_lifecycle():
    required = {
        "run_started",
        "run_progress",
        "run_message",
        "run_awaiting_confirm",
        "run_confirmed",
        "run_completed",
        "run_failed",
        "run_cancelled",
        "data_cleared",
        "project_updated",
    }
    assert required.issubset(set(WsEventType.__args__))


def test_skill_catalog_surface_is_three_core_workflows():
    skills = list_skills()
    assert {s.id for s in skills} == {
        "story-anime",
        "character-design",
        "quick-short",
    }
    # Skill API schema exposes the fields FE maps in skillFromApi
    required = {
        "id",
        "title",
        "description",
        "story_template",
        "directives",
        "pipeline_hints",
        "placeholder",
        "prefer_auto_mode",
        "default_style",
        "default_creation_mode",
        "default_target_shot_count",
    }
    assert required.issubset(set(SkillRead.model_fields))


def test_universe_timeline_and_import_cast_contracts():
    assert "chapters" in UniverseTimelineRead.model_fields
    assert "shared_character_count" in UniverseTimelineRead.model_fields
    assert "imported_count" in ImportSharedCastRead.model_fields
    assert "skipped_existing" in ImportSharedCastRead.model_fields
