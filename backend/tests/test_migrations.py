from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlmodel import SQLModel

from app.models import agent_run, artifact_version, config_item, consistency_report, message, project, style_template  # noqa: F401
from app.models.universe import SharedCharacter, Universe, UniverseProjectLink  # noqa: F401

def _backend_root() -> Path:
    return Path(__file__).resolve().parents[1]

@pytest.fixture(autouse=True)
def _explicit_alembic_url(monkeypatch):
    """These tests pass explicit URLs via sqlalchemy.url; conftest's global
    DATABASE_URL sandbox must not shadow them (alembic/env.py prefers env)."""
    monkeypatch.delenv("DATABASE_URL", raising=False)

def _alembic_config(db_url: str) -> Config:
    config = Config(str(_backend_root() / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", db_url)
    config.set_main_option("script_location", str(_backend_root() / "alembic"))
    return config

def test_alembic_upgrade_head_rebuilds_blank_database(tmp_path: Path) -> None:
    db_path = tmp_path / "phase1-migration.db"
    db_path.unlink(missing_ok=True)

    db_url = f"sqlite+pysqlite:///{db_path}"
    command.upgrade(_alembic_config(db_url), "head")

    engine = create_engine(db_url)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
    finally:
        engine.dispose()

    expected_tables = {
        "agentrun",
        "agentmessage",
        "artifactversion",
        "chat_message",
        "asset",
        "character",
        "configitem",
        "consistency_report",
        "engine_checkpoints",
        "engine_run_events",
        "engine_stage_attempts",
        "exportcache",
        "message",
        "media_object",
        "project",
        "shot",
        "shot_character_binding",
        "style_template",
        "universe",
        "sharedcharacter",
        "universeprojectlink",
        "alembic_version",
    }

    assert tables == expected_tables

    column_engine = create_engine(db_url)
    try:
        inspector = inspect(column_engine)
        project_columns = {column["name"] for column in inspector.get_columns("project")}
        attempt_columns = {
            column["name"] for column in inspector.get_columns("engine_stage_attempts")
        }
    finally:
        column_engine.dispose()
    assert {
        "text_provider_override",
        "image_provider_override",
        "video_provider_override",
        "story_outline",
        "visual_bible",
        "outline_approved",
        "revision",
    }.issubset(project_columns)
    # `inspector` is disposed above; re-inspect for the revision contract.
    rev_engine = create_engine(db_url)
    try:
        rev_inspector = inspect(rev_engine)
        for table in ("project", "character", "shot"):
            columns = {column["name"] for column in rev_inspector.get_columns(table)}
            assert "revision" in columns, f"{table} is missing the optimistic-concurrency revision"
        assert "thread_id" not in {
            column["name"] for column in rev_inspector.get_columns("agentrun")
        }
    finally:
        rev_engine.dispose()
    assert {
        "stage_attempt_id",
        "run_id",
        "attempt",
        "input_hash",
        "input_snapshot",
        "idempotency_key",
        "status",
        "finished_at",
    }.issubset(attempt_columns)


def test_run_timing_migration_backfills_existing_runs(tmp_path: Path) -> None:
    """0030: a run starts at its first stage attempt; a finished attempt ended at its last update."""
    from sqlalchemy import text

    db_url = f"sqlite+pysqlite:///{tmp_path / 'timing.db'}"
    command.upgrade(_alembic_config(db_url), "0029_agentrun_gate_feedback")
    engine = create_engine(db_url)
    try:
        with engine.begin() as conn:
            for run_id, status in ((1, "succeeded"), (2, "succeeded"), (3, "queued")):
                conn.execute(
                    text(
                        "INSERT INTO agentrun (id, project_id, status, progress, confirm_requested, workflow_version, "
                        "execution_attempt, created_at, updated_at) VALUES (:id, 1, :status, 0, 0, 2, 0, "
                        "'2026-10-29 10:00:00.000000', '2026-10-29 10:30:00.000000')"
                    ),
                    {"id": run_id, "status": status},
                )
            for attempt_id, stage, status, started, updated in (
                ("a", "plan_outline", "succeeded", "2026-10-29T10:00:05.000Z", "2026-10-29T10:01:05.000Z"),
                ("b", "plan_characters", "started", "2026-10-29T10:02:00.000Z", "2026-10-29T10:02:30.000Z"),
            ):
                conn.execute(
                    text(
                        "INSERT INTO engine_stage_attempts (stage_attempt_id, run_id, stage, attempt, execution_attempt, "
                        "input_hash, idempotency_key, status, started_at, updated_at) "
                        "VALUES (:id, 1, :stage, 1, 0, 'h', :id, :status, :started, :updated)"
                    ),
                    {"id": attempt_id, "stage": stage, "status": status, "started": started, "updated": updated},
                )
    finally:
        engine.dispose()

    command.upgrade(_alembic_config(db_url), "head")

    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            runs = dict(conn.execute(text("SELECT id, started_at FROM agentrun")).all())
            finished = dict(conn.execute(text("SELECT stage_attempt_id, finished_at FROM engine_stage_attempts")).all())
    finally:
        engine.dispose()
    assert runs[1] == "2026-10-29 10:00:05.000"  # first attempt, naive UTC like the backend writes
    assert runs[2] == "2026-10-29 10:00:00.000000"  # no attempts: fall back to created_at
    assert runs[3] is None  # still queued: has not started
    assert finished == {"a": "2026-10-29T10:01:05.000Z", "b": None}

def test_alembic_stamp_adopts_existing_create_all_database(tmp_path: Path) -> None:
    db_path = tmp_path / "phase1-existing.db"
    db_path.unlink(missing_ok=True)

    db_url = f"sqlite+pysqlite:///{db_path}"
    engine = create_engine(db_url)
    try:
        SQLModel.metadata.create_all(engine)
    finally:
        engine.dispose()

    command.stamp(_alembic_config(db_url), "head")
    command.upgrade(_alembic_config(db_url), "head")

    stamped_engine = create_engine(db_url)
    try:
        inspector = inspect(stamped_engine)
        tables = set(inspector.get_table_names())
    finally:
        stamped_engine.dispose()

    assert "alembic_version" in tables
    assert {"project", "agentrun", "character", "shot"}.issubset(tables)
    # legacy lineage tables no longer exist (dropped in 0027)
    assert not {"run", "stage", "artifact"} & tables


def test_cleanup_migration_drops_retired_setting_and_orphan_rows(tmp_path: Path) -> None:
    """0034: rows of already-deleted projects and the retired FAKE_TEXT_RESPONSE go; live rows stay."""
    from sqlalchemy import text

    db_url = f"sqlite+pysqlite:///{tmp_path / 'cleanup.db'}"
    command.upgrade(_alembic_config(db_url), "0033_chat_message")
    engine = create_engine(db_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO project (id, title, story, style, status, created_at, updated_at) "
                    "VALUES (1, 't', 's', 'anime', 'draft', '2026-10-29', '2026-10-29')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO agentrun (id, project_id, status, progress, confirm_requested, workflow_version, "
                    "execution_attempt, created_at, updated_at) VALUES (1, 1, 'succeeded', 0, 0, 2, 0, '2026-10-29', '2026-10-29')"
                )
            )
            for key in ("FAKE_TEXT_RESPONSE", "TEXT_MODEL"):
                conn.execute(
                    text(
                        "INSERT INTO configitem (key, value, is_sensitive, created_at, updated_at) "
                        "VALUES (:k, 'v', 0, '2026-10-29', '2026-10-29')"
                    ),
                    {"k": key},
                )
            for run_id, project_id in ((1, 1), (0, 1), (9, 2)):
                conn.execute(
                    text("INSERT INTO engine_run_events (run_id, project_id, type, payload) VALUES (:r, :p, 'x', '{}')"),
                    {"r": run_id, "p": project_id},
                )
            for run_id in (1, 9):
                conn.execute(
                    text("INSERT INTO engine_checkpoints (run_id, stage, state_json) VALUES (:r, 'plan', '{}')"),
                    {"r": run_id},
                )
            for project_id in (1, 2):
                conn.execute(
                    text("INSERT INTO chat_message (project_id, message) VALUES (:p, '{}')"), {"p": project_id}
                )
    finally:
        engine.dispose()

    command.upgrade(_alembic_config(db_url), "head")

    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            def rows(sql: str) -> list:
                return [tuple(r) for r in conn.execute(text(sql)).all()]

            assert rows("SELECT key FROM configitem") == [("TEXT_MODEL",)]
            assert rows("SELECT run_id, project_id FROM engine_run_events ORDER BY seq") == [(1, 1), (0, 1)]
            assert rows("SELECT run_id FROM engine_checkpoints") == [(1,)]
            assert rows("SELECT project_id FROM chat_message") == [(1,)]
    finally:
        engine.dispose()


def test_retire_noop_config_migration_drops_only_those_rows(tmp_path: Path) -> None:
    """0035: settings that never had a runtime effect are deleted (any key case); others stay."""
    from sqlalchemy import text

    db_url = f"sqlite+pysqlite:///{tmp_path / 'retire.db'}"
    command.upgrade(_alembic_config(db_url), "0034_cleanup_orphans")
    keys = (
        "LOG_LEVEL",
        "TEXT_ENABLE_THINKING",
        "critique_vision_provider",
        "OUTLINE_ENABLED",
        "DOUBAO_GENERATE_AUDIO",
        "TEXT_MODEL",
        "CRITIQUE_VISION_MODEL",
        "TEXT_REASONING_EFFORT",
    )
    engine = create_engine(db_url)
    try:
        with engine.begin() as conn:
            for key in keys:
                conn.execute(
                    text(
                        "INSERT INTO configitem (key, value, is_sensitive, created_at, updated_at) "
                        "VALUES (:k, 'v', 0, '2026-11-01', '2026-11-01')"
                    ),
                    {"k": key},
                )
    finally:
        engine.dispose()

    command.upgrade(_alembic_config(db_url), "head")

    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            left = sorted(r[0] for r in conn.execute(text("SELECT key FROM configitem")))
        assert left == ["CRITIQUE_VISION_MODEL", "TEXT_MODEL", "TEXT_REASONING_EFFORT"]
    finally:
        engine.dispose()
