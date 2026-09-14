import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import type { AgentMessage } from "~/types";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "~/stores/editorStore";
import { patchRunState, resetRunState } from "~/query/runState";
import type { WorkflowStage } from "~/types";
import { ChatPanel } from "./ChatPanel";

function setChatFeed(messages: AgentMessage[]): void {
	appQueryClient.setQueryData(projectQueryKeys.messageFeed(1), messages);
}

const onSendFeedback = vi.fn();
const onConfirm = vi.fn();
const onCancel = vi.fn();

function seedRunState(patch: Parameters<typeof patchRunState>[1]): void {
	patchRunState(1, patch);
}

vi.mock("./MessageList", () => ({
	MessageList: () => <div data-testid="message-list" />,
}));

const toastInfo = vi.fn();
vi.mock("~/utils/toast", () => ({
	toast: {
		info: (...args: unknown[]) => toastInfo(...args),
		error: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
	},
}));

function renderChatPanel(isGenerating = false) {
	// ChatPanel reads the chat feed from the query cache (ADR 0007).
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
	);
	return render(
		<ChatPanel
			projectId={1}
			onSendFeedback={onSendFeedback}
			onConfirm={onConfirm}
			onCancel={onCancel}
			isGenerating={isGenerating}
		/>,
		{ wrapper },
	);
}

describe("ChatPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(HTMLElement.prototype, "scrollTo", {
			configurable: true,
			value: vi.fn(),
		});
		appQueryClient.setQueryData(projectQueryKeys.messageFeed(1), []);
		resetRunState(1);
		useEditorStore.getState().setRunMode("manual");
	});

	it("keeps global generation out of the empty chat state", () => {
		renderChatPanel(false);

		expect(screen.getByText("当前阶段暂无对话")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "开始生成漫剧" }),
		).not.toBeInTheDocument();
	});

	it("shows processing state and stop button while generating", () => {
		seedRunState({ currentAgent: "plan" });

		renderChatPanel(true);

		expect(screen.getByText(/规划…|处理中…/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
	});

	it("shows awaiting confirm area and sends trimmed feedback to confirm", async () => {
		const user = userEvent.setup();
		seedRunState({ awaitingConfirm: true, awaitingAgent: "plan" });
		setChatFeed([
			{
				id: "1",
				agent: "plan",
				role: "assistant",
				content: "完整内容",
				summary: "规划摘要",
			},
		]);

		renderChatPanel(true);

		expect(screen.getByText(/规划 已完成/)).toBeInTheDocument();

		await user.type(screen.getByRole("textbox"), "  修改剧情节奏  ");
		await user.click(screen.getByRole("button", { name: /通过/ }));

		expect(onConfirm).toHaveBeenLastCalledWith("修改剧情节奏");
	});

	it("toggles between review and quick mode", async () => {
		const user = userEvent.setup();
		useEditorStore.getState().setRunMode("manual");

		renderChatPanel(false);

		await user.click(screen.getByRole("button", { name: "切换快速生成模式" }));

		expect(useEditorStore.getState().runMode).toBe("yolo");
	});

	it("confirms the current gate when switching to quick mode while awaiting confirmation", async () => {
		const user = userEvent.setup();
		seedRunState({ awaitingConfirm: true, awaitingAgent: "plan" });
		useEditorStore.getState().setRunMode("manual");
		setChatFeed([
			{
				id: "1",
				agent: "plan",
				role: "assistant",
				content: "规划完成",
			},
		]);

		renderChatPanel(true);

		await user.click(screen.getByRole("button", { name: "切换快速生成模式" }));

		expect(useEditorStore.getState().runMode).toBe("yolo");
		expect(onConfirm).toHaveBeenLastCalledWith(undefined);
	});

	it("hides manual confirm bar in YOLO mode", () => {
		seedRunState({ awaitingConfirm: true, awaitingAgent: "plan" });
		useEditorStore.getState().setRunMode("yolo");

		renderChatPanel(true);

		expect(screen.queryByText(/已完成/)).not.toBeInTheDocument();
	});

	it("sends feedback through onSendFeedback outside generating and confirm states", async () => {
		const user = userEvent.setup();

		renderChatPanel(false);

		await user.type(screen.getByRole("textbox"), "  这里有建议  ");
		await user.click(screen.getByRole("button", { name: "发送" }));

		expect(onSendFeedback).toHaveBeenLastCalledWith("  这里有建议  ");
	});

	it("does not treat mid-run messages as confirm when not awaiting a gate", async () => {
		const user = userEvent.setup();
		seedRunState({ currentRunId: 99, awaitingConfirm: false });
		toastInfo.mockClear();

		renderChatPanel(true);

		await user.type(screen.getByRole("textbox"), "中途反馈");
		await user.click(screen.getByRole("button", { name: "发送" }));

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onSendFeedback).not.toHaveBeenCalled();
		expect(toastInfo).toHaveBeenCalled();
	});

	it("shows render stage icon when currentStage is render", () => {
		seedRunState({ currentStage: "render" as WorkflowStage });

		renderChatPanel(false);

		expect(screen.getByText("渲染阶段")).toBeInTheDocument();
	});

	it("shows render_approval stage icon when currentStage is render_approval", () => {
		seedRunState({ currentStage: "render_approval" as WorkflowStage });

		renderChatPanel(false);

		expect(screen.getByText("渲染阶段")).toBeInTheDocument();
	});

	it("shows compose stage icon when currentStage is compose", () => {
		seedRunState({ currentStage: "compose" as WorkflowStage });

		renderChatPanel(false);

		expect(screen.getByText("合成阶段")).toBeInTheDocument();
	});
});
