import { describe, expect, it, vi } from "vitest";
import type { TLShape } from "tldraw";
import type { Project, Shot } from "~/types";
import { buildComicWorkflow } from "../graph/buildComicWorkflow";
import { layoutComicWorkflow } from "../graph/layoutComicWorkflow";
import {
	createWorkflowArrowSpecs,
	createWorkflowShapePartials,
	hasShotOrderChanged,
	hasStaleWorkflowProjection,
	isProjectedWorkflowShape,
	nodeIdFromShape,
	readShotOrderFromCanvas,
	syncTldrawProjection,
} from "./syncTldrawProjection";

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: 1,
		title: "项目",
		story: "故事",
		summary: null,
		style: null,
		video_url: null,
		status: "draft",
		target_shot_count: 2,
		character_hints: [],
		creation_mode: "manual",
		reference_images: [],
		created_at: "",
		updated_at: "",
		provider_settings: {
			text: provider(),
			image: provider(),
			video: provider(),
		},
		...overrides,
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

function shot(id: number, order: number): Shot {
	return {
		id,
		project_id: 1,
		order,
		description: `镜头 ${order}`,
		image_url: null,
		video_url: null,
		duration: null,
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
		prompt: null,
		image_prompt: null,
		camera: null,
		motion_note: null,
		scene: null,
		action: null,
		expression: null,
		lighting: null,
		dialogue: null,
		sfx: null,
		seed: null,
	};
}

function frameIdsBySection(shapes: ReturnType<typeof createWorkflowShapePartials>) {
	return new Map(
		shapes
			.filter((shape) => shape.type === "workflow-frame")
			.map((shape) => {
				const props = shape.props as { section: string };
				return [props.section, shape.id];
			}),
	);
}

describe("syncTldrawProjection helpers", () => {
	it("creates frame and card shape partials from graph layout", () => {
		const graph = buildComicWorkflow({
			project: project({ video_url: "/static/final.mp4", status: "ready" }),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
		});

		// 三栏：elements / shotline / output；Brief 由右栏 Inspector 承载
		expect(partials.filter((shape) => shape.type === "workflow-frame")).toHaveLength(3);
		expect(partials.filter((shape) => shape.type === "workflow-card")).toHaveLength(3);
	});

	it("parents workflow cards to section frames and locks inner cards by default", () => {
		const graph = buildComicWorkflow({
			project: project({ video_url: "/static/final.mp4", status: "ready" }),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
		});
		const frames = frameIdsBySection(partials);
		const cards = partials.filter((shape) => shape.type === "workflow-card");

		expect(
			partials
				.filter((shape) => shape.type === "workflow-frame")
				.every((shape) => shape.isLocked === false && shape.props?.draggable === true),
		).toBe(true);
		expect(cards.every((shape) => shape.isLocked === true)).toBe(true);
		expect(cards.every((shape) => shape.props?.draggable === false)).toBe(true);
		expect(
			cards.map((shape) => [
				nodeIdFromShape(shape as TLShape),
				String(shape.parentId),
			]),
		).toEqual([
			["shot:10", String(frames.get("shotline"))],
			["shot:11", String(frames.get("shotline"))],
			["output", String(frames.get("output"))],
		]);
	});

	it("unlocks only shot cards during shot reorder mode", () => {
		const graph = buildComicWorkflow({
			project: project({ video_url: "/static/final.mp4", status: "ready" }),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
			interactionMode: "sort",
		});
		const frameState = partials
			.filter((shape) => shape.type === "workflow-frame")
			.map((shape) => ({
				isLocked: shape.isLocked,
				draggable: shape.props?.draggable,
			}));
		const cardState = partials
			.filter((shape) => shape.type === "workflow-card")
			.map((shape) => ({
				nodeId: nodeIdFromShape(shape as TLShape),
				isLocked: shape.isLocked,
				draggable: shape.props?.draggable,
			}));

		expect(
			frameState.every(
				(frame) => frame.isLocked === false && frame.draggable === false,
			),
		).toBe(true);
		expect(cardState).toEqual([
			{ nodeId: "shot:10", isLocked: false, draggable: true },
			{ nodeId: "shot:11", isLocked: false, draggable: true },
			{ nodeId: "output", isLocked: true, draggable: false },
		]);
	});

	it("locks all projected workflow shapes during locked mode", () => {
		const graph = buildComicWorkflow({
			project: project({ video_url: "/static/final.mp4", status: "ready" }),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
			interactionMode: "locked",
		});

		expect(
			partials.every(
				(shape) =>
					shape.isLocked === true &&
					(shape.type !== "workflow-frame" || shape.props?.draggable === false) &&
					(shape.type !== "workflow-card" || shape.props?.draggable === false),
			),
		).toBe(true);
	});

	it("binds workflow arrows between section frames instead of inner cards", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
		});
		const frames = frameIdsBySection(partials);
		const specs = createWorkflowArrowSpecs({
			graph,
			desiredShapes: partials,
		});

		expect(
			specs.map((spec) => [String(spec.fromId), String(spec.toId)]),
		).toEqual([
			[String(frames.get("elements")), String(frames.get("shotline"))],
			[String(frames.get("shotline")), String(frames.get("output"))],
		]);
		expect(
			specs.some(
				(spec) =>
					String(spec.fromId).includes("workflow-card") ||
					String(spec.toId).includes("workflow-card"),
			),
		).toBe(false);
	});

	it("marks the shotline to output section arrow as blocking when output is blocked", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1)],
			blockingClips: [
				{ shot_id: 10, order: 1, status: "blocked", reason: "缺少视频" },
			],
			isGenerating: false,
		});
		const partials = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
		});
		const frames = frameIdsBySection(partials);
		const specs = createWorkflowArrowSpecs({
			graph,
			desiredShapes: partials,
		});

		expect(
			specs.find(
				(spec) =>
					String(spec.fromId) === String(frames.get("shotline")) &&
					String(spec.toId) === String(frames.get("output")),
			)?.kind,
		).toBe("blocking");
	});

	it("recognizes legacy node-level workflow arrows as projected shapes", () => {
		expect(
			isProjectedWorkflowShape({
				id: "shape:edge-brief-shot-10",
				type: "arrow",
				meta: {},
				props: {},
				x: 0,
				y: 0,
				rotation: 0,
				index: "a1",
				parentId: "page:page",
				isLocked: false,
				opacity: 1,
			} as TLShape),
		).toBe(true);
	});

	it("detects stale legacy workflow arrows from persisted canvas documents", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1)],
			blockingClips: [],
			isGenerating: false,
		});
		const layout = layoutComicWorkflow(graph);
		const partials = createWorkflowShapePartials({ graph, layout }) as TLShape[];
		const legacyArrow = {
			id: "shape:edge-brief-shot-10",
			type: "arrow",
			meta: {},
			props: {},
			x: 0,
			y: 0,
			rotation: 0,
			index: "a1",
			parentId: "page:page",
			isLocked: false,
			opacity: 1,
		} as TLShape;

		expect(
			hasStaleWorkflowProjection({
				graph,
				layout,
				currentShapes: partials,
			}),
		).toBe(false);
		expect(
			hasStaleWorkflowProjection({
				graph,
				layout,
				currentShapes: [...partials, legacyArrow],
			}),
		).toBe(true);
	});

	it("unlocks stale legacy workflow arrows before deleting them", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1)],
			blockingClips: [],
			isGenerating: false,
		});
		const layout = layoutComicWorkflow(graph);
		let currentShapes = createWorkflowShapePartials({ graph, layout }) as TLShape[];
		const legacyArrow = {
			id: "shape:edge-brief-shot-10",
			type: "arrow",
			meta: {},
			props: {},
			x: 0,
			y: 0,
			rotation: 0,
			index: "a1",
			parentId: "page:page",
			isLocked: true,
			opacity: 1,
		} as TLShape;
		currentShapes = [...currentShapes, legacyArrow];
		const calls: string[] = [];
		const editor = {
			getCurrentPageShapes: () => currentShapes,
			run: (callback: () => void) => callback(),
			updateShapes: vi.fn((partials: Array<Partial<TLShape>>) => {
				calls.push("update");
				currentShapes = currentShapes.map((shape) => {
					const partial = partials.find((item) => item.id === shape.id);
					return partial ? ({ ...shape, ...partial } as TLShape) : shape;
				});
			}),
			deleteShapes: vi.fn((ids: string[]) => {
				calls.push("delete");
				currentShapes = currentShapes.filter((shape) => !ids.includes(String(shape.id)));
			}),
			createShapes: vi.fn(),
			createBindings: vi.fn(),
			deleteBindings: vi.fn(),
			getBindingsFromShape: vi.fn(() => []),
		};

		syncTldrawProjection({ editor: editor as never, graph, layout });

		expect(editor.updateShapes).toHaveBeenCalledWith([
			{ id: legacyArrow.id, type: "arrow", isLocked: false },
		]);
		expect(editor.deleteShapes).toHaveBeenCalledWith([legacyArrow.id]);
		expect(calls.indexOf("update")).toBeLessThan(calls.indexOf("delete"));
	});

	it("reads shot order from card positions", () => {
		const graph = buildComicWorkflow({
			project: project(),
			characters: [],
			shots: [shot(10, 1), shot(11, 2)],
			blockingClips: [],
			isGenerating: false,
		});
		const shapes = createWorkflowShapePartials({
			graph,
			layout: layoutComicWorkflow(graph),
		}).map((shape) => ({ ...shape })) as TLShape[];

		for (const shape of shapes) {
			const nodeId = nodeIdFromShape(shape);
			if (nodeId === "shot:10") shape.x = 500;
			if (nodeId === "shot:11") shape.x = 100;
		}

		const editor = {
			getCurrentPageShapes: () => shapes,
		};

		expect(readShotOrderFromCanvas(editor as never, graph)).toEqual([11, 10]);
	});

	it("detects pending shot order changes", () => {
		expect(hasShotOrderChanged([10, 11], [10, 11])).toBe(false);
		expect(hasShotOrderChanged([10, 11], [11, 10])).toBe(true);
	});
});
