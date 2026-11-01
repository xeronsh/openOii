import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { appQueryClient } from "~/query/client";
import { patchRunState } from "~/query/runState";
import { ComicWorkflowCanvas } from "./ComicWorkflowCanvas";

const h = vi.hoisted(() => ({ view: {} as Record<string, any> }));
vi.mock("./flow/FlowWorkflowView", () => ({
	FlowWorkflowView: (props: Record<string, any>) => {
		h.view = props;
		return (
			<div data-testid="flow" data-mode={props.interactionMode} data-locked={String(props.structureLocked)} data-focus={props.focusSection ?? ""}>
				{props.graph.nodes.map((n: { id: string }) => n.id).join(",")}
				<button onClick={props.onToggleSortMode}>toggle-sort</button>
				<button onClick={props.onSorted}>sorted</button>
			</div>
		);
	},
}));
vi.mock("~/components/canvas/PreviewModals", () => ({
	ImagePreviewModal: ({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) => (
		<div role="dialog" aria-label={`image ${alt}`} data-src={src}>
			<button onClick={onClose}>close-image</button>
		</div>
	),
	VideoPreviewModal: ({ src, title, onClose }: { src: string; title: string; onClose: () => void }) => (
		<div role="dialog" aria-label={`video ${title}`} data-src={src}>
			<button onClick={onClose}>close-video</button>
		</div>
	),
}));
const api = vi.hoisted(() => ({
	projectsApi: { get: vi.fn(), getCharacters: vi.fn(), getShots: vi.fn(), currentRun: vi.fn() },
}));
vi.mock("~/services/api", () => api);

const PID = 8;
const project = { id: PID, title: "雨夜", story: "s", style: "anime", status: "draft", video_url: null, blocking_clips: [], universe_id: null };
const shots = [{ id: 11, project_id: PID, order: 1, description: "一", image_url: null, video_url: null, character_ids: [] }];

function renderCanvas(props: Partial<Parameters<typeof ComicWorkflowCanvas>[0]> = {}) {
	return render(
		<QueryClientProvider client={appQueryClient}>
			<ComicWorkflowCanvas projectId={PID} {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	appQueryClient.clear();
	api.projectsApi.get.mockResolvedValue(project);
	api.projectsApi.getCharacters.mockResolvedValue([]);
	api.projectsApi.getShots.mockResolvedValue(shots);
	api.projectsApi.currentRun.mockReturnValue(new Promise(() => undefined));
});

describe("ComicWorkflowCanvas", () => {
	it("shows a loading state, then the workflow built from project data", async () => {
		renderCanvas();
		expect(screen.getByText("正在加载工作流…")).toBeInTheDocument();
		const flow = await screen.findByTestId("flow");
		expect(flow.textContent).toContain("shot:11");
		expect(flow.dataset.mode).toBe("layout");
		expect(flow.dataset.locked).toBe("false");
		expect(api.projectsApi.get).toHaveBeenCalledWith(PID);
	});

	it("toggles sort mode, ends it after sorting, and forces it off when a run starts", async () => {
		renderCanvas();
		const flow = await screen.findByTestId("flow");
		fireEvent.click(screen.getByText("toggle-sort"));
		expect(flow.dataset.mode).toBe("sort");
		expect(h.view.sortMode).toBe(true);
		fireEvent.click(screen.getByText("sorted"));
		expect(flow.dataset.mode).toBe("layout");

		fireEvent.click(screen.getByText("toggle-sort"));
		act(() => patchRunState(PID, { currentRunId: 3 }));
		await waitFor(() => expect(flow.dataset.mode).toBe("locked"));
		expect(flow.dataset.locked).toBe("true");
		expect(h.view.sortMode).toBe(false);
	});

	it("pans to the gate's section only while awaiting confirmation", async () => {
		patchRunState(PID, { currentRunId: 4, recoveryGate: { current_stage: "shots_approval" } as never });
		renderCanvas();
		const flow = await screen.findByTestId("flow");
		expect(flow.dataset.focus).toBe("");
		act(() => patchRunState(PID, { awaitingConfirm: true }));
		await waitFor(() => expect(flow.dataset.focus).toBe("shotline"));
		expect(flow.dataset.mode).toBe("locked");
	});

	it("opens and closes image and video previews from canvas events", async () => {
		renderCanvas();
		await screen.findByTestId("flow");
		act(() => canvasEvents.emit("preview-image", { src: "/a.png", alt: "S01" }));
		expect(screen.getByRole("dialog", { name: "image S01" })).toHaveAttribute("data-src", "/a.png");
		fireEvent.click(screen.getByText("close-image"));
		act(() => canvasEvents.emit("preview-video", { src: "/a.mp4", title: "最终成片" }));
		expect(screen.getByRole("dialog", { name: "video 最终成片" })).toBeInTheDocument();
		fireEvent.click(screen.getByText("close-video"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("forwards selection events to the workbench and stops listening on unmount", async () => {
		const one = vi.fn();
		const many = vi.fn();
		const { unmount } = renderCanvas({ onSelectedNodeIdChange: one, onSelectedNodeIdsChange: many });
		await screen.findByTestId("flow");
		act(() => canvasEvents.emit("select-workflow-node", { nodeId: "shot:11" }));
		expect(one).toHaveBeenLastCalledWith("shot:11");
		expect(many).toHaveBeenLastCalledWith(["shot:11"]);
		act(() => canvasEvents.emit("select-workflow-node", { nodeId: "" }));
		expect(many).toHaveBeenLastCalledWith([]);
		act(() => canvasEvents.emit("set-workflow-selection", { nodeIds: ["shot:11", "output"] }));
		expect(one).toHaveBeenLastCalledWith("shot:11");
		expect(many).toHaveBeenLastCalledWith(["shot:11", "output"]);
		act(() => canvasEvents.emit("set-workflow-selection", { nodeIds: [] }));
		expect(one).toHaveBeenLastCalledWith(null);
		unmount();
		const calls = one.mock.calls.length;
		canvasEvents.emit("select-workflow-node", { nodeId: "shot:11" });
		expect(one.mock.calls.length).toBe(calls);
	});
});
