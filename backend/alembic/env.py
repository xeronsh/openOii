from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, event, inspect, pool, text
from sqlalchemy.engine import make_url
from sqlmodel import SQLModel

BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.models import agent_run, config_item, consistency_report, message, project, style_template  # noqa: F401,E402

config = context.config

if config.config_file_name is not None:
    # Keep loggers created before the migration (pytest caplog, app modules) working.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = SQLModel.metadata


def _database_url() -> str:
    env_url = os.getenv("DATABASE_URL")
    if env_url:
        return _sync_driver_url(env_url)
    configured_url = config.get_main_option("sqlalchemy.url")
    if not configured_url:
        raise RuntimeError("Alembic database URL is not configured (set DATABASE_URL or sqlalchemy.url)")
    return _sync_driver_url(configured_url)


def _sync_driver_url(database_url: str) -> str:
    """Return a URL usable by Alembic's synchronous migration engine.

    The application runtime uses the async ``sqlite+aiosqlite`` driver. Alembic's
    env.py builds a synchronous engine with ``engine_from_config``; feeding it an
    async driver raises ``MissingGreenlet`` before migrations can run.
    """
    url = make_url(database_url)
    if url.drivername == "sqlite+aiosqlite":
        return url.set(drivername="sqlite+pysqlite").render_as_string(hide_password=False)
    return database_url


def run_migrations_offline() -> None:
    url = _database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = _database_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    if connectable.dialect.name == "sqlite":
        @event.listens_for(connectable, "connect")
        def _sqlite_busy_timeout(dbapi_connection, _record):  # noqa: ANN001
            dbapi_connection.execute("PRAGMA busy_timeout=60000")

        @event.listens_for(connectable, "begin")
        def _sqlite_begin_immediate(connection):  # noqa: ANN001
            connection.exec_driver_sql("BEGIN IMMEDIATE")

    with connectable.connect() as connection:
        # Ensure alembic_version.version_num column is wide enough for long revision IDs.
        # Alembic creates this table with VARCHAR(32) by default, but our revision
        # IDs (e.g. "0003_phase7_project_provider_contracts") exceed 32 chars, so
        # pre-create it with a wider column before Alembic auto-creates its own.
        if not inspect(connection).has_table("alembic_version"):
            # Pre-create alembic_version with a wider version_num column before
            # Alembic auto-creates it with VARCHAR(32).
            connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS alembic_version "
                    "(version_num VARCHAR(128) NOT NULL)"
                )
            )
        # Inspector queries autobegin on SQLAlchemy 2.x. End that transaction
        # before Alembic opens its migration transaction, otherwise close rolls
        # back the revision update when alembic_version already exists.
        connection.commit()

        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            transactional_ddl=connection.dialect.name == "sqlite",
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
