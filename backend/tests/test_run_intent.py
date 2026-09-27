from app.services.run_intent import build_rerun_intent


def test_rerun_intent_contains_only_stage_and_scope():
    intent = build_rerun_intent(start_stage="plan_outline")
    assert intent == {
        "version": 1,
        "start_stage": "plan_outline",
        "scope": {"entity_type": None, "entity_ids": []},
    }


def test_character_render_binding_keeps_deduplicated_target_ids():
    intent = build_rerun_intent(
        start_stage="render_characters",
        entity_type="character",
        entity_id=7,
        entity_ids=[7, 9, 7],
    )
    assert intent["scope"] == {"entity_type": "character", "entity_ids": [7, 9]}


def test_shot_render_keeps_target_scope():
    intent = build_rerun_intent(
        start_stage="render_shots", entity_type="shot", entity_ids=[11, 12]
    )
    assert intent["scope"] == {"entity_type": "shot", "entity_ids": [11, 12]}


def test_scope_without_a_valid_entity_type_is_dropped():
    intent = build_rerun_intent(
        start_stage="drop_everything", entity_type="nonsense", entity_ids=[1, 2]
    )
    assert intent["start_stage"] == "drop_everything"
    assert intent["scope"] == {"entity_type": None, "entity_ids": []}
