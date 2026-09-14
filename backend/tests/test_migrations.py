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
        "asset",
        "character",
        "configitem",
        "consistency_report",
        "engine_checkpoints",
        "engine_run_events",
        "engine_stage_attempts",
        "exportcache",
        "message",
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
    }.issubset(attempt_columns)

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
