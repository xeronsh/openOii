from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy import func, inspect, text, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlmodel import SQLModel

from app.config import get_settings
from app.models import agent_run, artifact, artifact_version, config_item, message, project, run, stage  # noqa: F401
from app.orchestration.persistence import redact_credentials, ensure_postgres_checkpointer_setup

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"
ALEMBIC_DIR = Path(__file__).resolve().parents[2] / "alembic"


def _build_engine() -> AsyncEngine:
    settings = get_settings()
    engine = create_async_engine(settings.database_url, echo=settings.db_echo, pool_pre_ping=True)
    if settings.database_url.startswith("sqlite"):
        from sqlalchemy.engine import make_url as _make_url

        _db_file = _make_url(settings.database_url).database
        if _db_file and _db_file != ":memory:":
            from pathlib import Path as _Path

            _db_path = _Path(_db_file)
            if not _db_path.is_absolute():
                _db_path = _Path.cwd() / _db_path
            _db_path.parent.mkdir(parents=True, exist_ok=True)
        from sqlalchemy import event

        @event.listens_for(engine.sync_engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    return engine


engine: AsyncEngine = _build_engine()
async_session_maker: async_sessionmaker[AsyncSession] = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def _sync_missing_metadata_columns() -> None:
    """Add columns that exist in SQLModel metadata but are missing in an existing DB.

    Alembic is still the source of truth for normal migrations. This is a local/dev
    safety net for partially migrated databases: create_all() creates missing tables
    but does not alter existing tables, so new model fields like project.story_outline
    can otherwise crash API requests with UndefinedColumnError.
    """
    import logging

    log = logging.getLogger("openOii.init_db")

    async with engine.begin() as conn:
        def _missing_columns(sync_conn):
            inspector = inspect(sync_conn)
            existing_tables = set(inspector.get_table_names())
            dialect = sync_conn.dialect
            preparer = dialect.identifier_preparer
            operations: list[tuple[str, str, str]] = []

            for table in SQLModel.metadata.sorted_tables:
                if table.name not in existing_tables:
                    continue
                existing_cols = {col["name"] for col in inspector.get_columns(table.name)}
                for column in table.columns:
                    if column.name in existing_cols:
                        continue
                    col_type = column.type.compile(dialect=dialect)
                    table_name = preparer.quote(table.name)
                    column_name = preparer.quote(column.name)
                    sql = f"ALTER TABLE {table_name} ADD COLUMN {column_name} {col_type}"
                    if column.server_default is not None:
                        compiled_default = column.server_default.arg.compile(dialect=dialect)
                        sql += f" DEFAULT {compiled_default}"
                    # Keep backfilled columns nullable to avoid failing on existing rows.
                    operations.append((table.name, column.name, sql))
            return operations

        operations = await conn.run_sync(_missing_columns)
        for table_name, column_name, sql in operations:
            try:
                await conn.execute(text(sql))
                log.warning("init_db: added missing column %s.%s", table_name, column_name)
            except Exception as exc:
                message = str(exc).lower()
                if "duplicatecolumn" in message or "already exists" in message:
                    log.info(
                        "init_db: missing-column sync skipped existing column %s.%s",
                        table_name,
                        column_name,
                    )
                    continue
                raise

        def _legacy_not_null_columns(sync_conn):
            inspector = inspect(sync_conn)
            if "artifactversion" not in set(inspector.get_table_names()):
                return []
            legacy_columns = {"target_type", "target_id", "version_number", "asset_type"}
            return [
                col["name"]
                for col in inspector.get_columns("artifactversion")
                if col["name"] in legacy_columns and not col["nullable"]
            ]

        legacy_not_null_columns = await conn.run_sync(_legacy_not_null_columns)
        if legacy_not_null_columns and conn.dialect.name == "sqlite":
            # SQLite cannot ALTER COLUMN; fresh SQLite databases already get the
            # nullable columns from create_all/alembic, so the legacy relax is a
            # no-op there by construction.
            log.info(
                "init_db: skipped legacy NOT NULL relax on sqlite (columns: %s)",
                legacy_not_null_columns,
            )
            return
        for column_name in legacy_not_null_columns:
            await conn.execute(
                text(f"ALTER TABLE artifactversion ALTER COLUMN {column_name} DROP NOT NULL")
            )
            log.warning(
                "init_db: relaxed legacy artifactversion.%s NOT NULL constraint",
                column_name,
            )


def _run_alembic_upgrade() -> None:
    import subprocess
    import sys
    import os
    settings = get_settings()
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.database_url.replace("+asyncpg", "+psycopg2")
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(ALEMBIC_INI.parent),
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"alembic upgrade failed: {result.stderr}")


async def init_db() -> None:
    """Initialize database tables and cleanup stale runs."""
    import logging
    log = logging.getLogger("openOii.init_db")
    settings = get_settings()
    agent_run_table = SQLModel.metadata.tables["agentrun"]
    project_table = SQLModel.metadata.tables["project"]

    alembic_ok = False
    try:
        _run_alembic_upgrade()
        alembic_ok = True
        log.info("init_db: alembic upgrade done")
    except Exception as e:
        log.warning("init_db: alembic upgrade failed (%s), falling back to create_all", e)

    if not alembic_ok:
        try:
            async with engine.begin() as conn:
                await conn.run_sync(SQLModel.metadata.create_all)
            log.info("init_db: create_all fallback done")
        except Exception as e2:
            log.warning("init_db: create_all also failed (%s), continuing", e2)

    try:
        await _sync_missing_metadata_columns()
    except Exception as e3:
        log.warning("init_db: metadata column sync failed (%s), continuing", e3)

    log.info("init_db: starting DB session cleanup")
    async with async_session_maker() as session:
        from app.services.config_service import ConfigService
        from app.models.agent_run import AgentRun
        from app.models.project import Project
        from app.services.style_template_seeds import ensure_builtin_templates

        config_service = ConfigService(session)
        await config_service.ensure_initialized()
        await config_service.ensure_provider_configs_initialized()
        await config_service.apply_settings_overrides()

        await ensure_builtin_templates(session)

        await session.execute(
            update(Project)
            .where(project_table.c.outline_approved.is_(None))
            .values(outline_approved=False)
        )

        await session.execute(
            update(AgentRun)
            .where(agent_run_table.c.status.in_(["queued", "running"]))
            .values(status="cancelled", error="Service restarted")
        )

        await session.execute(
            update(Project)
            .where((project_table.c.style.is_(None)) | (func.trim(project_table.c.style) == ""))
            .values(style="anime")
        )
        await session.commit()

    log.info("init_db: database_url = %s", redact_credentials(settings.database_url))
    await ensure_postgres_checkpointer_setup(settings.database_url)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
