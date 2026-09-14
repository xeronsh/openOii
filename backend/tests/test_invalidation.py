from app.services.invalidation import build_invalidation_plan


def test_outline_change_invalidates_entire_creative_chain():
    plan = build_invalidation_plan(start_stage="plan_outline")
    assert plan["checkpoint_from"] == "plan_outline"
    assert plan["scope"] == {"entity_type": None, "entity_ids": []}
    assert plan["invalidates"] == [
        "project.outline",
        "characters.definitions",
        "characters.images",
        "shots.definitions",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ]


def test_character_render_binding_keeps_target_ids_but_invalidates_dependents():
    plan = build_invalidation_plan(
        start_stage="render_characters",
        entity_type="character",
        entity_id=7,
        entity_ids=[7, 9, 7],
    )
    assert plan["scope"] == {"entity_type": "character", "entity_ids": [7, 9]}
    assert plan["invalidates"] == [
        "characters.images",
        "shots.images",
        "shots.videos",
        "project.final_video",
    ]


def test_shot_render_only_invalidates_shot_media_and_final():
    plan = build_invalidation_plan(
        start_stage="render_shots", entity_type="shot", entity_ids=[11, 12]
    )
    assert plan["scope"] == {"entity_type": "shot", "entity_ids": [11, 12]}
    assert plan["invalidates"] == [
        "shots.images",
        "shots.videos",
        "project.final_video",
    ]


def test_untrusted_stage_falls_back_to_full_rerun_and_drops_invalid_scope():
    plan = build_invalidation_plan(
        start_stage="drop_everything", entity_type="nonsense", entity_ids=[1, 2]
    )
    assert plan["start_stage"] == "plan_outline"
    assert plan["scope"] == {"entity_type": None, "entity_ids": []}
    assert "characters.definitions" in plan["invalidates"]
