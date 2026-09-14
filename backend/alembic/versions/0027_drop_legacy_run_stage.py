"""Drop the legacy Run/Stage/Artifact tables and the langgraph-era thread_id.

`run` and `stage` are remnants of the LangGraph orchestration removed in ADR
0005; nothing writes them any more. `artifact` was the LangGraph-era lineage
row: it has **zero production writers** (only the deletion cascade touched it)
and both of its FKs pointed at `run`/`stage`, so it goes with them.
`agentrun.thread_id` is the langgraph checkpointer's thread key — the engine
addresses runs by run id and never reads it.

Artifact *versions* are unaffected: `artifactversion` is the live table
(project/entity keyed) and keeps its `agentrun` FK.

Revision ID: 0027_drop_legacy_run_stage
Revises: 0026_entity_revision
"""
from alembic import op
import sqlalchemy as sa

revision = "0027_drop_legacy_run_stage"
down_revision = "0026_entity_revision"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite batch mode reflects the table (including its indexes) and re-creates
    # them after the new table is built, so the index on the dropped column must
    # go first — otherwise the rebuild emits CREATE INDEX on a missing column.
    op.execute("DROP INDEX IF EXISTS ix_agentrun_thread_id")
    with op.batch_alter_table("agentrun") as batch:
        batch.drop_column("thread_id")
    for index in (
        "ix_artifact_artifact_type",
        "ix_artifact_name",
        "ix_artifact_project_id",
        "ix_artifact_run_id",
        "ix_artifact_stage_id",
    ):
        op.drop_index(op.f(index), table_name="artifact")
    op.drop_table("artifact")
    for index in ("ix_stage_name", "ix_stage_project_id", "ix_stage_run_id", "ix_stage_status"):
        op.drop_index(op.f(index), table_name="stage")
    op.drop_table("stage")
    for index in ("ix_run_project_id", "ix_run_status", "ix_run_thread_id"):
        op.drop_index(op.f(index), table_name="run")
    op.drop_table("run")


def downgrade() -> None:
    op.create_table(
        "run",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_project_id"), "run", ["project_id"], unique=False)
    op.create_index(op.f("ix_run_status"), "run", ["status"], unique=False)
    op.create_index(op.f("ix_run_thread_id"), "run", ["thread_id"], unique=True)
    op.create_table(
        "stage",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["run.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_stage_name"), "stage", ["name"], unique=False)
    op.create_index(op.f("ix_stage_project_id"), "stage", ["project_id"], unique=False)
    op.create_index(op.f("ix_stage_run_id"), "stage", ["run_id"], unique=False)
    op.create_index(op.f("ix_stage_status"), "stage", ["status"], unique=False)
    op.create_table(
        "artifact",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.Integer(), nullable=False),
        sa.Column("stage_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("artifact_type", sa.String(), nullable=False),
        sa.Column("uri", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["run.id"]),
        sa.ForeignKeyConstraint(["stage_id"], ["stage.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_artifact_artifact_type"), "artifact", ["artifact_type"], unique=False)
    op.create_index(op.f("ix_artifact_name"), "artifact", ["name"], unique=False)
    op.create_index(op.f("ix_artifact_project_id"), "artifact", ["project_id"], unique=False)
    op.create_index(op.f("ix_artifact_run_id"), "artifact", ["run_id"], unique=False)
    op.create_index(op.f("ix_artifact_stage_id"), "artifact", ["stage_id"], unique=False)
    with op.batch_alter_table("agentrun") as batch:
        batch.add_column(sa.Column("thread_id", sa.String(), nullable=True))
        batch.create_index("ix_agentrun_thread_id", ["thread_id"], unique=False)
