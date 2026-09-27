import {
	createShapeId,
	type Editor,
	type TLShape,
	type TLShapeId,
	type TLShapePartial,
} from "tldraw";
import type { ComicWorkflowGraph, ComicWorkflowSection } from "../graph/types";
import type {
	ComicWorkflowLayout,
	WorkflowLayoutNode,
} from "../graph/layoutComicWorkflow";
import { WORKFLOW_SHAPE_TYPES } from "./shapes/types";
import type { WorkflowCardShape, WorkflowFrameShape } from "./shapes/types";

const WORKFLOW_ARROW_META = "openoii-comic-workflow-arrow";
const WORKFLOW_NODE_META = "openoii-comic-workflow-node";
const WORKFLOW_FRAME_META = "openoii-comic-workflow-frame";

export type WorkflowInteractionMode = "layout" | "sort" | "locked";

type Anchor = { x: number; y: number };

interface WorkflowArrowSpec {
	id: TLShapeId;
	fromId: TLShapeId;
	toId: TLShapeId;
	kind: string;
	startAnchor: Anchor;
	endAnchor: Anchor;
	start: Anchor;
	end: Anchor;
}

const SECTION_ARROW_FLOW: Array<{
	id: string;
	from: ComicWorkflowSection;
	to: ComicWorkflowSection;
	kind: string;
}> = [
	{
		id: "section-edge:elements-shotline",
		from: "elements",
		to: "shotline",
		kind: "sequence",
	},
	{
		id: "section-edge:shotline-output",
		from: "shotline",
		to: "output",
		kind: "sequence",
	},
];

const OLD_BUSINESS_SHAPE_TYPES = new Set([
	"storyboard-board",
	"canvas-frame",
	"plan-card",
	"character-card",
	"shot-card",
	"video-card",
	"connector",
	"ConnectorShape",
	"script-section",
	"plan-section",
	"character-section",
	"storyboard-section",
	"video-section",
	"compose-section",
]);

export function shapeIdForNode(nodeId: string): TLShapeId {
	return createShapeId(`workflow-card-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
}

function shapeIdForFrame(frameId: string): TLShapeId {
	return createShapeId(frameId.replace(/[^a-zA-Z0-9_-]/g, "-"));
}

function shapeIdForEdge(edgeId: string): TLShapeId {
	return createShapeId(edgeId.replace(/[^a-zA-Z0-9_-]/g, "-"));
}

export function nodeIdFromShape(shape: TLShape | undefined): string | null {
	if (!shape || shape.type !== WORKFLOW_SHAPE_TYPES.CARD) return null;
	const nodeId = shape.meta?.[WORKFLOW_NODE_META];
	return typeof nodeId === "string" ? nodeId : null;
}

function workflowFrameShape(
	frame: ComicWorkflowLayout["frames"][number],
	graph: ComicWorkflowGraph,
	interactionMode: WorkflowInteractionMode,
): TLShapePartial<WorkflowFrameShape> {
	const section = graph.sections.find((item) => item.section === frame.section);
	return {
		id: shapeIdForFrame(frame.id),
		type: WORKFLOW_SHAPE_TYPES.FRAME,
		x: frame.x,
		y: frame.y,
		isLocked: interactionMode === "locked",
		meta: { [WORKFLOW_FRAME_META]: frame.section },
		props: {
			w: frame.w,
			h: frame.h,
			section: frame.section,
			title: section?.title ?? frame.section,
			eyebrow: section?.eyebrow ?? "",
			status: section?.status ?? "draft",
			countLabel: section?.countLabel ?? "",
			draggable: interactionMode === "layout",
		},
	};
}

function workflowCardShape(
	layoutNode: WorkflowLayoutNode,
	parentFrame: ComicWorkflowLayout["frames"][number],
	interactionMode: WorkflowInteractionMode,
): TLShapePartial<WorkflowCardShape> {
	const isSortingShot =
		interactionMode === "sort" && layoutNode.node.kind === "shot";
	return {
		id: shapeIdForNode(layoutNode.id),
		type: WORKFLOW_SHAPE_TYPES.CARD,
		parentId: shapeIdForFrame(parentFrame.id),
		x: layoutNode.x - parentFrame.x,
		y: layoutNode.y - parentFrame.y,
		isLocked: !isSortingShot,
		meta: { [WORKFLOW_NODE_META]: layoutNode.id },
		props: {
			w: layoutNode.w,
			h: layoutNode.h,
			node: layoutNode.node,
			draggable: isSortingShot,
		},
	};
}

export function createWorkflowShapePartials({
	graph,
	layout,
	interactionMode = "layout",
}: {
	graph: ComicWorkflowGraph;
	layout: ComicWorkflowLayout;
	interactionMode?: WorkflowInteractionMode;
}): TLShapePartial[] {
	const frameBySection = new Map(layout.frames.map((frame) => [frame.section, frame]));
	return [
		...layout.frames.map((frame) =>
			workflowFrameShape(frame, graph, interactionMode),
		),
		...layout.nodes.flatMap((node) => {
			const parentFrame = frameBySection.get(node.node.section);
			return parentFrame
				? [workflowCardShape(node, parentFrame, interactionMode)]
				: [];
		}),
	];
}

function isProjectedWorkflowArrowId(shape: TLShape | TLShapePartial): boolean {
	const id = String(shape.id ?? "");
	return id.startsWith("shape:edge-") || id.startsWith("shape:section-edge-");
}

function isWorkflowArrow(shape: TLShape | TLShapePartial): boolean {
	return (
		shape.type === "arrow" &&
		(shape.meta?.[WORKFLOW_ARROW_META] === true ||
			isProjectedWorkflowArrowId(shape))
	);
}

export function isProjectedWorkflowShape(shape: TLShape): boolean {
	return (
		shape.type === WORKFLOW_SHAPE_TYPES.FRAME ||
		shape.type === WORKFLOW_SHAPE_TYPES.CARD ||
		OLD_BUSINESS_SHAPE_TYPES.has(shape.type) ||
		isWorkflowArrow(shape)
	);
}

function isPositionPreservedShape(shape: TLShapePartial): boolean {
	return (
		shape.type === WORKFLOW_SHAPE_TYPES.FRAME ||
		(shape.type === WORKFLOW_SHAPE_TYPES.CARD && shape.isLocked === false)
	);
}

function preservePosition(
	existing: TLShape | undefined,
	desired: TLShapePartial,
	forceLayout: boolean,
): TLShapePartial {
	if (forceLayout || !existing || !isPositionPreservedShape(desired)) {
		return desired;
	}
	if (desired.parentId && existing.parentId !== desired.parentId) {
		return desired;
	}
	return {
		...desired,
		x: existing.x,
		y: existing.y,
	};
}

function shapesEqual(existing: TLShape, desired: TLShapePartial): boolean {
	return (
		existing.type === desired.type &&
		(!desired.parentId || existing.parentId === desired.parentId) &&
		existing.x === (desired.x ?? 0) &&
		existing.y === (desired.y ?? 0) &&
		existing.isLocked === Boolean(desired.isLocked) &&
		JSON.stringify(existing.props ?? {}) === JSON.stringify(desired.props ?? {}) &&
		JSON.stringify(existing.meta ?? {}) === JSON.stringify(desired.meta ?? {})
	);
}

function getShapeSize(shape: TLShape | TLShapePartial): { w: number; h: number } {
	const props = shape.props as { w?: unknown; h?: unknown } | undefined;
	return {
		w: typeof props?.w === "number" ? props.w : 1,
		h: typeof props?.h === "number" ? props.h : 1,
	};
}

function pointAt(shape: TLShape | TLShapePartial, anchor: Anchor): Anchor {
	const { w, h } = getShapeSize(shape);
	return {
		x: (shape.x ?? 0) + w * anchor.x,
		y: (shape.y ?? 0) + h * anchor.y,
	};
}

function centerOf(shape: TLShape | TLShapePartial): Anchor {
	return pointAt(shape, { x: 0.5, y: 0.5 });
}

function directionalAnchors(
	fromShape: TLShape | TLShapePartial,
	toShape: TLShape | TLShapePartial,
): Pick<WorkflowArrowSpec, "startAnchor" | "endAnchor"> {
	const from = centerOf(fromShape);
	const to = centerOf(toShape);
	const dx = to.x - from.x;
	const dy = to.y - from.y;

	if (Math.abs(dx) >= Math.abs(dy)) {
		if (dx >= 0) {
			return {
				startAnchor: { x: 1, y: 0.5 },
				endAnchor: { x: 0, y: 0.5 },
			};
		}
		return {
			startAnchor: { x: 0, y: 0.5 },
			endAnchor: { x: 1, y: 0.5 },
		};
	}

	if (dy >= 0) {
		return {
			startAnchor: { x: 0.5, y: 1 },
			endAnchor: { x: 0.5, y: 0 },
		};
	}
	return {
		startAnchor: { x: 0.5, y: 0 },
		endAnchor: { x: 0.5, y: 1 },
	};
}

function sectionArrowKind(
	graph: ComicWorkflowGraph,
	from: ComicWorkflowSection,
	to: ComicWorkflowSection,
	fallback: string,
): string {
	if (
		from === "shotline" &&
		to === "output" &&
		graph.edges.some((edge) => edge.kind === "blocking")
	) {
		return "blocking";
	}
	return fallback;
}

export function createWorkflowArrowSpecs({
	graph,
	desiredShapes,
	currentShapes,
}: {
	graph: ComicWorkflowGraph;
	desiredShapes: TLShapePartial[];
	currentShapes?: TLShape[];
}): WorkflowArrowSpec[] {
	const visibleIds = new Set(
		desiredShapes
			.map((shape) => shape.id)
			.filter((id): id is TLShapeId => Boolean(id))
			.map(String),
	);
	const shapeById = new Map<string, TLShape | TLShapePartial>();

	for (const shape of desiredShapes) {
		if (shape.id) shapeById.set(String(shape.id), shape);
	}
	for (const shape of currentShapes ?? []) {
		if (visibleIds.has(String(shape.id))) {
			shapeById.set(String(shape.id), shape);
		}
	}

	return SECTION_ARROW_FLOW.flatMap((edge) => {
		const fromId = shapeIdForFrame(`frame:${edge.from}`);
		const toId = shapeIdForFrame(`frame:${edge.to}`);
		const fromShape = shapeById.get(String(fromId));
		const toShape = shapeById.get(String(toId));

		if (!fromShape || !toShape) return [];
		const kind = sectionArrowKind(graph, edge.from, edge.to, edge.kind);
		const anchors = directionalAnchors(fromShape, toShape);
		return [
			{
				id: shapeIdForEdge(edge.id),
				fromId,
				toId,
				kind,
				...anchors,
				start: pointAt(fromShape, anchors.startAnchor),
				end: pointAt(toShape, anchors.endAnchor),
			},
		];
	});
}


export function hasStaleWorkflowProjection({
	graph,
	layout,
	interactionMode = "layout",
	currentShapes,
}: {
	graph: ComicWorkflowGraph;
	layout: ComicWorkflowLayout;
	interactionMode?: WorkflowInteractionMode;
	currentShapes: TLShape[];
}): boolean {
	const desiredShapes = createWorkflowShapePartials({
		graph,
		layout,
		interactionMode,
	});
	const desiredShapeIds = new Set(
		desiredShapes
			.map((shape) => shape.id)
			.filter((id): id is TLShapeId => Boolean(id))
			.map(String),
	);
	const desiredArrowIds = new Set(
		createWorkflowArrowSpecs({ graph, desiredShapes, currentShapes }).map((spec) =>
			String(spec.id),
		),
	);

	return currentShapes.some((shape) => {
		if (!isProjectedWorkflowShape(shape)) return false;
		const id = String(shape.id);
		return !desiredShapeIds.has(id) && !desiredArrowIds.has(id);
	});
}

function deleteWorkflowShapes(editor: Editor, shapes: TLShape[]) {
	if (shapes.length === 0) return;

	const lockedShapes = shapes.filter((shape) => shape.isLocked);
	if (lockedShapes.length > 0) {
		editor.updateShapes(
			lockedShapes.map((shape) => ({
				id: shape.id,
				type: shape.type,
				isLocked: false,
			})),
		);
	}
	editor.deleteShapes(shapes.map((shape) => shape.id));
}

function workflowArrowShape(spec: WorkflowArrowSpec): TLShapePartial {
	const style = arrowStyle(spec.kind);
	return {
		id: spec.id,
		type: "arrow",
		x: 0,
		y: 0,
		isLocked: true,
		meta: { [WORKFLOW_ARROW_META]: true, kind: spec.kind },
		props: {
			kind: "elbow",
			color: style.color,
			labelColor: style.color,
			fill: "none",
			dash: style.dash,
			size: "s",
			arrowheadStart: "none",
			arrowheadEnd: style.arrowheadEnd,
			font: "draw",
			start: spec.start,
			end: spec.end,
			bend: 0,
			labelPosition: 0.5,
			scale: 1,
			elbowMidPoint: 0.5,
		},
	};
}

function arrowStyle(kind: string) {
	if (kind === "blocking") {
		return { color: "red", dash: "dashed", arrowheadEnd: "arrow" } as const;
	}
	if (kind === "reference") {
		return {
			color: "light-violet",
			dash: "dashed",
			arrowheadEnd: "none",
		} as const;
	}
	return { color: "light-blue", dash: "solid", arrowheadEnd: "arrow" } as const;
}

function workflowArrowBinding(
	spec: WorkflowArrowSpec,
	terminal: "start" | "end",
) {
	return {
		type: "arrow" as const,
		fromId: spec.id,
		toId: terminal === "start" ? spec.fromId : spec.toId,
		props: {
			terminal,
			normalizedAnchor:
				terminal === "start" ? spec.startAnchor : spec.endAnchor,
			isExact: false,
			isPrecise: true,
			snap: "edge" as const,
		},
	};
}

function syncWorkflowArrows(
	editor: Editor,
	graph: ComicWorkflowGraph,
	desiredShapes: TLShapePartial[],
) {
	const currentShapes = editor.getCurrentPageShapes();
	const specs = createWorkflowArrowSpecs({ graph, desiredShapes, currentShapes });
	const desiredArrowIds = new Set(specs.map((spec) => String(spec.id)));
	const workflowArrows = currentShapes.filter(isWorkflowArrow);
	const staleArrows = workflowArrows.filter(
		(shape) => !desiredArrowIds.has(String(shape.id)),
	);

	deleteWorkflowShapes(editor, staleArrows);

	const existingArrows = new Set(
		workflowArrows
			.filter((shape) => desiredArrowIds.has(String(shape.id)))
			.map((shape) => String(shape.id)),
	);
	const toCreate: TLShapePartial[] = [];
	const toUpdate: TLShapePartial[] = [];

	for (const spec of specs) {
		const shape = workflowArrowShape(spec);
		if (existingArrows.has(String(spec.id))) {
			toUpdate.push(shape);
		} else {
			toCreate.push(shape);
		}
	}

	if (toCreate.length > 0) editor.createShapes(toCreate);
	if (toUpdate.length > 0) editor.updateShapes(toUpdate);

	const bindingsToRefresh = workflowArrows
		.filter((shape) => desiredArrowIds.has(String(shape.id)))
		.flatMap((shape) => editor.getBindingsFromShape(shape.id, "arrow"));
	if (bindingsToRefresh.length > 0) {
		editor.deleteBindings(bindingsToRefresh);
	}

	const bindings = specs.flatMap((spec) => [
		workflowArrowBinding(spec, "start"),
		workflowArrowBinding(spec, "end"),
	]);
	if (bindings.length > 0) editor.createBindings(bindings);
}


export function syncTldrawProjection({
	editor,
	graph,
	layout,
	interactionMode = "layout",
	forceLayout = false,
}: {
	editor: Editor;
	graph: ComicWorkflowGraph;
	layout: ComicWorkflowLayout;
	interactionMode?: WorkflowInteractionMode;
	forceLayout?: boolean;
}) {
	const desiredShapes = createWorkflowShapePartials({
		graph,
		layout,
		interactionMode,
	});
	const desiredIds = new Set(desiredShapes.map((shape) => shape.id));
	const existingShapes = editor.getCurrentPageShapes();
	const existingMap = new Map(existingShapes.map((shape) => [shape.id, shape]));

	editor.run(() => {
		const staleShapes = existingShapes.filter((shape) => {
			return (
				!isWorkflowArrow(shape) &&
				isProjectedWorkflowShape(shape) &&
				!desiredIds.has(shape.id)
			);
		});
		deleteWorkflowShapes(editor, staleShapes);

		const toCreate: TLShapePartial[] = [];
		const toUpdate: TLShapePartial[] = [];
		for (const desired of desiredShapes) {
			const existing = existingMap.get(desired.id);
			if (!existing) {
				toCreate.push(desired);
				continue;
			}

			const nextShape = preservePosition(existing, desired, forceLayout);
			if (!shapesEqual(existing, nextShape)) {
				toUpdate.push(nextShape);
			}
		}

		if (toCreate.length > 0) editor.createShapes(toCreate);
		if (toUpdate.length > 0) editor.updateShapes(toUpdate);
		syncWorkflowArrows(editor, graph, desiredShapes);
	}, { ignoreShapeLock: true });
}

export function readShotOrderFromCanvas(
	editor: Editor | null,
	graph: ComicWorkflowGraph,
): number[] {
	if (!editor) return graph.orderedShotIds;
	const shotIds = new Set(graph.orderedShotIds);
	const shotShapes = editor
		.getCurrentPageShapes()
		.filter((shape) => shape.type === WORKFLOW_SHAPE_TYPES.CARD)
		.map((shape) => ({
			shape,
			nodeId: nodeIdFromShape(shape),
		}))
		.filter((item) => item.nodeId?.startsWith("shot:"))
		.map((item) => {
			const id = Number(item.nodeId?.replace("shot:", ""));
			return { id, x: item.shape.x, y: item.shape.y };
		})
		.filter((item) => Number.isFinite(item.id) && shotIds.has(item.id));

	if (shotShapes.length !== graph.orderedShotIds.length) {
		return graph.orderedShotIds;
	}

	return shotShapes.sort((a, b) => a.x - b.x || a.y - b.y || a.id - b.id).map((item) => item.id);
}

export function hasShotOrderChanged(current: number[], next: number[]): boolean {
	if (current.length !== next.length) return true;
	return current.some((id, index) => id !== next[index]);
}
