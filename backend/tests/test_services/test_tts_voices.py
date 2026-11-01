from __future__ import annotations

import pytest

from app.models.project import Character
from app.services.tts_voices import DEFAULT_VOICE_MAP, get_voice_for_character, infer_voice_type


def _character(name: str = "", description: str | None = None) -> Character:
    return Character(project_id=1, name=name, description=description)


@pytest.mark.parametrize(
    ("name", "description", "expected"),
    [
        ("阿明", "一位沉默的将军", "male_mature"),
        ("小雨", "活泼的少女", "female_young"),
        ("", "故事的旁白", "narrator"),
        ("豆豆", "五岁的小孩", "child"),
        ("王先生", None, "male_young"),
        ("李小姐", "", "female_young"),
        ("阿青", "神秘人物", "female_young"),
    ],
)
def test_infer_voice_type_prefers_description_then_name(name, description, expected) -> None:
    assert infer_voice_type(_character(name, description)) == expected


def test_get_voice_for_character_maps_to_edge_voice() -> None:
    assert get_voice_for_character(_character("老周", "退休的爷爷")) == DEFAULT_VOICE_MAP["male_mature"]
    assert get_voice_for_character(_character("阿青")) == DEFAULT_VOICE_MAP["female_young"]
