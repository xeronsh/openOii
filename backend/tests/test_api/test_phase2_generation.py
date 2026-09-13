from __future__ import annotations

import pytest

from app.api.v1.routes import generation as generation_routes
from app.schemas.project import (
    AgentRunRead,
    ProjectProviderEntry,
    ProviderResolution,
    RecoveryControlRead,
    RecoveryStageRead,
    RecoverySummaryRead,
)
from tests.factories import create_project, create_run


def _recovery_control(run, *, state: str, detail: str):
    summary = RecoverySummaryRead(
        project_id=run.project_id,
        run_id=run.id,
        thread_id=f"agent-run-{run.id}",
        current_stage="script",
        next_stage="character",
        preserved_stages=["ideate"],
        stage_history=[
            RecoveryStageRead(name="ideate", status="completed", artifact_count=2),
            RecoveryStageRead(name="script", status="current", artifact_count=1),
            RecoveryStageRead(name="character", status="pending", artifact_count=0),
        ],
        resumable=True,
    )
    return RecoveryControlRead(
        state=state,
        detail=detail,
        thread_id=f"agent-run-{run.id}",
        active_run=AgentRunRead.model_validate(run),
        recovery_summary=summary,
    )


def _invalid_provider_resolution() -> ProviderResolution:
    return ProviderResolution(
        valid=False,
        text=ProjectProviderEntry(
            selected_key="openai",
            source="project",
            resolved_key=None,
            valid=False,
            reason_code="provider_missing_credentials",
            reason_message="缺少 OpenAI 文本凭据",
        ),
        image=ProjectProviderEntry(
            selected_key="openai",
            source="default",
            resolved_key="openai",
            valid=True,
            reason_code=None,
            reason_message=None,
        ),
        video=ProjectProviderEntry(
            selected_key="openai",
            source="default",
            resolved_key="openai",
            valid=True,
            reason_code=None,
            reason_message=None,
        ),
    )


async def _return_resolution(_project, _settings, resolution: ProviderResolution) -> ProviderResolution:
    return resolution


@pytest.mark.asyncio
async def test_generate_project_rejects_second_active_full_run(
    async_client, test_session, monkeypatch
):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(project, settings, _invalid_provider_resolution()),
    )

    project = await create_project(test_session)
    active_run = await create_run(test_session, project_id=project.id, status="running")

    async def _fake_recovery_control(**kwargs):
        return _recovery_control(
            active_run,
            state="active",
            detail="Project already has an active run",
        )

    monkeypatch.setattr(generation_routes, "build_recovery_control_surface", _fake_recovery_control)

    res = await async_client.post(f"/api/v1/projects/{project.id}/generate", json={})

    assert res.status_code == 409
    data = res.json()
    assert data["state"] == "active"
    assert "active run" in data["detail"].lower()
    assert data["available_actions"] == ["resume", "cancel"]
    assert data["thread_id"] == f"agent-run-{active_run.id}"
    assert data["recovery_summary"]["current_stage"] == "script"
    assert data["recovery_summary"]["next_stage"] == "character"
    assert data["recovery_summary"]["stage_history"][0]["name"] == "ideate"


@pytest.mark.asyncio
async def test_generate_project_conflict_is_explicit_about_resume_or_cancel(
    async_client, test_session, monkeypatch
):
    monkeypatch.setattr(
        generation_routes,
        "resolve_project_provider_settings_async",
        lambda project, settings: _return_resolution(project, settings, _invalid_provider_resolution()),
    )

    project = await create_project(test_session)
    resumable_run = await create_run(test_session, project_id=project.id, status="failed")

    async def _fake_recovery_control(**kwargs):
        return _recovery_control(
            resumable_run,
            state="recoverable",
            detail="Project has a resumable run",
        )

    monkeypatch.setattr(generation_routes, "build_recovery_control_surface", _fake_recovery_control)

    res = await async_client.post(f"/api/v1/projects/{project.id}/generate", json={})

    assert res.status_code == 409
    data = res.json()
    assert data["state"] == "recoverable"
    assert data["available_actions"] == ["resume", "cancel"]
    assert data["thread_id"] == f"agent-run-{resumable_run.id}"
    assert data["recovery_summary"]["preserved_stages"] == ["ideate"]


@pytest.mark.asyncio
async def test_resume_project_run_dispatches_live_run_to_engine(
    async_client, test_session, monkeypatch
):
    """运行中的 run 也要交给引擎 resume —— 引擎自己幂等，Python 不做本地短路。

    旧断言依赖 task_manager.is_running，但引擎模式下 Python 从不注册本地任务，
    该判断恒为 False，早返回分支实际不可达。
    """
    project = await create_project(test_session)
    active_run = await create_run(test_session, project_id=project.id, status="running")

    engine_resumes: list[dict] = []

    async def _fake_ensure(base_url, database_url, static_dir):
        return None

    async def _fake_resume(base_url, *, project_id: int, run_id: int):
        engine_resumes.append({"project_id": project_id, "run_id": run_id})
        return {"status": "running"}

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _fake_ensure)
    monkeypatch.setattr(generation_routes, "engine_resume_run", _fake_resume)

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/resume", json={"run_id": active_run.id}
    )

    assert res.status_code == 200
    data = res.json()
    assert data["id"] == active_run.id
    assert data["project_id"] == project.id
    assert len(engine_resumes) == 1
    assert engine_resumes[0]["run_id"] == active_run.id


@pytest.mark.asyncio
async def test_resume_project_run_starts_resume_task_for_recoverable_run(
    async_client, test_session, monkeypatch
):
    project = await create_project(test_session)
    resumable_run = await create_run(test_session, project_id=project.id, status="failed")

    captured: dict[str, int] = {}

    async def _fake_ensure(base_url, database_url, static_dir):
        captured["ensured"] = 1

    async def _fake_resume(base_url, *, project_id: int, run_id: int):
        captured["project_id"] = project_id
        captured["run_id"] = run_id
        return {"status": "running"}

    monkeypatch.setattr(generation_routes, "ensure_engine_running", _fake_ensure)
    monkeypatch.setattr(generation_routes, "engine_resume_run", _fake_resume)

    res = await async_client.post(
        f"/api/v1/projects/{project.id}/resume", json={"run_id": resumable_run.id}
    )

    assert res.status_code == 200
    data = res.json()
    assert data["id"] == resumable_run.id
    assert captured["ensured"] == 1
    assert captured["project_id"] == project.id
    assert captured["run_id"] == resumable_run.id
