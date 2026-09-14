import json

import pytest

from app.api.v1.routes import runs as generation_routes
from app.models.agent_run import AgentRun
from app.schemas.project import ProjectProviderEntry
from tests.factories import create_project, create_run


def _valid_resolution() -> generation_routes.ProviderResolution:
    def entry(kind: str) -> ProjectProviderEntry:
        return ProjectProviderEntry(
            selected_key=kind,
            source="default",
            resolved_key=kind,
            valid=True,
            reason_code=None,
            reason_message=None,
        )

    return generation_routes.ProviderResolution(
        valid=True,
        text=entry("anthropic"),
        image=entry("openai"),
        video=entry("openai"),
    )


async def _resolution(_project, _settings):
    return _valid_resolution()


@pytest.mark.asyncio
async def test_feedback_persists_deterministic_invalidation_plan(
    async_client, test_session, monkeypatch
):
    monkeypatch.setattr(
        generation_routes, "resolve_project_provider_settings_async", _resolution
    )

    async def route(**_kwargs) -> str:
        return "render_shots"

    monkeypatch.setattr(generation_routes, "_route_feedback_to_stage", route)

    project = await create_project(test_session)
    response = await async_client.post(
        f"/api/v1/projects/{project.id}/runs/feedback",
        json={
            "content": "只重画这两格",
            "feedback_type": "render",
            "entity_type": "shot",
            "entity_ids": [3, 4, 3],
        },
    )
    assert response.status_code == 202

    run = await test_session.get(AgentRun, response.json()["run_id"])
    assert run is not None
    plan = json.loads(run.patch_plan or "{}")
    assert plan["start_stage"] == "render_shots"
    assert plan["scope"] == {"entity_type": "shot", "entity_ids": [3, 4]}
    assert plan["invalidates"] == [
        "shots.images",
        "shots.videos",
        "project.final_video",
    ]


@pytest.mark.asyncio
async def test_feedback_returns_recoverable_conflict_for_stale_active_row(
    async_client, test_session
):
    project = await create_project(test_session)
    stale = await create_run(
        test_session,
        project_id=project.id,
        status="running",
        live_lease=False,
    )

    response = await async_client.post(
        f"/api/v1/projects/{project.id}/runs/feedback",
        json={"content": "继续改"},
    )
    assert response.status_code == 409
    body = response.json()
    assert body["state"] == "recoverable"
    assert body["active_run"]["id"] == stale.id

    await test_session.refresh(stale)
    assert stale.status == "failed"
