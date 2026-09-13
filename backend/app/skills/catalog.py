"""Simple, production-backed skill presets — only three common workflows."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.orchestration import Phase2Stage

AgentName = Literal["outline", "plan", "render", "compose", "review"]
CreationMode = Literal["review", "quick"]


@dataclass(frozen=True, slots=True)
class SkillDefinition:
    id: str
    title: str
    description: str
    badge: Literal["core", "new"] | None
    start_stage: Phase2Stage
    start_agent: AgentName
    prefer_auto_mode: bool = False
    story_prefix: str = ""
    default_style: str | None = None
    default_creation_mode: CreationMode | None = None
    default_target_shot_count: int | None = None
    directives: str = ""
    pipeline_hints: dict[str, Any] = field(default_factory=dict)
    placeholder: str = ""
    """When selected and story is empty, fill this starter scaffold."""
    story_template: str = ""
    available: bool = True


SKILL_CATALOG: tuple[SkillDefinition, ...] = (
    SkillDefinition(
        id="story-anime",
        title="剧情故事",
        description="一句话开故事：大纲 → 角色 → 分镜 → 成片。",
        badge="core",
        start_stage="plan_outline",
        start_agent="outline",
        default_style="anime",
        default_creation_mode="review",
        default_target_shot_count=8,
        placeholder="主角是谁？想要什么？最大阻碍是什么？结尾情绪？",
        story_template=(
            "主角：\n"
            "目标：\n"
            "冲突：\n"
            "关键画面（3 帧）：\n"
            "1. \n2. \n3. \n"
            "风格/情绪：\n"
        ),
        directives=(
            "完整短篇漫剧：必须输出清晰 logline、三幕结构、可拍摄节奏。"
            "角色 2–4 人，每人有可辨识外形与动机；分镜服务叙事弧，不堆无过场。"
            "默认 6–10 镜；每镜含 scene / action / camera / dialogue（可空）可执行字段。"
            "风格锁定为日漫/动画可读语法：清晰轮廓、表情可读、镜头语言简单明确。"
            "若用户只填了模板骨架（空字段多），根据已填信息合理补全，不要追问。"
            "审阅模式下 prioritise 叙事清晰；用户改意见时保留已确认的角色外形与大纲 spine。"
        ),
        pipeline_hints={
            "prioritize": "full",
            "tone": "narrative",
            "shot_bias": "balanced",
            "min_characters": 2,
            "max_characters": 4,
            "min_shots": 6,
            "max_shots": 10,
        },
    ),
    SkillDefinition(
        id="character-design",
        title="角色设计",
        description="先做稳人设与形象，再用少量镜头验收。",
        badge="core",
        start_stage="plan_characters",
        start_agent="plan",
        story_prefix="【角色设计】\n",
        default_style="anime",
        default_creation_mode="review",
        default_target_shot_count=4,
        placeholder="外貌、性格、标志道具、出场情绪、和谁互动？",
        story_template=(
            "【角色设计】\n"
            "角色名：\n"
            "年龄/身份：\n"
            "外貌（发型发色、瞳色、体型、服装、标志物）：\n"
            "性格与说话方式：\n"
            "关系（对手/同伴）：\n"
            "想用 2–4 个镜头展示的瞬间：\n"
        ),
        directives=(
            "本 skill 以角色圣经为第一产物：每位角色必须有可复现 visual_notes"
            "（发型/发色、瞳色、肤色、体型、服装、标志配件）。"
            "性格必须映射到表情与姿态；角色数量优先质量（1–3 人）。"
            "分镜仅用于验收人设：出场、标志动作、情绪特写，不要展开长剧情。"
            "禁止为了剧情牺牲外形一致性；同一角色跨镜外形字段必须一致。"
            "若用户只给名字，按风格补全合理外貌与性格，并在 description 里写清假设。"
            "默认 4 镜：远景定场 / 半身立绘感 / 表情特写 / 互动或道具特写。"
        ),
        pipeline_hints={
            "prioritize": "characters",
            "tone": "character-bible",
            "shot_bias": "sparse",
            "min_characters": 1,
            "max_characters": 3,
            "fixed_shot_count": 4,
        },
    ),
    SkillDefinition(
        id="quick-short",
        title="快速成片",
        description="少打断自动跑通，适合草稿验证。",
        badge="core",
        start_stage="plan_outline",
        start_agent="outline",
        prefer_auto_mode=True,
        default_style="anime",
        default_creation_mode="quick",
        default_target_shot_count=5,
        placeholder="一句话短片点子（角色 + 冲突 + 结局）。",
        story_template=(
            "一句话点子：\n"
            "主角：\n"
            "冲突/反转：\n"
            "结局：\n"
        ),
        directives=(
            "最短可成片路径：1 个核心冲突，1–2 个角色，短三幕。"
            "固定约 5 镜；每镜信息密度高，禁止复杂群戏与长对白。"
            "构图直白、主体居中、便于一键渲染合成。"
            "auto / quick 模式下减少需确认的歧义设定，默认合理即可。"
            "若一句话点子已够完整，直接展开；模板空字段用合理默认补齐。"
            "节奏：钩子 → 升级 → 反转 → 落地，最后一镜必须有收束感。"
        ),
        pipeline_hints={
            "prioritize": "full",
            "tone": "draft-fast",
            "shot_bias": "short",
            "min_characters": 1,
            "max_characters": 2,
            "fixed_shot_count": 5,
        },
    ),
)

_BY_ID: dict[str, SkillDefinition] = {skill.id: skill for skill in SKILL_CATALOG}


def list_skills() -> list[SkillDefinition]:
    return [s for s in SKILL_CATALOG if s.available]


def get_skill(skill_id: str | None) -> SkillDefinition | None:
    if not skill_id or not skill_id.strip():
        return None
    skill = _BY_ID.get(skill_id.strip())
    if skill is None or not skill.available:
        return None
    return skill


@dataclass(frozen=True, slots=True)
class SkillEntryResolution:
    skill: SkillDefinition | None
    start_stage: Phase2Stage
    start_agent: AgentName
    auto_mode: bool
    notes_suffix: str
    directives: str = ""
    default_target_shot_count: int | None = None


def resolve_skill_entry(
    skill_id: str | None,
    *,
    auto_mode: bool = False,
    outline_enabled: bool = True,
) -> SkillEntryResolution:
    """Map a skill id onto graph entry parameters + creative policy."""
    skill = get_skill(skill_id)
    if skill is None:
        start_stage: Phase2Stage = "plan_outline" if outline_enabled else "plan_characters"
        start_agent: AgentName = "outline" if outline_enabled else "plan"
        return SkillEntryResolution(
            skill=None,
            start_stage=start_stage,
            start_agent=start_agent,
            auto_mode=auto_mode,
            notes_suffix="",
        )

    start_stage = skill.start_stage
    start_agent = skill.start_agent
    if start_agent == "outline" and not outline_enabled:
        start_stage = "plan_characters"
        start_agent = "plan"

    notes = f"[skill:{skill.id}] {skill.title}"
    if skill.directives:
        notes = f"{notes}\n{skill.directives}"
    return SkillEntryResolution(
        skill=skill,
        start_stage=start_stage,
        start_agent=start_agent,
        auto_mode=auto_mode or skill.prefer_auto_mode,
        notes_suffix=notes,
        directives=skill.directives,
        default_target_shot_count=skill.default_target_shot_count,
    )
