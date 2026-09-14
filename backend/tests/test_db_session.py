from __future__ import annotations

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


def _init_db_patches(test_session, test_settings):
    return (
        patch("app.db.session.get_settings", return_value=test_settings),
        patch("app.db.session._run_alembic_upgrade"),
        patch("app.db.session.async_session_maker", _mock_session_maker(test_session)),
    )


@pytest.mark.asyncio
async def test_init_db_marks_unleased_active_runs_recoverable(test_session, test_settings):
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
    with patches[0], patches[1], patches[2]:
        await init_db()

    failed = (
        await test_session.execute(select(AgentRun).where(AgentRun.status == "failed"))
    ).scalars().all()
    assert {run.id for run in failed} == {run_queued.id, run_running.id}
    assert all(run.error == "Execution lease expired; run is safe to resume" for run in failed)

    done = (
        await test_session.execute(select(AgentRun).where(AgentRun.status == "succeeded"))
    ).scalars().all()
    assert [run.id for run in done] == [run_done.id]


@pytest.mark.asyncio
async def test_init_db_preserves_live_leased_run(test_session, test_settings):
    from datetime import timedelta

    from app.db.utils import utcnow

    project = Project(title="t", story="s", style="anime")
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    run = AgentRun(
        project_id=project.id,
        status="running",
        current_agent="render",
        progress=0.5,
        lease_owner="engine-1",
        lease_token="fence-1",
        lease_expires_at=utcnow() + timedelta(minutes=1),
    )
    test_session.add(run)
    await test_session.commit()

    patches = _init_db_patches(test_session, test_settings)
    with patches[0], patches[1], patches[2]:
        await init_db()

    await test_session.refresh(run)
    assert run.status == "running"
    assert run.lease_token == "fence-1"


@pytest.mark.asyncio
async def test_init_db_sets_default_style(test_session, test_settings):
    project = Project(title="t", story="s", style="")
    test_session.add(project)
    await test_session.commit()
    await test_session.refresh(project)

    patches = _init_db_patches(test_session, test_settings)
    with patches[0], patches[1], patches[2]:
        await init_db()

    updated = (
        await test_session.execute(select(Project).where(Project.id == project.id))
    ).scalar_one()
    assert updated.style == "anime"


@pytest.mark.asyncio
async def test_init_db_propagates_alembic_failure(test_session, test_settings):
    with (
        patch("app.db.session.get_settings", return_value=test_settings),
        patch("app.db.session._run_alembic_upgrade", side_effect=RuntimeError("alembic died")),
        patch("app.db.session.async_session_maker", _mock_session_maker(test_session)),
        pytest.raises(RuntimeError, match="alembic died"),
    ):
        await init_db()


def test_run_alembic_upgrade_invokes_head(test_settings):
    with (
        patch("app.db.session.get_settings", return_value=test_settings),
        patch("subprocess.run") as mock_run,
    ):
        mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        _run_alembic_upgrade()
        mock_run.assert_called_once()
        args = mock_run.call_args
        command = args.args[0]
        assert command[1:] == ["-m", "alembic", "upgrade", "head"]
        assert args.kwargs["env"]["DATABASE_URL"] == test_settings.database_url
        assert args.kwargs["timeout"] == 60


def test_run_alembic_upgrade_raises_on_failure(test_settings):
    with (
        patch("app.db.session.get_settings", return_value=test_settings),
        patch("subprocess.run") as mock_run,
    ):
        mock_run.return_value = MagicMock(returncode=1, stderr="migration error", stdout="")
        with pytest.raises(RuntimeError, match="alembic upgrade failed: migration error"):
            _run_alembic_upgrade()
