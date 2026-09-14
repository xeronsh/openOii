from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy import func, or_, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from app.db.utils import redact_credentials, utcnow
# Import model modules so application metadata/relationships are registered for
# normal ORM use. Schema creation itself belongs exclusively to Alembic.
from app.models import agent_run, artifact, artifact_version, config_item, message, project, run, stage  # noqa: F401

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"


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


def _run_alembic_upgrade() -> None:
    """Upgrade to the one canonical schema or fail application startup.

    The former create_all / missing-column repair fallbacks allowed a process to
    continue on a half-migrated database, while the Node engine independently
    created two other tables. That produced multiple schema authorities. v2 has
    exactly one: Alembic.
    """
    import os
    import subprocess
    import sys

    settings = get_settings()
    env = os.environ.copy()
    env["DATABASE_URL"] = settings.database_url
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(ALEMBIC_INI.parent),
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "unknown migration error").strip()
        raise RuntimeError(f"alembic upgrade failed: {details}")


async def init_db() -> None:
    """Migrate the database, initialize configuration, and reconcile stale runs."""
    import logging

    from app.models.agent_run import AgentRun
    from app.models.project import Project
    from app.services.config_service import ConfigService
    from app.services.style_template_seeds import ensure_builtin_templates

    log = logging.getLogger("openOii.init_db")
    settings = get_settings()

    log.info("init_db: upgrading Alembic schema")
    _run_alembic_upgrade()
    log.info("init_db: alembic upgrade done")

    now = utcnow()
    active_statuses = ("queued", "running", "waiting_for_approval", "cancelling")

    async with async_session_maker() as session:
        config_service = ConfigService(session)
        await config_service.ensure_initialized()
        await config_service.ensure_provider_configs_initialized()
        await config_service.apply_settings_overrides()
        await ensure_builtin_templates(session)

        await session.execute(
            update(Project)
            .where(Project.outline_approved.is_(None))  # type: ignore[union-attr]
            .values(outline_approved=False)
        )

        # Do not blindly cancel every active run on backend restart. A live
        # engine may still own a valid execution lease. Only executions without
        # a lease (legacy/crashed-before-dispatch) or with an expired lease are
        # made recoverable.
        stale_execution = or_(
            AgentRun.lease_token.is_(None),  # type: ignore[union-attr]
            AgentRun.lease_expires_at.is_(None),  # type: ignore[union-attr]
            AgentRun.lease_expires_at <= now,  # type: ignore[operator]
        )
        result = await session.execute(
            update(AgentRun)
            .where(AgentRun.status.in_(active_statuses))  # type: ignore[union-attr]
            .where(stale_execution)
            .values(
                status="failed",
                error="Execution lease expired; run is safe to resume",
                lease_owner=None,
                lease_token=None,
                lease_expires_at=None,
            )
        )
        reconciled = int(getattr(result, "rowcount", 0) or 0)
        if reconciled:
            log.warning("init_db: reconciled %s stale workflow run(s)", reconciled)

        await session.execute(
            update(Project)
            .where((Project.style.is_(None)) | (func.trim(Project.style) == ""))  # type: ignore[union-attr]
            .values(style="anime")
        )
        await session.commit()

    log.info("init_db: database_url = %s", redact_credentials(settings.database_url))


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
