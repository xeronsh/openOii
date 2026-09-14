import {
  APPROVAL_TO_PRODUCED_STAGE,
  CRITIQUE_TO_PRODUCED_STAGE,
  GATE_AGENT,
  GRAPH_STAGE_FOR_AGENT,
  NEXT_STAGE,
  PRODUCTION_STAGE_SEQUENCE,
  STAGE_AGENT_MAP,
  STAGE_ORDER,
  STAGE_TO_UI,
  WORKFLOW_VERSION,
  type StageId,
  type UiWorkflowStage,
} from "./generated/workflow-contract.js";

export {
  APPROVAL_TO_PRODUCED_STAGE,
  CRITIQUE_TO_PRODUCED_STAGE,
  GATE_AGENT,
  GRAPH_STAGE_FOR_AGENT,
  NEXT_STAGE,
  PRODUCTION_STAGE_SEQUENCE,
  STAGE_AGENT_MAP,
  STAGE_ORDER,
  STAGE_TO_UI,
  WORKFLOW_VERSION,
};
export type { StageId, UiWorkflowStage };

export function agentForStage(stage: StageId): string {
  return STAGE_AGENT_MAP[stage];
}

function resolveBaseStage(stage: string): StageId | null {
  if ((PRODUCTION_STAGE_SEQUENCE as readonly string[]).includes(stage)) return stage as StageId;
  const approval = APPROVAL_TO_PRODUCED_STAGE[stage as StageId];
  if (approval) return approval;
  const critique = CRITIQUE_TO_PRODUCED_STAGE[stage as StageId];
  return critique ?? null;
}

/** Progress is measured over production stages; approval/critique map to their producer. */
export function progressForStage(stage: string, withinStage = 0): number {
  const base = resolveBaseStage(stage);
  if (base === null) return 0;
  const clamped = Math.max(0, Math.min(withinStage, 1));
  const stageIndex = (PRODUCTION_STAGE_SEQUENCE as readonly StageId[]).indexOf(base);
  const total = PRODUCTION_STAGE_SEQUENCE.length;
  return Math.min((stageIndex + clamped) / total, 1.0);
}

/** User-facing completion copy is content, not workflow topology. */
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
