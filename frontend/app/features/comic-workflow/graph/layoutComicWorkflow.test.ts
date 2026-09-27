import { describe, expect, it } from "vitest";
import type { Character, Project, Shot } from "~/types";
import { buildComicWorkflow } from "./buildComicWorkflow";
import { layoutComicWorkflow } from "./layoutComicWorkflow";

function project(): Project {
	return {
		id: 1,
		title: "项目",
		story: "故事",
		style: null,
		summary: null,
		video_url: null,
		status: "draft",
		target_shot_count: 2,
		character_hints: [],
		creation_mode: "manual",
		reference_images: [],
		exports: [],
		created_at: "",
		updated_at: "",
		provider_settings: {
			text: provider(),
			image: provider(),
			video: provider(),
		},
	};
}

function provider() {
	return {
		selected_key: "default",
		source: "default" as const,
		resolved_key: null,
		valid: true,
		reason_code: null,
		reason_message: null,
	};
}

function character(id: number): Character {
	return {
		id,
		project_id: 1,
		name: `角色 ${id}`,
		description: null,
		image_url: null,
		reference_images: [],
		has_embedding: false,
		visual_notes: null,
		approval_state: "draft",
		approval_version: 1,
		approved_at: null,
		approved_name: null,
		approved_description: null,
		approved_image_url: null,
	};
}

function shot(id: number, order: number): Shot {
	return {
		id,
		project_id: 1,
		order,
		description: `镜头 ${order}`,
		prompt: null,
		image_prompt: null,
		image_url: null,
		video_url: null,
		duration: null,
		camera: null,
		motion_note: null,
		scene: null,
		action: null,
		expression: null,
		lighting: null,
		dialogue: null,
		sfx: null,
		seed: null,
		character_ids: [],
		approval_state: "draft",
		approval_version: 1,
		approved_at: null,
		approved_description: null,
		approved_prompt: null,
		approved_image_prompt: null,
		approved_duration: null,
		approved_camera: null,
		approved_motion_note: null,
		approved_scene: null,
		approved_action: null,
		approved_expression: null,
		approved_lighting: null,
		approved_dialogue: null,
		approved_sfx: null,
		approved_character_ids: [],
	};
}

describe("layoutComicWorkflow", () => {
	it("composes magazine zones: left column stack, center grid, right delivery", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [character(1)],
			shots: [shot(10, 1)],
			blockingClips: [],
			isGenerating: false,
		});

		const layout = layoutComicWorkflow(graph);
		const [elements, shotline, output] = layout.frames;

		// Brief 不占画布栏位：它是右栏 Inspector 的项目级上下文
		expect(layout.frames.map((frame) => frame.section)).toEqual([
			"elements",
			"shotline",
			"output",
		]);
		expect(layout.nodes.some((node) => node.id === "brief")).toBe(false);
		// 三列同顶对齐
		expect(shotline.y).toBe(elements.y);
		expect(output.y).toBe(elements.y);
		// 中列在左列右侧，右列在中列右侧
		expect(shotline.x).toBeGreaterThan(elements.x + elements.w);
		expect(output.x).toBeGreaterThan(shotline.x + shotline.w);
	});

	it("lays out ordered shots left-to-right in a 3-column grid", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(11, 2), shot(10, 1), shot(12, 3)],
			blockingClips: [],
			isGenerating: false,
		});

		const shotNodes = layoutComicWorkflow(graph).nodes.filter((node) =>
			node.id.startsWith("shot:"),
		);

		expect(shotNodes.map((node) => node.id)).toEqual([
			"shot:10",
			"shot:11",
			"shot:12",
		]);
		// Single row of three: x increases, y is shared
		expect(shotNodes[0].x).toBeLessThan(shotNodes[1].x);
		expect(shotNodes[1].x).toBeLessThan(shotNodes[2].x);
		expect(shotNodes[0].y).toBe(shotNodes[1].y);
		expect(shotNodes[1].y).toBe(shotNodes[2].y);
	});

	it("wraps the fourth shot onto the next grid row", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(1, 1), shot(2, 2), shot(3, 3), shot(4, 4)],
			blockingClips: [],
			isGenerating: false,
		});

		const shotNodes = layoutComicWorkflow(graph).nodes.filter((node) =>
			node.id.startsWith("shot:"),
		);

		expect(shotNodes).toHaveLength(4);
		// Cell 4 aligns under cell 1
		expect(shotNodes[3].x).toBe(shotNodes[0].x);
		expect(shotNodes[3].y).toBeGreaterThan(shotNodes[0].y);
	});

	it("sizes a full 3×3 grid frame for nine shots", () => {
		const shots = Array.from({ length: 9 }, (_, i) => shot(i + 1, i + 1));
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots,
			blockingClips: [],
			isGenerating: false,
		});

		const layout = layoutComicWorkflow(graph);
		const shotNodes = layout.nodes.filter((n) => n.id.startsWith("shot:"));
		const shotFrame = layout.frames.find((frame) => frame.section === "shotline");

		expect(shotNodes).toHaveLength(9);
		// 3 unique x, 3 unique y → 九宫格
		const xs = new Set(shotNodes.map((n) => n.x));
		const ys = new Set(shotNodes.map((n) => n.y));
		expect(xs.size).toBe(3);
		expect(ys.size).toBe(3);
		expect(shotFrame?.w).toBeGreaterThan(600);
		expect(shotFrame?.h).toBeGreaterThan(800);
	});

	it("keeps shot cards tall enough for media, copy, and metadata", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1)],
			blockingClips: [],
			isGenerating: false,
		});

		const layout = layoutComicWorkflow(graph);
		const shotNode = layout.nodes.find((node) => node.id === "shot:10");
		const shotFrame = layout.frames.find((frame) => frame.section === "shotline");

		expect(shotNode?.w).toBe(220);
		expect(shotNode?.h).toBe(390);
		expect(shotFrame?.h).toBeGreaterThanOrEqual(360);
	});
});
