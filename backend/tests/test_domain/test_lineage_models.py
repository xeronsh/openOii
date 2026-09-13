from __future__ import annotations

import pytest
from sqlmodel import SQLModel

from app.models.artifact import Artifact
from app.models.run import Run
from app.models.stage import Stage
from tests.factories import create_project


def test_lineage_models_register_canonical_tables():
    assert {"run", "stage", "artifact"}.issubset(SQLModel.metadata.tables)

    run_table = SQLModel.metadata.tables["run"]
    stage_table = SQLModel.metadata.tables["stage"]
    artifact_table = SQLModel.metadata.tables["artifact"]

    assert run_table.c.thread_id.nullable is False
    assert run_table.c.thread_id.unique is True
    assert {fk.column.table.name for fk in run_table.c.project_id.foreign_keys} == {"project"}

    assert {fk.column.table.name for fk in stage_table.c.project_id.foreign_keys} == {"project"}
    assert {fk.column.table.name for fk in stage_table.c.run_id.foreign_keys} == {"run"}
    assert stage_table.c.version.default is not None

    assert {fk.column.table.name for fk in artifact_table.c.project_id.foreign_keys} == {"project"}
    assert {fk.column.table.name for fk in artifact_table.c.run_id.foreign_keys} == {"run"}
    assert {fk.column.table.name for fk in artifact_table.c.stage_id.foreign_keys} == {"stage"}
    assert artifact_table.c.version.default is not None


@pytest.mark.asyncio
async def test_lineage_models_persist_project_run_stage_and_artifact(test_session):
    project = await create_project(test_session, title="Lineage Project")
    assert project.id is not None

    run = Run(project_id=project.id, thread_id="thread-001", status="queued", source="manual")
    test_session.add(run)
    await test_session.commit()
    await test_session.refresh(run)
    assert run.id is not None

    stage = Stage(
        project_id=project.id,
        run_id=run.id,
        name="character",
        status="pending",
        version=1,
        source="engine",
    )
    test_session.add(stage)
    await test_session.commit()
    await test_session.refresh(stage)
    assert stage.id is not None

    artifact = Artifact(
        project_id=project.id,
        run_id=run.id,
        stage_id=stage.id,
        name="storyboard-frame-1",
        artifact_type="image",
        uri="/static/images/frame-1.png",
        version=1,
        source="provider",
    )
    test_session.add(artifact)
    await test_session.commit()
    await test_session.refresh(artifact)
    assert artifact.id is not None

    run_row = await test_session.get(Run, run.id)
    stage_row = await test_session.get(Stage, stage.id)
    artifact_row = await test_session.get(Artifact, artifact.id)
    assert run_row is not None
    assert stage_row is not None
    assert artifact_row is not None

    assert run_row.project_id == project.id
    assert run_row.thread_id == "thread-001"
    assert stage_row.project_id == project.id
    assert stage_row.run_id == run.id
    assert artifact_row.project_id == project.id
    assert artifact_row.run_id == run.id
    assert artifact_row.stage_id == stage.id
