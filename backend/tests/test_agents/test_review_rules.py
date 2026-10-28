from __future__ import annotations

import json

import pytest

from app.agents.review_rules import (
    ALLOWED_START_AGENTS,
    ReviewAgent,
    ReviewRuleEngine,
    normalize_mode,
    normalize_start_agent,
)
from tests.agent_fixtures import FakeLLM, make_context
from tests.factories import create_project, create_run


def _routing_json(
    start_agent: str,
    mode: str = "incremental",
    *,
    character_ids: list[int] | None = None,
    shot_ids: list[int] | None = None,
    reason: str = "test",
) -> str:
    return json.dumps(
        {
            "agent": "review",
            "analysis": {
                "feedback_type": "general",
                "summary": "测试反馈",
                "target_items": [],
                "suggested_changes": "测试",
            },
            "routing": {
                "start_agent": start_agent,
                "mode": mode,
                "reason": reason,
            },
            "target_ids": {
                "character_ids": character_ids or [],
                "shot_ids": shot_ids or [],
            },
        },
        ensure_ascii=False,
    )


class TestNormalizeStartAgent:
    def test_canonical(self):
        assert normalize_start_agent("plan") == "plan"
        assert normalize_start_agent("render") == "render"
        assert normalize_start_agent("compose") == "compose"
        assert normalize_start_agent("outline") == "outline"

    def test_aliases(self):
        assert normalize_start_agent("scriptwriter") == "plan"
        assert normalize_start_agent("character_artist") == "render"
        assert normalize_start_agent("storyboard_artist") == "render"
        assert normalize_start_agent("video_generator") == "compose"
        assert normalize_start_agent("video_merger") == "compose"

    def test_unknown_defaults_plan(self):
        assert normalize_start_agent("weird") == "plan"
        assert normalize_start_agent(None) == "plan"
        assert normalize_start_agent("") == "plan"


class TestNormalizeMode:
    def test_valid(self):
        assert normalize_mode("incremental") == "incremental"
        assert normalize_mode("full") == "full"

    def test_invalid_uses_default(self):
        assert normalize_mode("maybe") == "incremental"
        assert normalize_mode(None, default="full") == "full"


def test_allowed_start_agents():
    assert ALLOWED_START_AGENTS == {"outline", "plan", "render", "compose"}


def test_alias_export():
    assert ReviewRuleEngine is ReviewAgent


@pytest.mark.asyncio
async def test_review_no_feedback_defaults_to_plan(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    ctx.user_feedback = ""

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "plan"
    assert result["mode"] == "full"
    assert ctx.llm.calls == []


@pytest.mark.asyncio
async def test_review_no_feedback_attribute(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    ctx = await make_context(test_session, test_settings, project=project, run=run)
    ctx.user_feedback = None

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "plan"
    assert result["mode"] == "full"


@pytest.mark.asyncio
async def test_review_llm_plan_route(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("plan", "incremental"))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "把对白改得更冷一点"

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "plan"
    assert result["mode"] == "incremental"
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_review_llm_alias_maps_to_render(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("character_artist", "incremental", character_ids=[5]))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "重画这个角色"
    ctx.entity_type = "character"
    ctx.entity_id = 5

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "render"
    assert result["mode"] == "incremental"
    assert result["target_ids"].character_ids == [5]
    assert ctx.user_feedback.startswith("[focus:character:5]")


@pytest.mark.asyncio
async def test_review_llm_compose_route(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("video_merger", "incremental"))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "重试合成"

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "compose"
    assert result["mode"] == "incremental"


@pytest.mark.asyncio
async def test_review_llm_full_mode(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("plan", "full"))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "推倒重来"

    result = await ReviewAgent().run(ctx)

    assert result["mode"] == "full"
    assert result["start_agent"] == "plan"


@pytest.mark.asyncio
async def test_review_invalid_llm_json_raises(test_session, test_settings):
    """Unparseable routing must fail loudly rather than silently rerun from plan."""
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM("not-json-at-all")
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "随便改改"

    with pytest.raises(ValueError):
        await ReviewAgent().run(ctx)


@pytest.mark.asyncio
async def test_review_entity_selection_fills_targets_when_llm_omits(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("render", "incremental"))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "重画"
    ctx.entity_type = "shot"
    ctx.entity_id = 10

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "render"
    assert result["target_ids"].shot_ids == [10]


@pytest.mark.asyncio
async def test_review_multi_entity_ids(test_session, test_settings):
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("render", "incremental", character_ids=[1, 2]))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "修一下这几个角色"
    ctx.entity_type = "character"
    ctx.entity_ids = [1, 2]

    result = await ReviewAgent().run(ctx)

    assert result["target_ids"].character_ids == [1, 2]
    assert ctx.user_feedback.startswith("[focus:character:1,2]")


@pytest.mark.asyncio
async def test_review_ignores_llm_target_ids(test_session, test_settings):
    """Targets come only from the user's selection or entities named in the feedback,
    never from ids the model invents."""
    project = await create_project(test_session)
    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(
        _routing_json("plan", "incremental", character_ids=[1, 2], shot_ids=[3, 4, 5])
    )
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = "fix characters and shots"

    result = await ReviewAgent().run(ctx)

    assert result["start_agent"] == "plan"
    assert result["target_ids"] is None


@pytest.mark.asyncio
async def test_review_infers_targets_from_feedback_when_llm_empty(test_session, test_settings):
    from app.models.project import Character, Shot

    project = await create_project(test_session)
    char = Character(project_id=project.id, name="小欧", description="主角")
    shot = Shot(project_id=project.id, order=1, description="开场", duration=2.0)
    test_session.add(char)
    test_session.add(shot)
    await test_session.commit()
    await test_session.refresh(char)
    await test_session.refresh(shot)

    run = await create_run(test_session, project_id=project.id)
    llm = FakeLLM(_routing_json("render", "incremental"))
    ctx = await make_context(test_session, test_settings, project=project, run=run, llm=llm)
    ctx.user_feedback = f"重画小欧和分镜{shot.order}"

    result = await ReviewAgent().run(ctx)

    assert result["target_ids"] is not None
    assert char.id in result["target_ids"].character_ids
    assert shot.id in result["target_ids"].shot_ids
