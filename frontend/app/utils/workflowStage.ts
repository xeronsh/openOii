import { STAGE_TO_UI, type StageId } from "~/generated/workflowContract";
import type { WorkflowStage } from "~/types";

const UI_STAGES = new Set<WorkflowStage>([
	"plan",
	"plan_approval",
	"render",
	"render_approval",
	"compose",
	"review",
]);

/**
 * Resolve a canonical backend/engine stage or an already-simplified UI stage.
 * Granular stage topology is generated from contracts/workflow.json; this file
 * only owns presentation copy for the simplified UI phases.
 */
export function toSimplifiedStage(value: unknown): WorkflowStage | undefined {
	if (typeof value !== "string") return undefined;
	if (UI_STAGES.has(value as WorkflowStage)) return value as WorkflowStage;
	if (Object.hasOwn(STAGE_TO_UI, value)) {
		return STAGE_TO_UI[value as StageId] as WorkflowStage;
	}
	return undefined;
}

/** Resolve `stage` then `current_stage` from a realtime event. */
export function resolveEventStage(
	data: Record<string, unknown>,
): WorkflowStage | undefined {
	const raw = data.stage ?? data.current_stage;
	return toSimplifiedStage(raw);
}

export function getWorkflowStageInfo(stage: WorkflowStage): {
	title: string;
	description: string;
} {
	switch (stage) {
		case "plan":
		case "plan_approval":
			return {
				title: "规划阶段",
				description: "正在生成剧本、角色与镜头规划",
			};
		case "render":
		case "render_approval":
			return {
				title: "渲染阶段",
				description: "正在生成角色形象图和分镜首帧图",
			};
		case "compose":
			return {
				title: "合成阶段",
				description: "正在生成视频片段并合成最终视频",
			};
		case "review":
			return {
				title: "反馈修订",
				description: "正在根据反馈决定从哪个阶段继续",
			};
	}
}
