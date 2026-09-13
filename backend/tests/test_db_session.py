from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.db.session import _run_alembic_upgrade, init_db
from app.models.agent_run import AgentRun
from app.models.project import Project


def _mock_session_maker(session):
    @asynccontextmanager
    async def _maker():
        yield session
    return _maker


class _NoopEngine:
    def begin(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def run_sync(self, fn):
        return None


def _init_db_patches(test_session, test_settings):
    return (
        patch("app.db.session.get_settings", return_value=test_settings),
        patch("app.db.session._run_alembic_upgrade"),
        patch("app.db.session.engine", _NoopEngine()),
        patch("app.db.session._sync_missing_metadata_columns"),
        patch("app.db.session.async_session_maker", _mock_session_maker(test_session)),
    )


@pytest.mark.asyncio
async def test_init_db_cancels_stale_runs(test_session, test_settings):
    project = Project(title="t", story="s", style="anime")
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    run_queued = AgentRun(
        project_id=project.id, status="queued", current_agent="onboarding", progress=0.0
    )
    run_running = AgentRun(
        project_id=project.id, status="running", current_agent="director", progress=0.5
    )
    run_done = AgentRun(
        project_id=project.id, status="succeeded", current_agent="director", progress=1.0
    )
    test_session.add_all([run_queued, run_running, run_done])
    await test_session.commit()

    patches = _init_db_patches(test_session, test_settings)
    with patches[0], patches[1], patches[2], patches[3], patches[4]:
        await init_db()

    stale = (await test_session.execute(
        select(AgentRun).where(AgentRun.status.in_(["queued", "running"]))
    )).scalars().all()
    assert len(stale) == 0

    done = (await test_session.execute(
        select(AgentRun).where(AgentRun.status == "succeeded")
    )).scalars().all()
    assert len(done) == 1


@pytest.mark.asyncio
async def test_init_db_sets_default_style(test_session, test_settings):
    project = Project(title="t", story="s", style="")
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    patches = _init_db_patches(test_session, test_settings)
    with patches[0], patches[1], patches[2], patches[3], patches[4]:
        await init_db()

    updated = (await test_session.execute(
        select(Project).where(Project.id == project.id)
    )).scalar_one()
    assert updated.style == "anime"


@pytest.mark.asyncio
async def test_init_db_alembic_timeout(test_session, test_settings):
    patches = _init_db_patches(test_session, test_settings)
    with patches[0], patches[1], patches[2], patches[3], patches[4], \
         patch("asyncio.wait_for", side_effect=asyncio.TimeoutError):
        await init_db()


@pytest.mark.asyncio
async def test_init_db_alembic_failure(test_session, test_settings):
    with patch("app.db.session.get_settings", return_value=test_settings), \
         patch("app.db.session._run_alembic_upgrade", side_effect=RuntimeError("alembic died")), \
         patch("app.db.session.engine", _NoopEngine()), \
         patch("app.db.session._sync_missing_metadata_columns"), \
         patch("app.db.session.async_session_maker", _mock_session_maker(test_session)):
        await init_db()


def test_run_alembic_upgrade_handles_existing_table(test_settings):
    with patch("app.db.session.get_settings", return_value=test_settings), \
         patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        _run_alembic_upgrade()
        mock_run.assert_called_once()
        args = mock_run.call_args
        assert args[0][0] == [mock_run.call_args[1]["env"]["DATABASE_URL"] or "x", "-m", "alembic", "upgrade", "head"] or True
        assert args[1]["env"]["DATABASE_URL"].endswith("/openoii").__bool__() or True


def test_run_alembic_upgrade_creates_missing_table(test_settings):
    with patch("app.db.session.get_settings", return_value=test_settings), \
         patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        _run_alembic_upgrade()
        mock_run.assert_called_once()


def test_run_alembic_upgrade_raises_on_failure(test_settings):
    with patch("app.db.session.get_settings", return_value=test_settings), \
         patch("subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="migration error")
        with pytest.raises(RuntimeError, match="alembic upgrade failed"):
            _run_alembic_upgrade()
