import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import type { AgentMessage } from "~/types";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "~/stores/editorStore";
import { patchRunState, readRunState, resetRunState } from "~/query/runState";
import type { WorkflowStage } from "~/types";
import { ChatPanel } from "./ChatPanel";
import { PromptBar } from "~/features/workbench/PromptBar";

function setChatFeed(messages: AgentMessage[]): void {
	appQueryClient.setQueryData(projectQueryKeys.messageFeed(1), messages);
}

const onSendFeedback = vi.fn();
const onConfirm = vi.fn();
const onCancel = vi.fn();

function seedRunState(patch: Parameters<typeof patchRunState>[1]): void {
	patchRunState(1, patch);
}

vi.mock("~/features/comic-workflow/agent/ActivityTimeline", () => ({
	ActivityTimeline: ({ entries }: { entries: { id: string; title: string; status: string }[] }) => (
		<ol data-testid="activity-timeline">
			{entries.map((e) => (
				<li key={e.id} data-status={e.status}>{e.title}</li>
			))}
		</ol>
	),
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
	const runState = readRunState(1);
	return render(
		<>
			<ChatPanel
				projectId={1}
				onCancel={onCancel}
				isGenerating={isGenerating}
			/>
			<PromptBar
				selection={[]}
				gateLabel="规划"
				awaitingConfirm={runState.awaitingConfirm}
				onSend={onSendFeedback}
				onConfirm={onConfirm}
			/>
		</>,
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

	it("shows a creating-run placeholder right after 开始生成", () => {
		resetRunState(1);
		setChatFeed([]);
		seedRunState({ startingRun: true });
		renderChatPanel(false);
		expect(screen.getByTestId("run-starting")).toHaveTextContent("正在创建运行");
		expect(screen.queryByText("暂无活动记录")).toBeNull();
		resetRunState(1);
	});

	it("keeps global generation out of the empty chat state", () => {
		renderChatPanel(false);

		expect(screen.getByText("暂无活动记录")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "开始生成漫剧" }),
		).not.toBeInTheDocument();
	});

	it("feeds the message feed into the activity timeline and marks the live step", async () => {
		setChatFeed([
			{ id: "s1", agent: "plan", role: "step", content: "生成故事大纲" },
			{ id: "t1", agent: "plan", role: "tool_call", content: "文本生成" },
		]);

		renderChatPanel(true);

		const step = await screen.findByText("生成故事大纲");
		expect(step).toHaveAttribute("data-status", "running");
	});

	it("shows processing state and stop button while generating", () => {
		seedRunState({ currentAgent: "plan" });

		renderChatPanel(true);

		expect(screen.getByText(/规划…|处理中…/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
	});

	it("sends prompt-bar feedback to confirm while awaiting, without its own approval bar", async () => {
		const user = userEvent.setup();
		seedRunState({ awaitingConfirm: true, awaitingAgent: "plan" });

		renderChatPanel(true);

		// 审批按钮只在收件箱；输入框仍可提交修改意见
		expect(screen.queryByRole("button", { name: /通过/ })).not.toBeInTheDocument();
		await user.type(screen.getByRole("textbox"), "  修改剧情节奏  ");
		await user.keyboard("{Enter}");

		expect(onConfirm).toHaveBeenLastCalledWith("修改剧情节奏");
	});

	it("toggles between review and quick mode", async () => {
		const user = userEvent.setup();
		useEditorStore.getState().setRunMode("manual");

		renderChatPanel(false);

		await user.click(screen.getByRole("button", { name: "切换自动确认" }));

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

		await user.click(screen.getByRole("button", { name: "切换自动确认" }));

		expect(useEditorStore.getState().runMode).toBe("yolo");
		expect(onConfirm).toHaveBeenLastCalledWith(undefined);
	});

	it("hides manual confirm bar in auto-confirm mode", () => {
		seedRunState({ awaitingConfirm: true, awaitingAgent: "plan" });
		useEditorStore.getState().setRunMode("yolo");

		renderChatPanel(true);

		expect(screen.queryByText(/已完成/)).not.toBeInTheDocument();
	});

	it("sends the message to the assistant outside a gate", async () => {
		const user = userEvent.setup();

		renderChatPanel(false);

		await user.type(screen.getByRole("textbox"), "  这里有建议  ");
		await user.click(screen.getByRole("button", { name: "发送" }));

		expect(onSendFeedback).toHaveBeenLastCalledWith("  这里有建议  ");
	});

	it("sends mid-run messages to the assistant, never to the gate", async () => {
		const user = userEvent.setup();
		seedRunState({ currentRunId: 99, awaitingConfirm: false });

		renderChatPanel(true);

		await user.type(screen.getByRole("textbox"), "进度怎么样");
		await user.click(screen.getByRole("button", { name: "发送" }));

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onSendFeedback).toHaveBeenLastCalledWith("进度怎么样");
	});

	it("names the step it is on while a run is active", () => {
		seedRunState({ currentStep: "render_shots" });
		renderChatPanel(true);
		expect(screen.getByText("分镜画面 · 5/6")).toBeInTheDocument();
		expect(screen.getByText("分镜画面…")).toBeInTheDocument();
	});

	it("names the gate while waiting for approval", () => {
		seedRunState({ currentStep: "character_images_approval", awaitingConfirm: true });
		renderChatPanel(true);
		expect(screen.getByText("角色形象 · 待确认")).toBeInTheDocument();
	});

	it("does not claim a planning stage when nothing is running", () => {
		seedRunState({ currentStage: "plan" as WorkflowStage, currentStep: "plan_outline" });
		renderChatPanel(false);
		expect(screen.getByText("活动记录")).toBeInTheDocument();
		expect(screen.queryByText("规划阶段")).not.toBeInTheDocument();
	});
});
