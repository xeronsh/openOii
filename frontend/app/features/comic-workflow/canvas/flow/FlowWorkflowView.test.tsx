import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { useThemeStore } from "~/stores/themeStore";
import type { Character, Project, Shot } from "~/types";
import { buildComicWorkflow } from "../../graph/buildComicWorkflow";
import { layoutComicWorkflow } from "../../graph/layoutComicWorkflow";
import type { ComicWorkflowSection } from "../../graph/types";
import { boardViewport, FlowWorkflowView, previousShotOrder, type FlowWorkflowViewProps } from "./FlowWorkflowView";

type FakeNode = { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; selected?: boolean; parentId?: string; data: Record<string, unknown> };

// React Flow needs real layout to measure nodes, which jsdom does not have. This fake keeps
// the parts the view drives (nodes, selection, drag, context menu, viewport calls) observable.
const h = vi.hoisted(() => ({
	props: {} as Record<string, any>,
	nodes: [] as FakeNode[],
	zoom: 1,
	flow: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	const bounds = (nodes: FakeNode[]) => {
		if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
		const xs = nodes.map((n) => n.position.x);
		const ys = nodes.map((n) => n.position.y);
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		return {
			x,
			y,
			width: Math.max(...nodes.map((n) => n.position.x + (n.width ?? 100))) - x,
			height: Math.max(...nodes.map((n) => n.position.y + (n.height ?? 100))) - y,
		};
	};
	h.flow = {
		getNodes: vi.fn(() => h.nodes),
		getNode: vi.fn((id: string) => h.nodes.find((n) => n.id === id)),
		getNodesBounds: vi.fn((nodes: FakeNode[]) => bounds(nodes)),
		setViewport: vi.fn(async () => true),
		getViewport: vi.fn(() => ({ x: 100, y: 50, zoom: 1 })),
		fitView: vi.fn(async () => true),
		zoomIn: vi.fn(async () => true),
		zoomOut: vi.fn(async () => true),
		zoomTo: vi.fn(async () => true),
	};
	function ReactFlow(props: Record<string, any>) {
		h.props = props;
		h.nodes = props.nodes;
		return (
			<div data-testid="flow" aria-label={props["aria-label"]}>
				{props.nodes.map((node: FakeNode) => {
					const View = props.nodeTypes[node.type];
					return (
						<div
							key={node.id}
							className="react-flow__node"
							data-id={node.id}
							tabIndex={0}
							onContextMenu={(event) => props.onNodeContextMenu(event, node)}
						>
							<View data={node.data} selected={Boolean(node.selected)} />
						</div>
					);
				})}
				{props.children}
			</div>
		);
	}
	return {
		...actual,
		ReactFlow,
		ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
		Background: () => null,
		useReactFlow: () => h.flow,
		useViewport: () => ({ x: 0, y: 0, zoom: h.zoom }),
	};
});

vi.mock("../WorkflowCards", () => ({
	WorkflowFrameView: ({ title, draggable }: { title: string; draggable: boolean }) => (
		<div data-testid="frame" data-draggable={String(draggable)}>{title}</div>
	),
	WorkflowCardView: ({ node, selected, draggable }: { node: { id: string; title: string }; selected: boolean; draggable: boolean }) => (
		<div data-testid={`card-${node.id}`} data-selected={String(selected)} data-draggable={String(draggable)}>{node.title}</div>
	),
}));
vi.mock("../toolbar/ComicCanvasToolbar", () => ({
	ComicCanvasToolbar: (p: Record<string, any>) => (
		<div data-testid="toolbar" data-tool={p.controls.tool} data-zoom={p.controls.zoomPercent} data-sort-disabled={String(p.sortDisabled)}>
			<button onClick={p.onResetLayout}>reset</button>
			<button onClick={p.onToggleSortMode}>sort</button>
			<button onClick={p.controls.zoomIn}>zoom-in</button>
			<button onClick={p.controls.zoomOut}>zoom-out</button>
			<button onClick={p.controls.zoomReset}>zoom-reset</button>
			<button onClick={p.controls.fit}>fit</button>
			<button onClick={() => p.controls.setTool("hand")}>hand</button>
		</div>
	),
}));
vi.mock("./CardContextMenu", async (importOriginal) => ({
	...(await importOriginal<typeof import("./CardContextMenu")>()),
	CardContextMenu: ({ menu, structureLocked, onClose }: { menu: { node: { id: string }; x: number; y: number }; structureLocked: boolean; onClose: () => void }) => (
		<div data-testid="menu" data-node={menu.node.id} data-x={menu.x} data-y={menu.y} data-locked={String(structureLocked)}>
			<button onClick={onClose}>close-menu</button>
		</div>
	),
}));
const api = vi.hoisted(() => ({ projectsApi: { reorderShots: vi.fn() } }));
vi.mock("~/services/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("~/utils/toast", () => ({ toast }));

const PID = 5;
const project = { id: PID, title: "雨夜", story: "s", style: "anime", status: "draft", video_url: null, blocking_clips: [], universe_id: null } as unknown as Project;
const characters = [{ id: 21, project_id: PID, name: "林夏", description: "d", image_url: null }] as unknown as Character[];
const shots = [1, 2, 3, 4].map((order) => ({
	id: 10 + order,
	project_id: PID,
	order,
	description: `镜头${order}`,
	image_url: null,
	video_url: null,
	character_ids: [],
})) as unknown as Shot[];
const graph = buildComicWorkflow({ project, characters, shots, isGenerating: false });
const layout = layoutComicWorkflow(graph);
const shotIds = graph.nodes.filter((n) => n.kind === "shot").map((n) => n.id);
const characterId = graph.nodes.find((n) => n.kind === "character")!.id;

let client: QueryClient;
function renderView(props: Partial<FlowWorkflowViewProps> = {}) {
	const all: FlowWorkflowViewProps = {
		projectId: PID,
		graph,
		layout,
		interactionMode: "layout",
		sortMode: false,
		structureLocked: false,
		onToggleSortMode: vi.fn(),
		onSorted: vi.fn(),
		onSelectedNodeIdChange: vi.fn(),
		onSelectedNodeIdsChange: vi.fn(),
		...props,
	};
	const view = render(
		<QueryClientProvider client={client}>
			<FlowWorkflowView {...all} />
		</QueryClientProvider>,
	);
	const rerender = (next: Partial<FlowWorkflowViewProps>) => {
		Object.assign(all, next);
		view.rerender(
			<QueryClientProvider client={client}>
				<FlowWorkflowView {...all} />
			</QueryClientProvider>,
		);
	};
	return { ...view, props: all, rerender };
}
const nodeEl = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement;

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	h.zoom = 1;
	client = new QueryClient();
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		cb(0);
		return 1;
	});
});
afterEach(() => vi.restoreAllMocks());

describe("FlowWorkflowView", () => {
	it("renders frames and cards and fits the board once on mount", async () => {
		renderView();
		expect(screen.getByLabelText("漫画工作流画布")).toBeInTheDocument();
		expect(screen.getAllByTestId("frame").map((f) => f.dataset.draggable)).toEqual(expect.arrayContaining(["true"]));
		for (const id of shotIds) expect(screen.getByTestId(`card-${id}`).dataset.draggable).toBe("false");
		await waitFor(() => expect(h.flow.setViewport).toHaveBeenCalledTimes(1));
		expect(h.flow.setViewport.mock.calls[0]![1]).toEqual({ duration: 0 });
	});

	it("only lets shot cards move in sort mode and announces the keyboard hint", () => {
		renderView({ interactionMode: "sort", sortMode: true });
		for (const id of shotIds) expect(screen.getByTestId(`card-${id}`).dataset.draggable).toBe("true");
		expect(screen.getByTestId(`card-${characterId}`).dataset.draggable).toBe("false");
		expect(screen.getAllByTestId("frame").every((f) => f.dataset.draggable === "false")).toBe(true);
		expect(screen.getByText(/排序模式：拖动分镜/)).toBeInTheDocument();
	});

	it("reports card selections and ignores frames", () => {
		const { props } = renderView();
		act(() => h.props.onSelectionChange({ nodes: [{ id: "frame:shotline", type: "frame" }, { id: shotIds[1], type: "card" }], edges: [] }));
		expect(props.onSelectedNodeIdsChange).toHaveBeenLastCalledWith([shotIds[1]]);
		expect(props.onSelectedNodeIdChange).toHaveBeenLastCalledWith(shotIds[1]);
		act(() => h.props.onSelectionChange({ nodes: [], edges: [] }));
		expect(props.onSelectedNodeIdChange).toHaveBeenLastCalledWith(null);
	});

	it("applies selection from canvas events and focuses a node from the command palette", () => {
		renderView();
		act(() => canvasEvents.emit("set-workflow-selection", { nodeIds: [shotIds[0]!, shotIds[2]!] }));
		expect(screen.getByTestId(`card-${shotIds[0]}`).dataset.selected).toBe("true");
		expect(screen.getByTestId(`card-${shotIds[2]}`).dataset.selected).toBe("true");
		act(() => canvasEvents.emit("select-workflow-node", { nodeId: characterId }));
		expect(screen.getByTestId(`card-${shotIds[0]}`).dataset.selected).toBe("false");
		expect(screen.getByTestId(`card-${characterId}`).dataset.selected).toBe("true");

		act(() => canvasEvents.emit("focus-workflow-node", { nodeId: "missing" }));
		expect(h.flow.fitView).not.toHaveBeenCalled();
		act(() => canvasEvents.emit("focus-workflow-node", { nodeId: shotIds[3]! }));
		expect(h.flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: shotIds[3] }], maxZoom: 1 }));
		expect(screen.getByTestId(`card-${shotIds[3]}`).dataset.selected).toBe("true");
	});

	it("opens a context menu for a card (selecting it) and closes it when the viewport moves", () => {
		const { props } = renderView({ structureLocked: true });
		fireEvent.contextMenu(nodeEl("frame:shotline"));
		expect(screen.queryByTestId("menu")).toBeNull();
		fireEvent.contextMenu(nodeEl(shotIds[1]!), { clientX: 40, clientY: 30 });
		const menu = screen.getByTestId("menu");
		expect(menu.dataset.node).toBe(shotIds[1]);
		expect(menu.dataset.locked).toBe("true");
		expect(props.onSelectedNodeIdChange).toHaveBeenLastCalledWith(shotIds[1]);
		expect(screen.getByTestId(`card-${shotIds[1]}`).dataset.selected).toBe("true");
		// Programmatic moves (null event) keep it open; a user pan closes it.
		act(() => h.props.onMove(null));
		expect(screen.getByTestId("menu")).toBeInTheDocument();
		act(() => h.props.onMove(new MouseEvent("mousemove")));
		expect(screen.queryByTestId("menu")).toBeNull();
		fireEvent.contextMenu(nodeEl(shotIds[0]!));
		fireEvent.click(screen.getByText("close-menu"));
		expect(screen.queryByTestId("menu")).toBeNull();
	});

	it("does not open a context menu while sorting", () => {
		renderView({ interactionMode: "sort", sortMode: true });
		fireEvent.contextMenu(nodeEl(shotIds[0]!));
		expect(screen.queryByTestId("menu")).toBeNull();
	});

	it("persists dragged frame positions per project and resets them", async () => {
		const { unmount } = renderView();
		act(() => h.props.onNodesChange([{ type: "position", id: "frame:output", position: { x: 999, y: 7 }, dragging: false }]));
		act(() => h.props.onNodeDragStop());
		const saved = JSON.parse(localStorage.getItem(`openoii.flow.frames.${PID}`)!);
		expect(saved["frame:output"]).toEqual({ x: 999, y: 7 });
		unmount();
		renderView();
		expect(h.nodes.find((n) => n.id === "frame:output")!.position).toEqual({ x: 999, y: 7 });
		vi.useFakeTimers();
		try {
			fireEvent.click(screen.getByText("reset"));
			expect(localStorage.getItem(`openoii.flow.frames.${PID}`)).toBeNull();
			const before = h.flow.setViewport.mock.calls.length;
			act(() => vi.advanceTimersByTime(100));
			expect(h.flow.setViewport.mock.calls.length).toBe(before + 1);
		} finally {
			vi.useRealTimers();
		}
		expect(h.nodes.find((n) => n.id === "frame:output")!.position).not.toEqual({ x: 999, y: 7 });
	});

	it("ignores unreadable saved positions", () => {
		localStorage.setItem(`openoii.flow.frames.${PID}`, "{oops");
		renderView();
		expect(screen.getAllByTestId("frame").length).toBeGreaterThan(0);
	});

	it("reorders shots after a drag in sort mode, then undoes back to the previous order", async () => {
		api.projectsApi.reorderShots.mockResolvedValue(undefined);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const { props } = renderView({ interactionMode: "sort", sortMode: true });
		const first = h.nodes.find((n) => n.id === shotIds[0])!;
		const second = h.nodes.find((n) => n.id === shotIds[1])!;
		act(() =>
			h.props.onNodesChange([
				{ type: "position", id: first.id, position: second.position },
				{ type: "position", id: second.id, position: first.position },
			]),
		);
		act(() => h.props.onNodeDragStop());
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect(api.projectsApi.reorderShots).toHaveBeenCalledWith(PID, [
			{ shot_id: 12, order: 1 },
			{ shot_id: 11, order: 2 },
			{ shot_id: 13, order: 3 },
			{ shot_id: 14, order: 4 },
		]);
		const call = toast.success.mock.calls[0]![0];
		expect(call).toMatchObject({ title: "九宫格已重排", message: "已按阅读顺序更新 4 格" });
		expect(props.onSorted).toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["shots", PID] });

		call.actions[0].onClick();
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith({ title: "已撤销", message: "恢复了重排前的顺序" }));
		expect(api.projectsApi.reorderShots).toHaveBeenLastCalledWith(PID, previousShotOrder(graph));
	});

	it("reports a failed reorder and a failed undo", async () => {
		api.projectsApi.reorderShots.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("")).mockRejectedValueOnce(new Error("冲突"));
		renderView({ interactionMode: "sort", sortMode: true });
		const [a, b] = [h.nodes.find((n) => n.id === shotIds[0])!, h.nodes.find((n) => n.id === shotIds[1])!];
		act(() => h.props.onNodesChange([{ type: "position", id: a.id, position: b.position }, { type: "position", id: b.id, position: a.position }]));
		act(() => h.props.onNodeDragStop());
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		toast.success.mock.calls[0]![0].actions[0].onClick();
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "撤销失败", message: "请重试" }));
		act(() => h.props.onNodeDragStop());
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "重排失败", message: "冲突" }));
	});

	it("does nothing on drag stop when locked or when the order is unchanged", () => {
		const { unmount } = renderView({ interactionMode: "locked", structureLocked: true });
		act(() => h.props.onNodeDragStop());
		expect(localStorage.length).toBe(0);
		unmount();
		renderView({ interactionMode: "sort", sortMode: true });
		act(() => h.props.onNodeDragStop());
		expect(api.projectsApi.reorderShots).not.toHaveBeenCalled();
	});

	it("moves a shot with Alt+arrows in sort mode and stays in sort mode", async () => {
		api.projectsApi.reorderShots.mockResolvedValue(undefined);
		const { props } = renderView({ interactionMode: "sort", sortMode: true });
		fireEvent.keyDown(nodeEl(shotIds[0]!), { key: "ArrowRight", altKey: true });
		const title = graph.nodes.find((n) => n.id === shotIds[0])!.title;
		expect(screen.getByText(`${title} 移到第 2 格`)).toBeInTheDocument();
		await waitFor(() => expect(api.projectsApi.reorderShots).toHaveBeenCalledWith(PID, [
			{ shot_id: 12, order: 1 },
			{ shot_id: 11, order: 2 },
			{ shot_id: 13, order: 3 },
			{ shot_id: 14, order: 4 },
		]));
		expect(toast.success).not.toHaveBeenCalled();
		expect(props.onSorted).not.toHaveBeenCalled();

		fireEvent.keyDown(nodeEl(shotIds[0]!), { key: "ArrowUp", altKey: true });
		expect(screen.getByText("已经到头了，无法再移动。")).toBeInTheDocument();
		// Falls back to the selected card when focus is on the canvas itself.
		act(() => canvasEvents.emit("select-workflow-node", { nodeId: shotIds[0]! }));
		fireEvent.keyDown(screen.getByTestId("flow"), { key: "ArrowDown", altKey: true });
		await waitFor(() => expect(api.projectsApi.reorderShots).toHaveBeenCalledTimes(2));
		expect(api.projectsApi.reorderShots.mock.calls[1]![1][0]).toEqual({ shot_id: 12, order: 1 });
	});

	it("ignores arrows outside sort mode, without Alt, on non-shots, and unrelated keys", () => {
		const { unmount } = renderView();
		fireEvent.keyDown(nodeEl(shotIds[0]!), { key: "ArrowRight", altKey: true });
		unmount();
		renderView({ interactionMode: "sort", sortMode: true });
		fireEvent.keyDown(nodeEl(shotIds[0]!), { key: "ArrowRight" });
		fireEvent.keyDown(nodeEl(shotIds[0]!), { key: "Enter", altKey: true });
		fireEvent.keyDown(nodeEl(characterId), { key: "ArrowRight", altKey: true });
		expect(api.projectsApi.reorderShots).not.toHaveBeenCalled();
	});

	it("switches tools with V/H but not while typing, and wires the zoom controls", () => {
		renderView();
		const toolbar = screen.getByTestId("toolbar");
		fireEvent.keyDown(window, { key: "h" });
		expect(toolbar.dataset.tool).toBe("hand");
		expect(h.props.panOnDrag).toBe(true);
		expect(h.props.selectionOnDrag).toBe(false);
		const input = document.createElement("input");
		document.body.append(input);
		fireEvent.keyDown(input, { key: "v" });
		expect(toolbar.dataset.tool).toBe("hand");
		fireEvent.keyDown(window, { key: "v" });
		expect(toolbar.dataset.tool).toBe("select");
		expect(h.props.panOnDrag).toEqual([1, 2]);
		input.remove();

		fireEvent.click(screen.getByText("zoom-in"));
		fireEvent.click(screen.getByText("zoom-out"));
		fireEvent.click(screen.getByText("zoom-reset"));
		expect(h.flow.zoomIn).toHaveBeenCalled();
		expect(h.flow.zoomOut).toHaveBeenCalled();
		expect(h.flow.zoomTo).toHaveBeenCalledWith(1, expect.any(Object));
		fireEvent.click(screen.getByText("hand"));
		expect(toolbar.dataset.tool).toBe("hand");
	});

	it("shows the whole board on manual fit, ignoring the readable floor", () => {
		renderView();
		fireEvent.click(screen.getByText("fit"));
		const [viewport] = h.flow.setViewport.mock.calls.at(-1)!;
		// jsdom has a 1px-wide canvas, so the whole board clamps to the minimum zoom.
		expect(viewport.zoom).toBe(0.2);
	});

	it("refits when side panels open until the user pans, and offsets for the left panel", () => {
		const { rerender } = renderView({ fitInsets: { left: 0, right: 0 } });
		const base = h.flow.setViewport.mock.calls.length;
		rerender({ fitInsets: { left: 0, right: 320 } });
		expect(h.flow.setViewport.mock.calls.length).toBe(base + 1);

		rerender({ fitInsets: { left: 200, right: 320 } });
		// Same-frame counter-pan of the left delta, then an auto refit.
		expect(h.flow.setViewport.mock.calls).toContainEqual([{ x: -100, y: 50, zoom: 1 }]);

		act(() => h.props.onMoveStart(null));
		act(() => h.props.onMoveStart(new MouseEvent("mousedown")));
		const afterManual = h.flow.setViewport.mock.calls.length;
		rerender({ fitInsets: { left: 200, right: 0 } });
		expect(h.flow.setViewport.mock.calls.length).toBe(afterManual);
	});

	it("pans to the section under review at a gate", () => {
		const { rerender } = renderView();
		const base = h.flow.setViewport.mock.calls.length;
		rerender({ focusSection: "elements" as ComicWorkflowSection });
		expect(h.flow.setViewport.mock.calls.length).toBe(base + 1);
		expect(h.flow.getNode).toHaveBeenCalledWith("frame:elements");
		// After panning to the gate, panel changes no longer pull the board back.
		rerender({ fitInsets: { left: 0, right: 300 } });
		expect(h.flow.setViewport.mock.calls.length).toBe(base + 1);
	});

	it("uses the dark colour mode and shows the zoom percentage", () => {
		h.zoom = 0.456;
		useThemeStore.setState({ theme: "dark" });
		renderView();
		expect(screen.getByTestId("toolbar").dataset.zoom).toBe("46");
		expect(h.props.colorMode).toBe("dark");
		act(() => useThemeStore.setState({ theme: "light" }));
		expect(h.props.colorMode).toBe("light");
	});
});

describe("boardViewport", () => {
	const board = { x: 0, y: 0, width: 2000, height: 800 };
	it("centres a board that fits without zooming past 1", () => {
		const vp = boardViewport({ x: 0, y: 0, width: 400, height: 200 }, { width: 1200, height: 900 });
		expect(vp.zoom).toBe(1);
		expect(vp.x).toBe(48 + (1104 - 400) / 2);
	});
	it("stops at the readable floor and centres on the focus box when the board is too big", () => {
		const focus = { x: 600, y: 0, width: 600, height: 400 };
		const vp = boardViewport(board, { width: 1000, height: 900 }, { left: 0, right: 0 }, focus);
		expect(vp.zoom).toBeCloseTo(12 / 13);
		expect(vp.x).toBeCloseTo(48 + (904 - 600 * (12 / 13)) / 2 - 600 * (12 / 13));
	});
	it("pins to the start edge when even the focus box overflows, and honours insets", () => {
		const vp = boardViewport(board, { width: 600, height: 300 }, { left: 100, right: 0 }, board, 0.2);
		expect(vp.zoom).toBeGreaterThanOrEqual(0.2);
		const tight = boardViewport(board, { width: 200, height: 200 }, { left: 0, right: 0 }, board, 1);
		expect(tight).toEqual({ x: 48, y: 48, zoom: 1 });
	});
});
