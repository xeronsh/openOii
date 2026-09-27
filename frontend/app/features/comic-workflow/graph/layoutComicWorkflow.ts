import type {
	ComicWorkflowGraph,
	ComicWorkflowNode,
	ComicWorkflowSection,
} from "./types";

export interface WorkflowRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface WorkflowLayoutNode extends WorkflowRect {
	id: string;
	node: ComicWorkflowNode;
}

export interface WorkflowLayoutFrame extends WorkflowRect {
	id: string;
	section: ComicWorkflowSection;
}

export interface ComicWorkflowLayout {
	frames: WorkflowLayoutFrame[];
	nodes: WorkflowLayoutNode[];
}

/**
 * 排版式分区（非流水线）：
 * 左列角色库，中列分镜九宫格（视觉主角），右列成片交付台。
 * 三列同顶对齐，无箭头——生成阶段顺序由左→右的阅读方向自然表达。
 *
 * Brief 不在画布上：它是项目级上下文，永远由右栏 Inspector 承载
 * （选中 brief 节点时显示），这样画布只保留「角色 → 分镜 → 成片」这条
 * 真正需要在空间里对照的链路，外部左栏 Activity 也不必再与它抢左缘。
 */
const CARD_SIZE: Record<ComicWorkflowNode["kind"], { w: number; h: number }> = {
	brief: { w: 404, h: 300 },
	character: { w: 190, h: 286 }, // 预留参考图管理条
	shot: { w: 220, h: 390 }, // 就地编辑 + 审阅动作行的实测高度
	output: { w: 360, h: 390 }, // 内联播放器 + 导出记录 + 阻塞清单
};

/** Classic storyboard grid columns (九宫格 reading order). */
export const SHOT_GRID_COLUMNS = 3;

/** 左列角色库固定两列，形成稳定的左栏 */
const CHARACTER_COLUMNS = 2;

const GAP = {
	column: 28, // 列间距（原流水线 48 的 section 间距收紧）
	stack: 28, // 左列内区块间距
	card: 14, // ~ --canvas-gap-card
	framePaddingX: 20, // ~ --canvas-frame-pad
	frameHeader: 56, // ~ --canvas-frame-header
};

const START = { x: 64, y: 64 };

export function shotGridPosition(
	index: number,
	columns: number = SHOT_GRID_COLUMNS,
): { row: number; column: number } {
	const cols = Math.max(1, columns);
	return {
		row: Math.floor(index / cols),
		column: index % cols,
	};
}

function rows(count: number, columns: number): number {
	return Math.max(1, Math.ceil(count / columns));
}

function nodesForSection(
	graph: ComicWorkflowGraph,
	section: ComicWorkflowSection,
): ComicWorkflowNode[] {
	return graph.nodes.filter((node) => node.section === section);
}

function gridHeight(count: number, columns: number, cardHeight: number): number {
	const rowCount = rows(count, columns);
	return (
		GAP.frameHeader +
		rowCount * cardHeight +
		(rowCount - 1) * GAP.card +
		GAP.framePaddingX
	);
}

export function layoutComicWorkflow(
	graph: ComicWorkflowGraph,
): ComicWorkflowLayout {
	const characterNodes = nodesForSection(graph, "elements");
	const shotNodes = nodesForSection(graph, "shotline");
	const outputNodes = nodesForSection(graph, "output");

	const shotColumns = Math.min(
		SHOT_GRID_COLUMNS,
		Math.max(1, shotNodes.length || 1),
	);

	// —— 左列：角色库 ——
	const leftWidth =
		GAP.framePaddingX * 2 +
		CHARACTER_COLUMNS * CARD_SIZE.character.w +
		(CHARACTER_COLUMNS - 1) * GAP.card;

	const elementsFrame: WorkflowLayoutFrame = {
		id: "frame:elements",
		section: "elements",
		x: START.x,
		y: START.y,
		w: leftWidth,
		h: Math.max(
			240,
			gridHeight(
				characterNodes.length,
				CHARACTER_COLUMNS,
				CARD_SIZE.character.h,
			),
		),
	};

	// —— 中列：分镜九宫格，画布的视觉主角 ——
	const shotlineFrame: WorkflowLayoutFrame = {
		id: "frame:shotline",
		section: "shotline",
		x: START.x + leftWidth + GAP.column,
		y: START.y,
		w:
			GAP.framePaddingX * 2 +
			SHOT_GRID_COLUMNS * CARD_SIZE.shot.w +
			(SHOT_GRID_COLUMNS - 1) * GAP.card,
		h: Math.max(360, gridHeight(shotNodes.length, shotColumns, CARD_SIZE.shot.h)),
	};

	// —— 右列：成片交付台 ——
	const outputFrame: WorkflowLayoutFrame = {
		id: "frame:output",
		section: "output",
		x: shotlineFrame.x + shotlineFrame.w + GAP.column,
		y: START.y,
		w: GAP.framePaddingX * 2 + CARD_SIZE.output.w,
		h: GAP.frameHeader + CARD_SIZE.output.h + GAP.framePaddingX,
	};

	const layoutNodes: WorkflowLayoutNode[] = [];

	characterNodes.forEach((node, index) => {
		const row = Math.floor(index / CHARACTER_COLUMNS);
		const column = index % CHARACTER_COLUMNS;
		layoutNodes.push({
			id: node.id,
			node,
			x:
				elementsFrame.x +
				GAP.framePaddingX +
				column * (CARD_SIZE.character.w + GAP.card),
			y:
				elementsFrame.y +
				GAP.frameHeader +
				row * (CARD_SIZE.character.h + GAP.card),
			...CARD_SIZE.character,
		});
	});

	shotNodes.forEach((node, index) => {
		const { row, column } = shotGridPosition(index, shotColumns);
		layoutNodes.push({
			id: node.id,
			node,
			x:
				shotlineFrame.x +
				GAP.framePaddingX +
				column * (CARD_SIZE.shot.w + GAP.card),
			y:
				shotlineFrame.y +
				GAP.frameHeader +
				row * (CARD_SIZE.shot.h + GAP.card),
			...CARD_SIZE.shot,
		});
	});

	for (const node of outputNodes) {
		layoutNodes.push({
			id: node.id,
			node,
			x: outputFrame.x + GAP.framePaddingX,
			y: outputFrame.y + GAP.frameHeader,
			...CARD_SIZE.output,
		});
	}

	return {
		frames: [elementsFrame, shotlineFrame, outputFrame],
		nodes: layoutNodes,
	};
}
