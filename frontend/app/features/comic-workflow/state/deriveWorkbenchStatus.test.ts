import { describe, expect, it } from "vitest";
import type { RecoveryControlRead } from "~/types";
import { deriveWorkbenchStatus } from "./deriveWorkbenchStatus";

function recoveryControl(
	state: RecoveryControlRead["state"],
): RecoveryControlRead {
	return {
		state,
		detail: "run state",
		available_actions: ["resume", "cancel"],
		active_run: {
			id: 9,
			project_id: 15,
			status: state === "active" ? "running" : "failed",
			current_agent: "plan",
			progress: 0.4,
			error: null,
			resource_type: null,
			resource_id: null,
			provider_snapshot: null,
			created_at: "2026-06-14T00:00:00Z",
			updated_at: "2026-06-14T00:00:00Z",
		},
		recovery_summary: {
			project_id: 15,
			run_id: 9,
			current_stage: "plan_outline",
			next_stage: "outline_approval",
			preserved_stages: [],
			stage_history: [],
			resumable: true,
		},
	};
}

const baseInput = {
	isGenerating: false,
	currentRunId: null,
	awaitingConfirm: false,
	recoveryControl: null,
	projectStatus: "draft",
	projectVideoUrl: null,
	blockingClips: [],
};

describe("deriveWorkbenchStatus", () => {
	it("prioritizes confirmation over active generation", () => {
		expect(
			deriveWorkbenchStatus({
				...baseInput,
				isGenerating: true,
				currentRunId: 11,
				awaitingConfirm: true,
			}).state,
		).toBe("awaitingConfirm");
	});

	it("marks resumable conflicts as recoverable", () => {
		expect(
			deriveWorkbenchStatus({
				...baseInput,
				recoveryControl: recoveryControl("recoverable"),
				currentRunId: 9,
			}).state,
		).toBe("recoverable");
	});

	it("keeps active runs in the generating state", () => {
		expect(
			deriveWorkbenchStatus({
				...baseInput,
				recoveryControl: recoveryControl("active"),
			}).state,
		).toBe("generating");
	});

	it("exposes cancelled as a terminal run state", () => {
		expect(
			deriveWorkbenchStatus({
				...baseInput,
				lastRunStatus: "cancelled",
			}).state,
		).toBe("cancelled");
	});

	it("distinguishes blocked, superseded, ready, and idle artifact states", () => {
		expect(
			deriveWorkbenchStatus({
				...baseInput,
				blockingClips: [
					{ shot_id: 1, order: 1, status: "missing", reason: "missing_video" },
				],
			}).state,
		).toBe("blocked");

		expect(
			deriveWorkbenchStatus({
				...baseInput,
				projectStatus: "superseded",
				projectVideoUrl: "/static/final.mp4",
			}).state,
		).toBe("superseded");

		expect(
			deriveWorkbenchStatus({
				...baseInput,
				projectStatus: "ready",
				projectVideoUrl: "/static/final.mp4",
			}).state,
		).toBe("ready");

		expect(deriveWorkbenchStatus(baseInput).state).toBe("idle");
	});
});
