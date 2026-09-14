import { describe, expect, it } from "vitest";
import { resolveEventStage, toSimplifiedStage } from "./workflowStage";

describe("workflowStage mapping", () => {
	it("maps granular backend stages to simplified UI stages", () => {
		expect(toSimplifiedStage("plan_outline")).toBe("plan");
		expect(toSimplifiedStage("outline_approval")).toBe("plan_approval");
		expect(toSimplifiedStage("plan_characters")).toBe("plan");
		expect(toSimplifiedStage("render_shots")).toBe("render");
		expect(toSimplifiedStage("compose_merge")).toBe("compose");
		expect(toSimplifiedStage("compose_approval")).toBe("compose");
		// `review` is still a valid UI stage (the feedback path uses it), but it
		// is no longer a pipeline stage: add_audio and review were removed.
		expect(toSimplifiedStage("review")).toBe("review");
		expect(toSimplifiedStage("add_audio")).toBeUndefined();
	});

	it("treats granular backend stage names as valid workflow stages", () => {
		expect(toSimplifiedStage("plan_outline")).toBeDefined();
		expect(toSimplifiedStage("shot_images_approval")).toBeDefined();
		expect(toSimplifiedStage("invalid_stage")).toBeUndefined();
	});

	it("resolves stage from either stage or current_stage fields", () => {
		expect(resolveEventStage({ stage: "compose_videos" })).toBe("compose");
		expect(resolveEventStage({ current_stage: "characters_approval" })).toBe(
			"plan_approval",
		);
		expect(resolveEventStage({ stage: "nope" })).toBeUndefined();
	});
});
