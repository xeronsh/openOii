"""Character consistency routes: trigger in the background, latest report and history."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

import app.db.session as db_session
import app.ws.manager as ws_module
from app.api.v1.routes import consistency as route
from app.db.utils import utcnow
from app.models.consistency_report import ConsistencyReport
from tests.factories import create_project


def _report_data(project_id: int, score: float) -> dict:
    return {
        "project_id": project_id,
        "overall_score": score,
        "evaluated_at": "2026-11-01T05:00:00Z",
        "character_reports": [
            {
                "character_id": 1,
                "character_name": "Crow",
                "face_similarity_mean": 0.9,
                "face_similarity_std": 0.05,
                "presence_rate": 1.0,
                "overall_score": score,
                "face_matches": [{"shot_id": 3, "shot_order": 1, "similarity": 0.9, "detected": True}],
                "grade": "A",
            }
        ],
    }


async def _add_report(session, project_id, score, minutes_ago, data=None):
    report = ConsistencyReport(
        project_id=project_id,
        overall_score=score,
        report_data=_report_data(project_id, score) if data is None else data,
        created_at=utcnow() - timedelta(minutes=minutes_ago),
    )
    session.add(report)
    await session.commit()
    return report


class _Recorder:
    def __init__(self):
        self.events = []

    async def send_event(self, project_id, event):
        self.events.append((project_id, event))


@pytest.fixture
def background(monkeypatch, test_session):
    """Run the background evaluation on the test session (never the live DB) and collect its task."""
    tasks = []
    real_create_task = asyncio.create_task

    def create_task(coro):
        task = real_create_task(coro)
        if getattr(coro, "__name__", "") == "_run_eval":
            tasks.append(task)
        return task

    async def test_sessions():
        yield test_session

    recorder = _Recorder()
    monkeypatch.setattr(asyncio, "create_task", create_task)
    monkeypatch.setattr(db_session, "get_session", test_sessions)
    monkeypatch.setattr(ws_module, "ws_manager", recorder)
    return tasks, recorder


@pytest.mark.asyncio
async def test_trigger_returns_at_once_and_announces_the_score(async_client, test_session, background, monkeypatch):
    tasks, recorder = background
    project = await create_project(test_session)
    seen = []

    class FakeEval:
        async def evaluate_project_consistency(self, proj, session, run_id=None):
            seen.append((proj.id, session is test_session, run_id))
            return {"overall_score": 87.5, "character_reports": [{}, {}]}

    monkeypatch.setattr(route, "get_consistency_eval_service", lambda: FakeEval())

    res = await async_client.post(f"/api/v1/projects/{project.id}/consistency-eval")
    await asyncio.gather(*tasks)

    assert res.status_code == 202
    assert res.json() == {"eval_id": 0, "status": "processing"}
    assert seen == [(project.id, True, None)]
    assert recorder.events == [
        (
            project.id,
            {
                "type": "consistency_eval_completed",
                "data": {"project_id": project.id, "overall_score": 87.5, "character_count": 2},
            },
        )
    ]


@pytest.mark.asyncio
async def test_trigger_logs_a_failed_evaluation_without_an_event(
    async_client, test_session, background, monkeypatch, caplog
):
    tasks, recorder = background
    project = await create_project(test_session)

    class BrokenEval:
        async def evaluate_project_consistency(self, proj, session, run_id=None):
            raise RuntimeError("vision down")

    monkeypatch.setattr(route, "get_consistency_eval_service", lambda: BrokenEval())

    res = await async_client.post(f"/api/v1/projects/{project.id}/consistency-eval")
    await asyncio.gather(*tasks)

    assert res.status_code == 202
    assert recorder.events == []
    assert "vision down" in caplog.text


@pytest.mark.asyncio
async def test_trigger_404_for_unknown_project(async_client, background):
    tasks, _ = background

    res = await async_client.post("/api/v1/projects/99999/consistency-eval")

    assert res.status_code == 404
    assert tasks == []


@pytest.mark.asyncio
async def test_latest_report_is_the_newest_one(async_client, test_session):
    project = await create_project(test_session)
    await _add_report(test_session, project.id, 60.0, minutes_ago=30)
    await _add_report(test_session, project.id, 91.0, minutes_ago=1)

    res = await async_client.get(f"/api/v1/projects/{project.id}/consistency-report")

    assert res.status_code == 200
    body = res.json()
    assert body["overall_score"] == 91.0
    assert body["report_data"]["character_reports"][0]["grade"] == "A"
    assert body["created_at"].endswith("Z")


@pytest.mark.asyncio
async def test_latest_report_404_before_any_evaluation(async_client, test_session):
    project = await create_project(test_session)

    res = await async_client.get(f"/api/v1/projects/{project.id}/consistency-report")

    assert res.status_code == 404
    assert "Trigger an evaluation first" in res.text


@pytest.mark.asyncio
async def test_unreadable_report_data_still_returns_the_score(async_client, test_session):
    project = await create_project(test_session)
    await _add_report(test_session, project.id, 42.0, minutes_ago=0, data={"overall_score": "lots"})

    latest = await async_client.get(f"/api/v1/projects/{project.id}/consistency-report")
    history = await async_client.get(f"/api/v1/projects/{project.id}/consistency-report/history")

    assert latest.status_code == 200
    assert latest.json()["overall_score"] == 42.0
    assert latest.json()["report_data"] is None
    assert history.json()[0]["report_data"] is None


@pytest.mark.asyncio
async def test_history_newest_first_and_limited(async_client, test_session):
    project = await create_project(test_session)
    other = await create_project(test_session, title="Other")
    for i, score in enumerate([50.0, 70.0, 90.0]):
        await _add_report(test_session, project.id, score, minutes_ago=10 - i)
    await _add_report(test_session, other.id, 10.0, minutes_ago=0)

    res = await async_client.get(f"/api/v1/projects/{project.id}/consistency-report/history")
    limited = await async_client.get(
        f"/api/v1/projects/{project.id}/consistency-report/history", params={"limit": 2}
    )
    empty = await async_client.get("/api/v1/projects/99999/consistency-report/history")

    assert [r["overall_score"] for r in res.json()] == [90.0, 70.0, 50.0]
    assert [r["overall_score"] for r in limited.json()] == [90.0, 70.0]
    assert res.json()[0]["report_data"]["project_id"] == project.id
    assert empty.status_code == 404
