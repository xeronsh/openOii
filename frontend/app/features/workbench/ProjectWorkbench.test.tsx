import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appQueryClient } from "~/query/client";
import { patchRunState } from "~/query/runState";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { useEditorStore } from "~/stores/editorStore";
import { ApiError } from "~/types/errors";
import type { Character, Project, Shot } from "~/types";
import { ProjectWorkbench } from "./ProjectWorkbench";

/**
 * The workbench shell wires run control, selection, inbox, export and version
 * drawers together. Heavy children are replaced by stubs that expose the props the
 * shell hands them, so each test checks the wiring the user relies on.
 */
const h = vi.hoisted(() => ({
	data: {} as { project?: unknown; characters: unknown[]; shots: unknown[]; projectLoading: boolean; projectError: unknown },
	mobile: false,
	controller: {
		handleGenerate: vi.fn(),
		handleFeedback: vi.fn(),
		handleConfirm: vi.fn(),
		handleCancel: vi.fn(),
		handleResume: vi.fn(),
		handleRestorePrevious: vi.fn(),
		generatePending: false,
		gateDecisionPending: false,
		restorePending: false,
		lastRunStatus: null as string | null,
	},
	controllerArgs: [] as Array<Record<string, unknown>>,
	api: {
		exportApi: { triggerWebtoon: vi.fn(), getStatus: vi.fn() },
		projectsApi: { getRegeneratePlan: vi.fn(), currentRun: vi.fn() },
		getStaticUrl: (url?: string | null) => (url ? `http://static${url}` : null),
	},
	toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("~/features/projects/useProjectData", () => ({ useProjectData: () => h.data }));
vi.mock("~/features/run/useRunController", () => ({
	useRunController: (args: Record<string, unknown>) => {
		h.controllerArgs.push(args);
		return h.controller;
	},
}));
vi.mock("~/services/api", () => h.api);
vi.mock("~/utils/toast", () => ({ toast: h.toast }));
vi.mock("~/features/comic-workflow/mobile/useIsMobileWorkbench", () => ({
	useIsMobileWorkbench: () => h.mobile,
	isMobileWorkbenchViewport: () => false,
}));
vi.mock("~/features/workbench/workbenchChunks", () => ({
	loadViewportWorkbenchChunks: () => Promise.resolve(),
	prefetchOtherWorkbenchChunk: () => undefined,
	keyboardLayerChunk: { name: "keyboard" },
	mobilePreviewChunk: { name: "mobile" },
}));
vi.mock("~/utils/preloadComponent", () => ({
	usePreloadedComponent: (chunk: { name: string }, enabled: boolean) => {
		if (!enabled) return null;
		if (chunk.name === "keyboard") return () => <div data-testid="keyboard-layer" />;
		return (props: { inbox: ReactNode; activity: ReactNode; timing: ReactNode; primaryAction: ReactNode; videoUrl: string | null }) => (
			<div data-testid="mobile-preview" data-video={props.videoUrl ?? ""}>
				{props.inbox}
				{props.activity}
				{props.timing}
				{props.primaryAction}
			</div>
		);
	},
}));
vi.mock("~/components/layout/TopBar", () => ({ TopBar: ({ center }: { center: ReactNode }) => <header>{center}</header> }));
vi.mock("~/components/layout/StudioControls", () => ({
	StudioControls: (p: Record<string, any>) => (
		<div data-testid="studio" data-status={p.studioStatus.kind} data-pending={p.studioStatus.pendingCount} data-download={p.downloadUrl ?? ""} data-previous={p.previousDownloadUrl ?? ""}>
			<button onClick={p.onGenerate} disabled={p.generateDisabled}>生成</button>
			<button onClick={p.onCancel}>停止</button>
			<button onClick={p.onOpenInbox}>收件箱</button>
			<button onClick={p.onExport} disabled={p.exportBusy}>导出</button>
			<button onClick={p.onOpenVersions}>版本</button>
			{p.onRestorePrevious ? <button onClick={p.onRestorePrevious}>恢复上一版按钮</button> : null}
		</div>
	),
}));
vi.mock("~/features/comic-workflow/agent/AgentPanel", () => ({
	AgentPanel: (p: Record<string, any>) => (
		<aside data-testid="agent" data-tab={p.tab} data-collapsed={String(p.collapsed)} data-items={p.inboxItems.length}>
			<button onClick={() => p.onCollapsedChange(false)}>展开 Agent</button>
			{p.inboxItems.length ? <button onClick={() => p.inboxActions.onRetry()}>重试</button> : null}
			{p.inboxItems.length ? <button onClick={() => p.inboxActions.onSelectShot(12)}>看分镜</button> : null}
		</aside>
	),
}));
vi.mock("~/features/comic-workflow/agent/InboxPanel", () => ({ InboxPanel: () => <div data-testid="inbox" /> }));
vi.mock("~/components/chat/ChatPanel", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("~/features/comic-workflow/agent/RunTimingBar", () => ({ RunTimingBar: () => <div data-testid="timing" /> }));
vi.mock("~/features/comic-workflow/inspector/InspectorPanel", () => ({
	InspectorPanel: (p: Record<string, any>) => (
		<section data-testid="inspector" data-open={String(p.open)} data-node={p.selectedNode?.id ?? ""} data-brief={p.briefNode?.id ?? ""} data-locked={String(p.structureLocked)}>
			<button onClick={() => p.onOpenChange(true)}>打开检查器</button>
			<button onClick={() => p.onOpenChange(false)}>收起检查器</button>
		</section>
	),
}));
vi.mock("~/features/workbench/PromptBar", () => ({
	PromptBar: (p: Record<string, any>) => (
		<div data-testid="prompt" data-gate={p.gateLabel ?? ""}>
			{p.selection.map((chip: { id: string; label: string }) => (
				<button key={chip.id} onClick={() => p.onRemoveSelection?.(chip.id)}>
					{chip.label}
				</button>
			))}
		</div>
	),
}));
vi.mock("~/features/comic-workflow/canvas/ComicWorkflowCanvas", () => ({
	ComicWorkflowCanvas: (p: Record<string, any>) => (
		<div data-testid="canvas">
			<button onClick={() => p.onSelectedNodeIdsChange(["shot:12", "character:21", "output", "brief", "ghost"])}>多选</button>
			<button onClick={() => p.onSelectedNodeIdsChange([])}>清空选择</button>
			<button onClick={() => p.onSelectedNodeIdChange("shot:11")}>单选</button>
			<button onClick={p.onOpenAssets}>素材</button>
		</div>
	),
}));
vi.mock("~/components/panels/AssetDrawer", () => ({
	AssetDrawer: ({ onClose }: { onClose: () => void }) => <div data-testid="assets"><button onClick={onClose}>关素材</button></div>,
}));
vi.mock("~/components/panels/VersionCompareDrawer", () => ({
	VersionCompareDrawer: (p: Record<string, any>) => (
		<div data-testid="versions" data-entity={`${p.initialEntityType ?? ""}:${p.initialEntityId ?? ""}`}>
			<button onClick={p.onClose}>关版本</button>
		</div>
	),
}));
vi.mock("~/features/run/RegenerateDialog", () => ({
	RegenerateDialog: (p: Record<string, any>) =>
		p.open ? (
			<div role="dialog" aria-label="重新生成">
				<button onClick={p.onConfirm}>确认重新生成</button>
				<button onClick={p.onClose}>取消重新生成</button>
			</div>
		) : null,
}));

const PID = 5;
const baseProject = {
	id: PID,
	title: "雨夜",
	story: "s",
	style: "anime",
	status: "draft",
	video_url: null,
	blocking_clips: [],
	universe_id: null,
} as unknown as Project;
const characters = [{ id: 21, project_id: PID, name: "林夏", description: "d", image_url: null }] as unknown as Character[];
const shots = [
	{ id: 11, project_id: PID, order: 1, description: "一", image_url: null, video_url: null, character_ids: [21] },
	{ id: 12, project_id: PID, order: 2, description: "二", image_url: null, video_url: null, character_ids: [] },
] as unknown as Shot[];

function renderShell() {
	return render(
		<QueryClientProvider client={appQueryClient}>
			<MemoryRouter>
				<ProjectWorkbench projectId={PID} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	appQueryClient.clear();
	h.mobile = false;
	h.controllerArgs = [];
	h.controller.lastRunStatus = null;
	h.data = { project: baseProject, characters: [], shots: [], projectLoading: false, projectError: null };
	h.api.projectsApi.currentRun.mockReturnValue(new Promise(() => undefined));
	h.api.projectsApi.getRegeneratePlan.mockResolvedValue({ previous_version: null });
	useEditorStore.getState().setRunMode("manual");
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
});

describe("ProjectWorkbench states", () => {
	it("shows loading, a retryable load error, and not-found", () => {
		h.data = { characters: [], shots: [], projectLoading: true, projectError: null };
		const { unmount } = renderShell();
		expect(screen.getByText("正在加载项目…")).toBeInTheDocument();
		unmount();

		h.data = { characters: [], shots: [], projectLoading: false, projectError: new ApiError({ code: "X", message: "后端没响应", status: 502 }) };
		const invalidate = vi.spyOn(appQueryClient, "invalidateQueries");
		const second = renderShell();
		expect(screen.getByText("无法加载项目")).toBeInTheDocument();
		expect(screen.getByText("后端没响应")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /重试/ }));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["project", PID] });
		second.unmount();

		h.data = { characters: [], shots: [], projectLoading: false, projectError: new ApiError({ code: "X", message: "nf", status: 404 }) };
		renderShell();
		expect(screen.getByText("项目未找到")).toBeInTheDocument();
	});

	it("renders the desktop desk and titles the tab with status and project", async () => {
		renderShell();
		expect(screen.getByRole("heading", { name: "雨夜" })).toBeInTheDocument();
		expect(screen.getByTestId("keyboard-layer")).toBeInTheDocument();
		expect(await screen.findByTestId("canvas")).toBeInTheDocument();
		expect(document.title).toContain("雨夜 - openOii");
		expect(screen.getByTestId("inspector").dataset.brief).toBe("brief");
	});

	it("renders the mobile preview with a stop action while generating", () => {
		h.mobile = true;
		h.data = { ...h.data, project: { ...baseProject, video_url: "/v.mp4" } };
		patchRunState(PID, { isGenerating: true, currentRunId: 9 });
		renderShell();
		const preview = screen.getByTestId("mobile-preview");
		expect(preview.dataset.video).toBe("/v.mp4");
		expect(screen.getByTestId("timing")).toBeInTheDocument();
		expect(screen.queryByTestId("canvas")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
		expect(h.controller.handleCancel).toHaveBeenCalled();
		expect(screen.getByTestId("studio").dataset.download).toBe(`http://static/api/v1/projects/${PID}/final-video`);
	});
});

describe("ProjectWorkbench run control", () => {
	it("starts an empty project directly but confirms before regenerating existing work", async () => {
		const empty = renderShell();
		fireEvent.click(screen.getByRole("button", { name: "生成" }));
		expect(h.controller.handleGenerate).toHaveBeenCalledTimes(1);
		expect(h.controllerArgs.at(-1)!.onRequestRegenerate).toBeUndefined();
		empty.unmount();

		h.data = { ...h.data, characters, shots };
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "生成" }));
		expect(screen.getByRole("dialog", { name: "重新生成" })).toBeInTheDocument();
		expect(h.controller.handleGenerate).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "确认重新生成" }));
		expect(h.controller.handleGenerate).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("dialog", { name: "重新生成" })).toBeNull();
	});

	it("disables generate while a run is active and locks the inspector structure", () => {
		patchRunState(PID, { isGenerating: true, currentRunId: 3 });
		renderShell();
		expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
		expect(screen.getByTestId("inspector").dataset.locked).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "停止" }));
		expect(h.controller.handleCancel).toHaveBeenCalled();
	});

	it("offers restoring the previous version only when idle, and confirms first", async () => {
		h.data = { ...h.data, characters, shots };
		h.api.projectsApi.getRegeneratePlan.mockResolvedValue({
			previous_version: { run_id: 44, restorable: true, character_count: 1, shot_count: 2, video_url: "/old.mp4" },
		});
		renderShell();
		fireEvent.click(await screen.findByRole("button", { name: "恢复上一版按钮" }));
		expect(screen.getByText(/1 个角色、2 个分镜/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "恢复上一版" }));
		expect(h.controller.handleRestorePrevious).toHaveBeenCalledWith(44);
	});

	it("keeps the previous film downloadable while its regeneration runs", async () => {
		h.data = { ...h.data, characters, shots };
		h.api.projectsApi.getRegeneratePlan.mockResolvedValue({
			previous_version: { run_id: 44, restorable: true, video_url: "/old.mp4" },
		});
		patchRunState(PID, { isGenerating: true, currentRunId: 44 });
		renderShell();
		await waitFor(() => expect(screen.getByTestId("studio").dataset.previous).toBe("http://static/old.mp4"));
		expect(screen.queryByRole("button", { name: "恢复上一版按钮" })).toBeNull();
	});

	it("refreshes characters and shots once a finished run reports full progress", () => {
		patchRunState(PID, { isGenerating: false, progress: 1 });
		const invalidate = vi.spyOn(appQueryClient, "invalidateQueries");
		renderShell();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["characters", PID] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["shots", PID] });
	});
});

describe("ProjectWorkbench selection and gate", () => {
	it("turns the canvas selection into prompt chips and opens the inspector", async () => {
		h.data = { ...h.data, characters, shots, project: { ...baseProject, video_url: "/v.mp4" } };
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "收起检查器" }));
		expect(screen.getByTestId("inspector").dataset.open).toBe("false");
		fireEvent.click(await screen.findByRole("button", { name: "多选" }));
		const chips = screen.getByTestId("prompt").querySelectorAll("button");
		expect([...chips].map((b) => b.textContent)).toEqual(["分镜 S02", "角色 林夏", "成片", "项目"]);
		expect(screen.getByTestId("inspector").dataset.open).toBe("true");
		expect(screen.getByTestId("inspector").dataset.node).toBe("shot:12");
		expect(h.controllerArgs.at(-1)).toMatchObject({ selectedNodeId: "shot:12", selectedNodeIds: ["shot:12", "character:21", "output", "brief", "ghost"] });

		const emitted: unknown[] = [];
		const off = canvasEvents.on("set-workflow-selection", (data) => emitted.push(data));
		fireEvent.click(screen.getByRole("button", { name: "角色 林夏" }));
		off();
		expect(emitted).toEqual([{ nodeIds: ["shot:12", "output", "brief", "ghost"] }]);

		fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
		expect(screen.getByTestId("inspector").dataset.node).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "单选" }));
		expect(screen.getByTestId("inspector").dataset.node).toBe("shot:11");
	});

	it("labels the prompt with the gate step and switches the agent panel to the inbox", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
		patchRunState(PID, {
			isGenerating: true,
			currentRunId: 8,
			awaitingConfirm: true,
			awaitingAgent: "render",
			recoveryGate: { run_id: 8, current_stage: "render_shots", stage: "render_shots" } as never,
		});
		renderShell();
		expect(screen.getByTestId("prompt").dataset.gate).not.toBe("");
		await waitFor(() => expect(screen.getByTestId("agent").dataset.tab).toBe("inbox"));
		expect(screen.getByTestId("agent").dataset.collapsed).toBe("false");
		// Narrow studio: opening the agent panel closed the inspector.
		expect(screen.getByTestId("inspector").dataset.open).toBe("false");
		expect(Number(screen.getByTestId("studio").dataset.pending)).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "打开检查器" }));
		expect(screen.getByTestId("agent").dataset.collapsed).toBe("true");

		// Clearing the gate returns the panel to the activity stream.
		act(() => patchRunState(PID, { awaitingConfirm: false, recoveryGate: null, isGenerating: false, currentRunId: null }));
		await waitFor(() => expect(screen.getByTestId("agent").dataset.tab).toBe("activity"));
	});

	it("does not pop the inbox for a gate in auto-confirm mode", async () => {
		useEditorStore.getState().setRunMode("yolo");
		patchRunState(PID, { isGenerating: true, currentRunId: 8, awaitingConfirm: true, awaitingAgent: "plan" });
		renderShell();
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.getByTestId("agent").dataset.tab).toBe("activity");
	});

	it("routes inbox actions: retry via regenerate dialog and shot focus via canvas events", async () => {
		h.data = { ...h.data, characters, shots, project: { ...baseProject, status: "failed" } };
		h.controller.lastRunStatus = "failed";
		renderShell();
		fireEvent.click(await screen.findByRole("button", { name: "重试" }));
		expect(screen.getByRole("dialog", { name: "重新生成" })).toBeInTheDocument();
		const selected: unknown[] = [];
		const off = canvasEvents.on("select-workflow-node", (d) => selected.push(d));
		fireEvent.click(screen.getByRole("button", { name: "看分镜" }));
		off();
		expect(selected).toEqual([{ nodeId: "shot:12" }]);
	});
});

describe("ProjectWorkbench drawers and export", () => {
	it("opens assets from the canvas and versions from the toolbar or a card", async () => {
		renderShell();
		fireEvent.click(await screen.findByRole("button", { name: "素材" }));
		expect(await screen.findByTestId("assets")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "关素材" }));
		expect(screen.queryByTestId("assets")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "版本" }));
		expect((await screen.findByTestId("versions")).dataset.entity).toBe(":");
		fireEvent.click(screen.getByRole("button", { name: "关版本" }));
		act(() => canvasEvents.emit("version-history", { entityType: "shot", entityId: 12 } as never));
		expect((await screen.findByTestId("versions")).dataset.entity).toBe("shot:12");
		fireEvent.click(screen.getByRole("button", { name: "关版本" }));
		act(() => canvasEvents.emit("version-history", {} as never));
		expect((await screen.findByTestId("versions")).dataset.entity).toBe(":");
	});

	it("polls a webtoon export until it completes and offers the download", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			h.api.exportApi.triggerWebtoon.mockResolvedValue({ export_id: "e1" });
			h.api.exportApi.getStatus
				.mockResolvedValueOnce({ status: "processing" })
				.mockResolvedValueOnce({ status: "completed", download_url: "/exports/e1.png" });
			const open = vi.spyOn(window, "open").mockImplementation(() => null);
			renderShell();
			fireEvent.click(screen.getByRole("button", { name: "导出" }));
			await vi.waitFor(() => expect(h.toast.info).toHaveBeenCalledWith(expect.objectContaining({ title: "导出中" })));
			expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
			await vi.waitFor(() => expect(h.api.exportApi.getStatus).toHaveBeenCalledTimes(1));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			await vi.waitFor(() => expect(h.toast.success).toHaveBeenCalled());
			expect(h.api.exportApi.getStatus).toHaveBeenCalledWith(PID, "e1");
			const done = h.toast.success.mock.calls[0]![0];
			expect(done.title).toBe("导出完成");
			done.actions[0].onClick();
			expect(open).toHaveBeenCalledWith("http://static/exports/e1.png", "_blank");
			await vi.waitFor(() => expect(screen.getByRole("button", { name: "导出" })).not.toBeDisabled());
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a failed export and an export that could not start", async () => {
		h.api.exportApi.triggerWebtoon.mockResolvedValueOnce({ export_id: "e2" });
		h.api.exportApi.getStatus.mockResolvedValueOnce({ status: "failed" });
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "导出" }));
		await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith({ title: "导出失败", message: "生成失败，请重试" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "导出" })).not.toBeDisabled());
		h.api.exportApi.triggerWebtoon.mockRejectedValueOnce(new Error("没有分镜"));
		fireEvent.click(screen.getByRole("button", { name: "导出" }));
		await waitFor(() => expect(h.toast.error).toHaveBeenLastCalledWith({ title: "导出失败", message: "没有分镜" }));
	});
});
