from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import pytest

from app.schemas.export import ExportCompletedEventData
from app.schemas.ws import (
    AgentThinkingEventData,
    AudioGeneratedEventData,
    BibleUpdatedEventData,
    CharacterCreatedEventData,
    CharacterDeletedEventData,
    CharacterUpdatedEventData,
    ConsistencyEvalCompletedEventData,
    CritiqueResultEventData,
    DataClearedEventData,
    ErrorEventData,
    OutlineUpdatedEventData,
    ProjectUpdatedEventData,
    RunAwaitingConfirmEventData,
    RunCancelledEventData,
    RunCompletedEventData,
    RunConfirmedEventData,
    RunFailedEventData,
    RunMessageEventData,
    RunProgressEventData,
    RunStartedEventData,
    ShotCreatedEventData,
    ShotDeletedEventData,
    ShotsReorderedEventData,
    ShotUpdatedEventData,
    VersionCreatedEventData,
    VersionRollbackEventData,
    WsEventType,
    WsEvent,
)
from app.ws.manager import _EVENT_DATA_MODELS

CHARACTER_DATA = {
    "id": 1,
    "project_id": 1,
    "name": "Alice",
    "description": "hero",
    "image_url": None,
    "approval_state": "draft",
    "approval_version": 0,
    "approved_at": None,
    "approved_name": None,
    "approved_description": None,
    "approved_image_url": None,
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-01-01T00:00:00Z",
}

SHOT_DATA = {
    "id": 1,
    "project_id": 1,
    "order": 1,
    "shot_order": 1,
    "description": "Opening",
    "prompt": "A scene",
    "image_prompt": "A scene",
    "image_url": None,
    "video_url": None,
    "duration": 3.0,
    "camera": "medium",
    "motion_note": "pan left",
    "scene": None,
    "action": None,
    "expression": None,
    "lighting": None,
    "dialogue": None,
    "sfx": None,
    "character_ids": [],
    "approval_state": "draft",
    "approval_version": 0,
    "approved_at": None,
    "approved_description": None,
    "approved_prompt": None,
    "approved_image_prompt": None,
    "approved_duration": None,
    "approved_camera": None,
    "approved_motion_note": None,
    "approved_scene": None,
    "approved_action": None,
    "approved_expression": None,
    "approved_lighting": None,
    "approved_dialogue": None,
    "approved_sfx": None,
    "approved_character_ids": [],
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-01-01T00:00:00Z",
}

RECOVERY_SUMMARY_DATA = {
    "project_id": 1,
    "run_id": 1,
    "current_stage": "plan",
    "active_run": {
        "id": 1,
        "status": "running",
        "current_agent": "plan",
        "current_stage": "plan",
        "progress": 0.5,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z",
    },
    "preserved_stages": ["plan"],
    "next_stage": "character",
    "completed_stages": ["plan"],
}

class TestWsEventSchemaRegistry:
    def test_all_event_types_have_data_models(self):
        all_types = get_args(WsEventType)
        for etype in all_types:
            if etype in ("connected", "pong", "echo"):
                continue
            assert etype in _EVENT_DATA_MODELS, f"{etype} missing from _EVENT_DATA_MODELS"

    def test_backend_and_frontend_ws_event_type_unions_match(self):
        frontend_types = _frontend_ws_event_types()
        backend_types = set(get_args(WsEventType))
        assert frontend_types == backend_types

    @pytest.mark.parametrize(
        ("event_type", "model"),
        [
            ("run_started", RunStartedEventData),
            ("run_progress", RunProgressEventData),
            ("run_message", RunMessageEventData),
            ("agent_thinking", AgentThinkingEventData),
            ("run_completed", RunCompletedEventData),
            ("run_failed", RunFailedEventData),
            ("run_awaiting_confirm", RunAwaitingConfirmEventData),
            ("run_confirmed", RunConfirmedEventData),
            ("run_cancelled", RunCancelledEventData),
            ("character_created", CharacterCreatedEventData),
            ("character_updated", CharacterUpdatedEventData),
            ("character_deleted", CharacterDeletedEventData),
            ("shot_created", ShotCreatedEventData),
            ("shot_updated", ShotUpdatedEventData),
            ("shots_reordered", ShotsReorderedEventData),
            ("shot_deleted", ShotDeletedEventData),
            ("outline_updated", OutlineUpdatedEventData),
            ("project_updated", ProjectUpdatedEventData),
            ("data_cleared", DataClearedEventData),
            ("error", ErrorEventData),
            ("critique_result", CritiqueResultEventData),
            ("bible_updated", BibleUpdatedEventData),
            ("version_created", VersionCreatedEventData),
            ("version_rollback", VersionRollbackEventData),
            ("audio_generated", AudioGeneratedEventData),
            ("export_completed", ExportCompletedEventData),
            ("consistency_eval_completed", ConsistencyEvalCompletedEventData),
        ],
    )
    def test_event_registry_points_to_expected_schema(self, event_type, model):
        assert _EVENT_DATA_MODELS[event_type] is model

def _frontend_ws_event_types() -> set[str]:
    types_file = Path(__file__).resolve().parents[3] / "frontend" / "app" / "types" / "index.ts"
    text = types_file.read_text()
    match = re.search(
        r"export\s+type\s+WsEventType\s*=\s*(?P<body>.*?);",
        text,
        flags=re.DOTALL,
    )
    assert match is not None, "frontend WsEventType union not found"
    return set(re.findall(r'"([^"]+)"', match.group("body")))

class TestRunStartedEventData:
    def test_valid_full(self):
        d = RunStartedEventData.model_validate(
            {
                "run_id": 1,
                "project_id": 10,
                "provider_snapshot": {"text": "openai"},
                "current_stage": "plan",
                "stage": "plan",
                "next_stage": "character",
                "progress": 0.1,
                "current_agent": "plan",
            }
        )
        assert d.run_id == 1
        assert d.current_agent == "plan"

    def test_minimal(self):
        d = RunStartedEventData.model_validate({"run_id": 5})
        assert d.progress == 0.0
        assert d.provider_snapshot is None

    def test_with_recovery_summary(self):
        d = RunStartedEventData.model_validate(
            {
                "run_id": 1,
                "recovery_summary": RECOVERY_SUMMARY_DATA,
                "preserved_stages": ["plan"],
            }
        )
        assert d.recovery_summary is not None
        assert d.preserved_stages == ["plan"]

    def test_recovery_summary_optional(self):
        d = RunStartedEventData.model_validate({"run_id": 1})
        assert d.recovery_summary is None
        assert d.preserved_stages == []

class TestRunProgressEventData:
    def test_valid(self):
        d = RunProgressEventData.model_validate(
            {
                "run_id": 1,
                "progress": 0.5,
                "current_agent": "plan",
                "current_stage": "character",
                "stage": "character",
            }
        )
        assert d.progress == 0.5

    def test_progress_bounds(self):
        with pytest.raises(Exception):
            RunProgressEventData.model_validate({"run_id": 1, "progress": 1.5})

class TestRunMessageEventData:
    def test_with_summary(self):
        d = RunMessageEventData.model_validate(
            {
                "agent": "plan",
                "content": "hello",
                "summary": "brief",
                "isLoading": True,
            }
        )
        assert d.summary == "brief"
        assert d.isLoading is True

    def test_minimal(self):
        d = RunMessageEventData.model_validate({})
        assert d.content == ""
        assert d.summary is None

class TestRunCompletedEventData:
    def test_with_current_stage_and_agent(self):
        d = RunCompletedEventData.model_validate(
            {
                "run_id": 1,
                "project_id": 10,
                "current_stage": "compose",
                "current_agent": "compose",
                "message": "done",
            }
        )
        assert d.current_stage == "compose"
        assert d.current_agent == "compose"
        assert d.project_id == 10

    def test_minimal(self):
        d = RunCompletedEventData.model_validate({})
        assert d.run_id is None

class TestRunFailedEventData:
    def test_valid(self):
        d = RunFailedEventData.model_validate(
            {
                "run_id": 1,
                "error": "boom",
                "agent": "plan",
                "current_stage": "character",
            }
        )
        assert d.error == "boom"

    def test_minimal(self):
        d = RunFailedEventData.model_validate({})
        assert d.run_id is None

class TestRunCancelledEventData:
    def test_project_level(self):
        d = RunCancelledEventData.model_validate(
            {
                "project_id": 1,
                "cancelled_count": 2,
                "run_ids": [10, 11],
            }
        )
        assert d.run_ids == [10, 11]

    def test_single_resource(self):
        d = RunCancelledEventData.model_validate({"run_id": 5})
        assert d.run_id == 5
        assert d.run_ids is None

class TestDataClearedEventData:
    def test_keeps_start_agent_and_mode(self):
        d = DataClearedEventData.model_validate(
            {
                "cleared_types": ["shots"],
                "start_agent": "render",
                "mode": "incremental",
            }
        )
        assert d.start_agent == "render"
        assert d.mode == "incremental"

    def test_with_cleared_types(self):
        d = DataClearedEventData.model_validate(
            {
                "cleared_types": ["characters", "shots"],
            }
        )
        assert d.cleared_types == ["characters", "shots"]

    def test_cleared_types_default_empty(self):
        d = DataClearedEventData.model_validate({})
        assert d.cleared_types == []

    def test_minimal(self):
        d = DataClearedEventData.model_validate({})
        assert d.cleared_types == []

class TestErrorEventData:
    def test_valid(self):
        d = ErrorEventData.model_validate(
            {
                "code": "WS_INVALID_RUN",
                "message": "无效的 run_id",
            }
        )
        assert d.code == "WS_INVALID_RUN"
        assert d.message == "无效的 run_id"

    def test_required_fields(self):
        with pytest.raises(Exception):
            ErrorEventData.model_validate({"code": "X"})
        with pytest.raises(Exception):
            ErrorEventData.model_validate({"message": "Y"})

class TestRunAwaitingConfirmEventData:
    def test_valid(self):
        d = RunAwaitingConfirmEventData.model_validate(
            {
                "run_id": 1,
                "agent": "director",
                "recovery_summary": RECOVERY_SUMMARY_DATA,
            }
        )
        assert d.agent == "director"
        assert d.recovery_summary is not None
        assert d.auto_mode is None

    def test_auto_mode_true(self):
        d = RunAwaitingConfirmEventData.model_validate(
            {
                "run_id": 1,
                "agent": "plan",
                "recovery_summary": RECOVERY_SUMMARY_DATA,
                "auto_mode": True,
            }
        )
        assert d.auto_mode is True

class TestRunConfirmedEventData:
    def test_valid(self):
        d = RunConfirmedEventData.model_validate(
            {
                "run_id": 1,
                "agent": "director",
            }
        )
        assert d.agent == "director"
        assert d.auto_mode is None

    def test_minimal_with_run_id(self):
        d = RunConfirmedEventData.model_validate({"run_id": 1, "agent": "x"})
        assert d.recovery_summary is None

    def test_auto_mode_true(self):
        d = RunConfirmedEventData.model_validate(
            {
                "run_id": 1,
                "agent": "plan",
                "auto_mode": True,
            }
        )
        assert d.auto_mode is True

class TestCharacterCreatedEventData:
    def test_valid(self):
        d = CharacterCreatedEventData.model_validate({"character": CHARACTER_DATA})
        assert d.character.name == "Alice"

class TestCharacterDeletedEventData:
    def test_valid(self):
        d = CharacterDeletedEventData.model_validate({"character_id": 5})
        assert d.character_id == 5

class TestShotCreatedEventData:
    def test_valid(self):
        d = ShotCreatedEventData.model_validate({"shot": SHOT_DATA})
        assert d.shot.order == 1

class TestShotsReorderedEventData:
    def test_valid(self):
        d = ShotsReorderedEventData.model_validate(
            {"project_id": 1, "shots": [SHOT_DATA, {**SHOT_DATA, "id": 2, "order": 2}]}
        )
        assert d.project_id == 1
        assert [shot.order for shot in d.shots] == [1, 2]

class TestShotDeletedEventData:
    def test_valid(self):
        d = ShotDeletedEventData.model_validate({"shot_id": 3})
        assert d.shot_id == 3

class TestProjectUpdatedEventData:
    def test_valid(self):
        d = ProjectUpdatedEventData.model_validate(
            {
                "project": {
                    "id": 1,
                    "title": "Test",
                    "video_url": "http://example.com/video.mp4",
                    "status": "completed",
                    "exports": ["/static/exports/story.pdf"],
                    "universe_id": 7,
                    "chapter_number": 2,
                    "chapter_title": "第二章",
                    "blocking_clips": [
                        {"shot_id": 1, "order": 1, "status": "blocked", "reason": "missing"}
                    ],
                },
            }
        )
        assert d.project.video_url == "http://example.com/video.mp4"
        assert d.project.exports == ["/static/exports/story.pdf"]
        assert d.project.universe_id == 7
        assert d.project.chapter_number == 2
        assert d.project.chapter_title == "第二章"
        assert d.project.blocking_clips is not None and len(d.project.blocking_clips) == 1

    def test_minimal(self):
        d = ProjectUpdatedEventData.model_validate({"project": {"id": 1}})
        assert d.project.title is None
        assert d.project.blocking_clips is None

class TestWsEventValidation:
    def test_send_event_validates_run_started(self):
        event = {"type": "run_started", "data": {"run_id": 1, "current_agent": "x"}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["run_started"]
        d = model.model_validate(validated.data)
        assert d.run_id == 1

    def test_send_event_validates_run_message(self):
        event = {"type": "run_message", "data": {"content": "hi", "summary": "s"}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["run_message"]
        d = model.model_validate(validated.data)
        assert d.summary == "s"

    def test_send_event_validates_data_cleared(self):
        event = {"type": "data_cleared", "data": {"cleared_types": ["shots"]}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["data_cleared"]
        d = model.model_validate(validated.data)
        assert d.cleared_types == ["shots"]

    def test_send_event_validates_error(self):
        event = {"type": "error", "data": {"code": "E_TEST", "message": "test error"}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["error"]
        d = model.model_validate(validated.data)
        assert d.code == "E_TEST"

    def test_send_event_validates_character_created(self):
        event = {"type": "character_created", "data": {"character": CHARACTER_DATA}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["character_created"]
        d = model.model_validate(validated.data)
        assert d.character.name == "Alice"

    def test_send_event_validates_shot_deleted(self):
        event = {"type": "shot_deleted", "data": {"shot_id": 7}}
        validated = WsEvent.model_validate(event)
        model = _EVENT_DATA_MODELS["shot_deleted"]
        d = model.model_validate(validated.data)
        assert d.shot_id == 7

    def test_unknown_event_type_passes_without_validation(self):
        event = {"type": "connected", "data": {"any": "thing"}}
        validated = WsEvent.model_validate(event)
        assert _EVENT_DATA_MODELS.get(validated.type) is None
