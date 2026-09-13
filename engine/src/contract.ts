/**
 * WS contract + stage tables ported from
 * backend/app/orchestration/state.py and backend/app/schemas/ws.py.
 * The frontend consumes these verbatim — do not rename fields.
 */

export type StageId =
  | "plan_outline"
  | "outline_approval"
  | "plan_characters"
  | "characters_approval"
  | "plan_shots"
  | "shots_approval"
  | "render_characters"
  | "character_images_approval"
  | "critique_character_images"
  | "render_shots"
  | "shot_images_approval"
  | "critique_shot_images"
  | "compose_videos"
  | "compose_merge"
  | "add_audio"
  | "compose_approval"
  | "review";

/** Ordered production stages (approval gates excluded). */
export const PRODUCTION_STAGE_SEQUENCE: StageId[] = [
  "plan_outline",
  "plan_characters",
  "plan_shots",
  "render_characters",
  "render_shots",
  "compose_videos",
  "compose_merge",
  "add_audio",
];

/** Approval gate → the production stage it comes right after. */
export const APPROVAL_TO_PRODUCED_STAGE: Record<string, StageId> = {
  outline_approval: "plan_outline",
  characters_approval: "plan_characters",
  shots_approval: "plan_shots",
  character_images_approval: "render_characters",
  shot_images_approval: "render_shots",
  compose_approval: "add_audio",
};

/** Next graph stage after each stage (gates included), from state.py. */
export const NEXT_STAGE: Record<StageId, StageId | null> = {
  plan_outline: "outline_approval",
  outline_approval: "plan_characters",
  plan_characters: "characters_approval",
  characters_approval: "plan_shots",
  plan_shots: "shots_approval",
  shots_approval: "render_characters",
  render_characters: "character_images_approval",
  character_images_approval: "critique_character_images",
  critique_character_images: "render_shots",
  render_shots: "shot_images_approval",
  shot_images_approval: "critique_shot_images",
  critique_shot_images: "compose_videos",
  compose_videos: "compose_merge",
  compose_merge: "add_audio",
  add_audio: "compose_approval",
  compose_approval: "review",
  review: null,
};

/** Gate agent name per approval stage (AGATE mapping in orchestrator). */
export const GATE_AGENT: Record<string, string> = {
  outline_approval: "outline",
  characters_approval: "plan",
  shots_approval: "plan",
  character_images_approval: "render",
  shot_images_approval: "render",
  compose_approval: "compose",
};

/** GRAPH_STAGE_FOR_AGENT: agent → representative graph stage. */
export const GRAPH_STAGE_FOR_AGENT: Record<string, string> = {
  outline: "plan_outline",
  plan: "plan_characters",
  render: "render_characters",
  compose: "compose_videos",
  review: "review",
};

const STAGE_TO_AGENT: Record<string, string> = {
  plan_outline: "outline",
  plan_characters: "plan",
  plan_shots: "plan",
  render_characters: "render",
  render_shots: "render",
  compose_videos: "compose",
  compose_merge: "compose",
  add_audio: "compose",
};

export function agentForStage(stage: StageId): string {
  return STAGE_TO_AGENT[stage] ?? stage.split("_")[0] ?? "plan";
}

const CRITIQUE_TO_PRODUCED_STAGE: Record<string, StageId> = {
  critique_character_images: "render_characters",
  critique_shot_images: "render_shots",
};

function resolveBaseStage(stage: string): StageId | null {
  if ((PRODUCTION_STAGE_SEQUENCE as string[]).includes(stage)) return stage as StageId;
  if (stage in APPROVAL_TO_PRODUCED_STAGE) return APPROVAL_TO_PRODUCED_STAGE[stage] as StageId;
  if (stage in CRITIQUE_TO_PRODUCED_STAGE) return CRITIQUE_TO_PRODUCED_STAGE[stage] as StageId;
  return null;
}

/** workflow_progress_for_stage (state.py): progress over PRODUCTION stages. */
export function progressForStage(stage: string, withinStage = 0): number {
  const base = resolveBaseStage(stage);
  if (base === null) return 0;
  const clamped = Math.max(0, Math.min(withinStage, 1));
  const stageIndex = PRODUCTION_STAGE_SEQUENCE.indexOf(base);
  const total = PRODUCTION_STAGE_SEQUENCE.length;
  return Math.min((stageIndex + clamped) / total, 1);
}

/** Generic completion info per agent (orchestrator.AGENT_COMPLETION_INFO, verbatim). */
export const AGENT_COMPLETION_INFO: Record<
  string,
  { completed: string; details: string; next: string; question: string }
> = {
  outline: {
    completed: "已完成故事大纲",
    details: "生成了三幕结构和视觉方向",
    next: "确认后将进入角色设计",
    question: "故事大纲方向是否满意？",
  },
  plan: {
    completed: "已完成创作方案规划",
    details: "生成了角色设定和分镜脚本",
    next: "接下来将为角色和分镜生成参考图片",
    question: "创作方案是否符合您的预期？如果需要修改，请告诉我具体的调整意见。",
  },
  render: {
    completed: "已完成角色形象和分镜画面渲染",
    details: "角色形象和分镜画面均已渲染完成",
    next: "接下来将根据分镜生成视频片段并合成",
    question: "角色形象和分镜画面是否满意？如果需要重新生成，请告诉我。",
  },
  critic: {
    completed: "已完成质量审查",
    details: "已对生成的图像进行一致性、质量和构图审查",
    next: "审查通过，继续下一步",
    question: "审查结果是否满意？",
  },
  compose: {
    completed: "已完成视频合成",
    details: "",
    next: "您的漫剧已经准备就绪！可以下载或分享了。",
    question: "最终视频效果满意吗？",
  },
};
