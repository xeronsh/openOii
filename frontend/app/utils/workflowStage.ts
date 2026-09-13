import type { WorkflowStage } from "~/types";

/**
 * Backend sends granular Phase2Stage names (e.g. "plan_characters",
 * "render_shots", "compose_merge").  Frontend UI uses simplified names.
 * This map collapses any granular or simplified name to the UI-level name.
 */
const GRANULAR_TO_SIMPLIFIED: Record<string, WorkflowStage> = {
	// plan phase
	plan_outline: "plan",
	outline_approval: "plan_approval",
	plan_characters: "plan",
	plan_shots: "plan",
	characters_approval: "plan_approval",
	shots_approval: "plan_approval",
	// render phase
	render_characters: "render",
	render_shots: "render",
	character_images_approval: "render_approval",
	shot_images_approval: "render_approval",
	critique_character_images: "render",
	critique_shot_images: "render",
	// compose phase
	compose_videos: "compose",
	compose_merge: "compose",
	add_audio: "compose",
	compose_approval: "compose",
	// passthrough for already-simplified names
	plan: "plan",
	plan_approval: "plan_approval",
	render: "render",
	render_approval: "render_approval",
	compose: "compose",
	review: "review",
};

/**
 * Resolve any stage string (granular backend name or simplified UI name)
 * to the simplified WorkflowStage used by the UI.  Returns `undefined`
 * for completely unknown values.
 */
export function toSimplifiedStage(value: unknown): WorkflowStage | undefined {
	if (typeof value !== "string") return undefined;
	return GRANULAR_TO_SIMPLIFIED[value];
}

/**
 * Resolve a stage from WS event data.  Tries `stage` then `current_stage`,
 * mapping granular backend names to simplified UI names.
 */
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
