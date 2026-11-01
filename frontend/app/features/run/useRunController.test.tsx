import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appQueryClient } from "~/query/client";
import { readMessageFeed, appendMessage } from "~/query/messageFeed";
import { patchRunState, readRunState } from "~/query/runState";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { useEditorStore } from "~/stores/editorStore";
import { ApiError } from "~/types/errors";
import type { Character, Project, RecoveryControlRead, Shot } from "~/types";
import { useRunController } from "./useRunController";

const api = vi.hoisted(() => ({
	projectsApi: { startRun: vi.fn(), recompose: vi.fn() },
	chatApi: { send: vi.fn() },
	runsApi: { confirm: vi.fn(), gateFeedback: vi.fn(), cancel: vi.fn(), resume: vi.fn(), restorePrevious: vi.fn() },
}));
const send = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("~/services/api", () => api);
vi.mock("~/hooks/useWebSocket", () => ({ useProjectWebSocket: () => ({ send }) }));
vi.mock("~/utils/toast", () => ({ toast }));

const PID = 7;
const project = { id: PID, title: "P", skill_id: null } as unknown as Project;
const shots = [{ id: 11, order: 1 }, { id: 12, order: 2 }] as Shot[];
const characters = [{ id: 21, name: "林夏" }, { id: 22, name: "" }] as Character[];

function run(id: number, extra: Record<string, unknown> = {}) {
	return { id, project_id: PID, status: "running", current_agent: "plan", progress: 0.1, provider_snapshot: null, ...extra };
}

function control(state: "active" | "recoverable", runId = 40): RecoveryControlRead {
	return {
		state,
		detail: "",
		available_actions: ["resume", "cancel"],
		active_run: run(runId, { current_agent: "render", progress: 0.6 }),
		recovery_summary: {
			project_id: PID,
			run_id: runId,
			current_stage: "render_shots",
			next_stage: "compose_videos",
			preserved_stages: [],
			stage_history: [],
			resumable: state === "recoverable",
		},
	} as unknown as RecoveryControlRead;
}

const conflict = (response?: unknown) =>
	new ApiError({ code: "RUN_ALREADY_ACTIVE", message: "busy", status: 409, response });

type Args = Parameters<typeof useRunController>[0];

function setup(overrides: Partial<Args> = {}, url = "/project/7") {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	let params: ReturnType<typeof useSearchParams>[0] | undefined;
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
		</QueryClientProvider>
	);
	const initial: Args = {
		projectId: PID,
		project,
		characters,
		shots,
		currentRunId: null,
		isGenerating: false,
		recoveryControl: null,
		selectedNodeId: null,
		selectedNodeIds: [],
		...overrides,
	};
	const hook = renderHook(
		(props: Args) => {
			params = useSearchParams()[0];
			return useRunController(props);
		},
		{ wrapper, initialProps: initial },
	);
	return { ...hook, initial, params: () => params };
}

beforeEach(() => {
	vi.clearAllMocks();
	appQueryClient.clear();
	useEditorStore.getState().setRunMode("manual");
});

describe("useRunController · start", () => {
	it("starts a run, clears the old feed and adopts the server run", async () => {
		appendMessage(PID, { agent: "user", role: "user", content: "old", timestamp: "t" });
		api.projectsApi.startRun.mockResolvedValue(run(31));
		useEditorStore.getState().setRunMode("yolo");
		const { result } = setup({}, "/project/7?skill=comic-pro");
		act(() => result.current.handleGenerate());
		expect(readRunState(PID)).toMatchObject({ startingRun: true, currentStage: "plan" });
		expect(readMessageFeed(PID)).toEqual([]);
		await waitFor(() => expect(readRunState(PID).currentRunId).toBe(31));
		expect(api.projectsApi.startRun).toHaveBeenCalledWith(PID, { auto_mode: true, skill_id: "comic-pro" });
		expect(readRunState(PID)).toMatchObject({ isGenerating: true, currentAgent: "plan", progress: 0.1, startingRun: false });
	});

	it("does nothing while a run is active", () => {
		const { result } = setup({ currentRunId: 5 });
		act(() => result.current.handleGenerate());
		expect(api.projectsApi.startRun).not.toHaveBeenCalled();
	});

	it("takes over an active run reported by a 409 and moves to its stage", async () => {
		api.projectsApi.startRun.mockRejectedValue(conflict(control("active")));
		const { result } = setup();
		act(() => result.current.handleGenerate());
		await waitFor(() => expect(toast.info).toHaveBeenCalled());
		expect(toast.info.mock.calls[0]![0].title).toBe("已有生成正在进行");
		expect(readRunState(PID)).toMatchObject({ isGenerating: true, currentRunId: 40, currentAgent: "render", progress: 0.6, currentStage: "compose" });
	});

	it("offers recovery for a recoverable run without claiming it is generating", async () => {
		api.projectsApi.startRun.mockRejectedValue(conflict(control("recoverable")));
		const { result } = setup();
		act(() => result.current.handleGenerate());
		await waitFor(() => expect(toast.info).toHaveBeenCalled());
		expect(toast.info.mock.calls[0]![0].title).toBe("发现可恢复的运行");
		expect(readRunState(PID).isGenerating).toBe(false);
		expect(readRunState(PID).recoveryControl?.state).toBe("recoverable");
	});

	it("asks to wait on a bare 409 and reports other failures", async () => {
		api.projectsApi.startRun.mockRejectedValueOnce(conflict());
		const { result } = setup();
		act(() => result.current.handleGenerate());
		await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.objectContaining({ title: "请稍等片刻" })));
		api.projectsApi.startRun.mockRejectedValueOnce(new Error("provider exploded"));
		act(() => result.current.handleGenerate());
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ title: "生成失败", message: "provider exploded" })),
		);
		expect(readRunState(PID).startingRun).toBe(false);
	});

	it("explains an incompatible workflow version instead of asking to wait", async () => {
		const incompatible = () =>
			new ApiError({
				code: "RUN_WORKFLOW_INCOMPATIBLE",
				message: "运行 40 使用工作流版本 1，当前引擎是版本 2，无法继续；请重新生成",
				status: 409,
			});
		api.projectsApi.startRun.mockRejectedValueOnce(incompatible());
		const { result } = setup();
		act(() => result.current.handleGenerate());
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				expect.objectContaining({ title: "生成失败", message: expect.stringContaining("工作流版本 1") }),
			),
		);
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("ignores a start response that arrives after the user cancelled", async () => {
		let resolveStart!: (value: unknown) => void;
		api.projectsApi.startRun.mockReturnValue(new Promise((r) => (resolveStart = r)));
		api.runsApi.cancel.mockResolvedValue({ status: "no_active_run" });
		const { result } = setup({ recoveryControl: control("active", 99) });
		act(() => result.current.handleGenerate());
		act(() => result.current.handleCancel());
		await act(async () => resolveStart(run(32)));
		expect(readRunState(PID).currentRunId).not.toBe(32);
	});

	it("auto-starts once from ?autoStart=true and picks yolo for quick projects", async () => {
		api.projectsApi.startRun.mockResolvedValue(run(33));
		const quick = { ...project, creation_mode: "quick" } as Project;
		const { params, rerender, initial } = setup({ project: quick }, "/project/7?autoStart=true&skill=x");
		await waitFor(() => expect(api.projectsApi.startRun).toHaveBeenCalledTimes(1));
		expect(api.projectsApi.startRun).toHaveBeenCalledWith(PID, { auto_mode: true, skill_id: "x" });
		expect(params()?.get("autoStart")).toBeNull();
		rerender({ ...initial, project: { ...quick } });
		expect(api.projectsApi.startRun).toHaveBeenCalledTimes(1);
	});
});

describe("useRunController · assistant chat", () => {
	it.each([
		[[], null, "改"],
		[["shot:12"], null, "改\n（选中：分镜 #12（第 2 镜））"],
		[[], "character:21", "改\n（选中：角色 #21（林夏））"],
		[["shot:99", "character:22", "brief:1"], null, "改\n（选中：分镜 #99、角色 #22）"],
	])("sends the message with selection %j / %s as context", async (ids, single, sent) => {
		api.chatApi.send.mockResolvedValue({ accepted: true });
		const { result } = setup({ selectedNodeIds: ids, selectedNodeId: single });
		let ok = false;
		await act(async () => {
			ok = await result.current.handleChat("改");
		});
		expect(ok).toBe(true);
		expect(api.chatApi.send).toHaveBeenCalledWith(PID, sent);
	});

	it("keeps the draft when the assistant is busy or the request fails", async () => {
		const { result } = setup();
		api.chatApi.send.mockRejectedValueOnce(conflict());
		let ok = true;
		await act(async () => {
			ok = await result.current.handleChat("a");
		});
		expect(ok).toBe(false);
		expect(toast.info).toHaveBeenLastCalledWith(expect.objectContaining({ message: "助手还在回答上一条消息" }));
		api.chatApi.send.mockRejectedValueOnce(new Error("offline"));
		await act(async () => {
			await result.current.handleChat("b");
		});
		expect(toast.error).toHaveBeenLastCalledWith(expect.objectContaining({ title: "发送失败", message: "offline" }));
		api.chatApi.send.mockRejectedValueOnce("boom");
		await act(async () => {
			await result.current.handleChat("c");
		});
		expect(toast.error).toHaveBeenLastCalledWith(expect.objectContaining({ message: "请重试" }));
		expect(readMessageFeed(PID)).toEqual([]);
	});
});

describe("useRunController · gate decisions", () => {
	it("approves without feedback and falls back to the websocket when offline", async () => {
		api.runsApi.confirm.mockResolvedValueOnce({});
		const { result } = setup({ currentRunId: 60 });
		let ok = false;
		await act(async () => {
			ok = await result.current.handleConfirm("  ");
		});
		expect(ok).toBe(true);
		expect(api.runsApi.confirm).toHaveBeenCalledWith(60);
		api.runsApi.confirm.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await act(async () => {
			ok = await result.current.handleConfirm();
		});
		expect(ok).toBe(false);
		expect(send).toHaveBeenCalledWith({ type: "confirm", data: { run_id: 60 } });
		api.runsApi.confirm.mockRejectedValueOnce(new ApiError({ code: "X", message: "已经批准", status: 409 }));
		await act(async () => {
			await result.current.handleConfirm();
		});
		expect(toast.info).toHaveBeenLastCalledWith(expect.objectContaining({ title: "运行状态已变化", message: "已经批准" }));
		api.runsApi.confirm.mockRejectedValueOnce(new ApiError({ code: "X", message: "boom", status: 500 }));
		await act(async () => {
			await result.current.handleConfirm();
		});
		expect(toast.error).toHaveBeenLastCalledWith(expect.objectContaining({ title: "确认没有生效" }));
	});

	it("returns false without a run", async () => {
		const { result } = setup();
		await expect(result.current.handleConfirm()).resolves.toBe(false);
	});

	it("sends targeted change requests and records a receipt once", async () => {
		patchRunState(PID, { currentRunId: 61, recoveryGate: { current_stage: "render_approval", feedback: { round: 2 } } as never });
		api.runsApi.gateFeedback.mockResolvedValue({ feedback_id: "fb1" });
		const { result } = setup({ selectedNodeIds: ["shot:12", "shot:x"] });
		await act(async () => {
			await result.current.handleConfirm("第二格换夜景");
		});
		expect(api.runsApi.gateFeedback).toHaveBeenCalledWith(61, { content: "第二格换夜景", entity_type: "shot", entity_ids: [12] });
		expect(readRunState(PID).feedbackReceipt).toMatchObject({ id: "fb1", round: 3, gate: "render_approval", entityType: "shot", entityIds: [12] });
		// The same receipt id from a retry does not create a new round.
		await act(async () => {
			await result.current.handleConfirm("第二格换夜景");
		});
		expect(readRunState(PID).feedbackReceipt?.round).toBe(3);
	});

	it("binds a mixed selection into the text and requests the whole stage", async () => {
		api.runsApi.gateFeedback.mockResolvedValue({ feedback_id: "fb2", round: 1 });
		const { result } = setup({ currentRunId: 62, selectedNodeIds: ["shot:11", "shot:99", "character:21", "character:23", "beat:1"] });
		await act(async () => {
			await result.current.handleConfirm("统一色调");
		});
		expect(api.runsApi.gateFeedback).toHaveBeenCalledWith(62, {
			content: "统一色调\n（绑定：S01、一格分镜、林夏、角色23、beat:1）",
		});
		api.runsApi.gateFeedback.mockRejectedValueOnce(new ApiError({ code: "X", message: "nope", status: 400 }));
		let ok = true;
		await act(async () => {
			ok = await result.current.handleConfirm("再来");
		});
		expect(ok).toBe(false);
		expect(toast.error).toHaveBeenLastCalledWith(expect.objectContaining({ title: "修改意见没有提交" }));
	});

	it("sends character targets", async () => {
		api.runsApi.gateFeedback.mockResolvedValue({ feedback_id: "fb3" });
		const { result } = setup({ currentRunId: 63, selectedNodeIds: ["character:21"] });
		await act(async () => {
			await result.current.handleConfirm("头发更短");
		});
		expect(api.runsApi.gateFeedback).toHaveBeenCalledWith(63, { content: "头发更短", entity_type: "character", entity_ids: [21] });
	});
});

describe("useRunController · cancel / resume / recompose / restore", () => {
	it("stops the current run, resets state and posts a stop message", async () => {
		patchRunState(PID, { currentRunId: 70, isGenerating: true });
		api.runsApi.cancel.mockResolvedValue({ status: "cancelled", cancelled: 1 });
		const { result } = setup({ currentRunId: 70, isGenerating: true });
		act(() => result.current.handleCancel());
		act(() => result.current.handleCancel()); // double click is one request
		await waitFor(() => expect(result.current.lastRunStatus).toBe("cancelled"));
		expect(api.runsApi.cancel).toHaveBeenCalledTimes(1);
		expect(readRunState(PID)).toMatchObject({ currentRunId: null, isGenerating: false });
		expect(readMessageFeed(PID).at(-1)).toMatchObject({ content: "生成已停止", icon: "stop" });
	});

	it("syncs when the run had already finished, and warns while it is still stopping", async () => {
		patchRunState(PID, { currentRunId: 71 });
		api.runsApi.cancel.mockResolvedValueOnce({ status: "no_active_run" });
		const { result } = setup({ currentRunId: 71 });
		act(() => result.current.handleCancel());
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.objectContaining({ title: "运行状态已同步" })));
		expect(readRunState(PID).currentRunId).toBeNull();
		api.runsApi.cancel.mockResolvedValueOnce({ status: "cancelling", cancelled: 0 });
		act(() => result.current.handleCancel());
		await waitFor(() => expect(toast.info).toHaveBeenLastCalledWith(expect.objectContaining({ title: "停止尚未完成" })));
	});

	it("treats a failed cancel as unknown and resyncs", async () => {
		patchRunState(PID, { currentRunId: 72 });
		api.runsApi.cancel.mockRejectedValue(new Error("timeout"));
		const { result } = setup({ currentRunId: 72 });
		act(() => result.current.handleCancel());
		await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.objectContaining({ title: "停止结果未知", details: "timeout" })));
		expect(readRunState(PID).currentRunId).toBeNull();
	});

	it("cancels a recoverable run that has no live executor and ignores a no-run cancel", async () => {
		api.runsApi.cancel.mockResolvedValue({ status: "cancelled", cancelled: 1 });
		const empty = setup();
		act(() => empty.result.current.handleCancel());
		expect(api.runsApi.cancel).not.toHaveBeenCalled();
		patchRunState(PID, { recoveryControl: control("recoverable", 73) });
		const { result } = setup({ recoveryControl: control("recoverable", 73) });
		act(() => result.current.handleCancel());
		await waitFor(() => expect(result.current.lastRunStatus).toBe("cancelled"));
		expect(api.runsApi.cancel).toHaveBeenCalledWith(73);
	});

	it("resumes only a recoverable run, at its next stage", async () => {
		api.runsApi.resume.mockResolvedValue(run(74, { current_agent: "compose", progress: 0.8 }));
		const active = setup({ recoveryControl: control("active", 74) });
		act(() => active.result.current.handleResume());
		expect(api.runsApi.resume).not.toHaveBeenCalled();
		const { result } = setup({ recoveryControl: control("recoverable", 74) });
		act(() => result.current.handleResume());
		await waitFor(() => expect(readRunState(PID).currentRunId).toBe(74));
		expect(readRunState(PID)).toMatchObject({ isGenerating: true, currentAgent: "compose", currentStage: "compose", recoveryControl: null });
	});

	it("reports a failed resume", async () => {
		api.runsApi.resume.mockRejectedValue(new ApiError({ code: "X", message: "engine down", status: 503 }));
		const { result } = setup({ recoveryControl: control("recoverable") });
		act(() => result.current.handleResume());
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ title: "恢复失败", message: "engine down" })));
	});

	it("routes canvas regenerate requests: resume, recompose, confirm dialog, or plain start", async () => {
		api.runsApi.resume.mockResolvedValue(run(80));
		api.projectsApi.recompose.mockResolvedValue(run(81, { current_agent: "compose" }));
		api.projectsApi.startRun.mockResolvedValue(run(82));

		const recoverable = setup({ recoveryControl: control("recoverable", 80) });
		act(() => canvasEvents.emit("request-regenerate", { mode: "recompose" } as never));
		await waitFor(() => expect(api.runsApi.resume).toHaveBeenCalledWith(80));
		recoverable.unmount();

		const plain = setup();
		act(() => canvasEvents.emit("request-regenerate", { mode: "recompose" } as never));
		await waitFor(() => expect(readRunState(PID).currentRunId).toBe(81));
		expect(readRunState(PID).currentStage).toBe("compose");
		act(() => canvasEvents.emit("request-regenerate", { mode: "full" } as never));
		await waitFor(() => expect(api.projectsApi.startRun).toHaveBeenCalled());
		plain.unmount();

		const onRequestRegenerate = vi.fn();
		const dialog = setup({ onRequestRegenerate });
		act(() => canvasEvents.emit("request-regenerate", { mode: "full" } as never));
		expect(onRequestRegenerate).toHaveBeenCalledTimes(1);
		dialog.unmount();
	});

	it("reports a failed recompose", async () => {
		api.projectsApi.recompose.mockRejectedValue(new Error("no shots"));
		setup();
		act(() => canvasEvents.emit("request-regenerate", { mode: "recompose" } as never));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ title: "重新合成失败", message: "no shots" })));
	});

	it("restores the previous version and says when there was nothing to restore", async () => {
		api.runsApi.restorePrevious.mockResolvedValueOnce({ restored: true }).mockResolvedValueOnce({ restored: false });
		const { result } = setup();
		act(() => result.current.handleRestorePrevious(90));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "已恢复上一版" })));
		await waitFor(() => expect(result.current.restorePending).toBe(false));
		act(() => result.current.handleRestorePrevious(90));
		await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith(expect.objectContaining({ title: "已经是上一版" })));
		api.runsApi.restorePrevious.mockRejectedValueOnce(new Error("gone"));
		await waitFor(() => expect(result.current.restorePending).toBe(false));
		act(() => result.current.handleRestorePrevious(90));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ title: "恢复失败", message: "gone" })));
	});
});
