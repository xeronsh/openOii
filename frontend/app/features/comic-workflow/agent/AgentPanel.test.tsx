import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentPanel } from "./AgentPanel";
import type { InboxItem } from "./inboxItems";

vi.mock("~/components/chat/ChatPanel", () => ({
	ChatPanel: () => <div data-testid="chat-panel" />,
}));
vi.mock("~/components/chat/AssistantChat", () => ({
	AssistantChat: () => <div data-testid="assistant-chat" />,
}));

const gate: InboxItem = { kind: "gate", id: "gate", title: "规划已完成，等待确认", detail: null, gate: null };
const failed: InboxItem = { kind: "failed", id: "failed", title: "最近一次生成失败", detail: "可以重试" };

const actions = {
	onConfirm: vi.fn(),
	onRequestChanges: vi.fn(),
	onResume: vi.fn(),
	onCancel: vi.fn(),
	onRetry: vi.fn(),
	onSelectShot: vi.fn(),
};

const base = {
	projectId: 1,
	onCancel: vi.fn(),
	isGenerating: false,
	tab: "activity" as const,
	onTabChange: vi.fn(),
	inboxItems: [] as InboxItem[],
	inboxActions: actions,
};

describe("AgentPanel", () => {
	it("floats over the canvas and collapses into a pill", async () => {
		const onCollapsedChange = vi.fn();
		render(<AgentPanel {...base} collapsed={false} onCollapsedChange={onCollapsedChange} />);

		expect(screen.getByRole("complementary", { name: "工作流活动" })).toBeInTheDocument();
		expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "收起活动面板" }));
		expect(onCollapsedChange).toHaveBeenCalledWith(true);
	});

	it("shows the inbox count on the pill and the tab", async () => {
		const onCollapsedChange = vi.fn();
		const { rerender } = render(
			<AgentPanel {...base} inboxItems={[gate, failed]} collapsed onCollapsedChange={onCollapsedChange} />,
		);

		const pill = screen.getByRole("button", { name: "展开活动面板" });
		expect(pill).toHaveTextContent("2");
		await userEvent.click(pill);
		expect(onCollapsedChange).toHaveBeenCalledWith(false);

		rerender(<AgentPanel {...base} inboxItems={[gate, failed]} collapsed={false} onCollapsedChange={onCollapsedChange} />);
		expect(screen.getByRole("tab", { name: /待处理/ })).toHaveTextContent("2");
	});

	it("switches tabs and renders the inbox", async () => {
		const onTabChange = vi.fn();
		const { rerender } = render(
			<AgentPanel {...base} onTabChange={onTabChange} inboxItems={[gate]} collapsed={false} onCollapsedChange={vi.fn()} />,
		);
		expect(screen.getByRole("tab", { name: "活动" })).toHaveAttribute("aria-selected", "true");
		await userEvent.click(screen.getByRole("tab", { name: /待处理/ }));
		expect(onTabChange).toHaveBeenCalledWith("inbox");

		rerender(<AgentPanel {...base} tab="inbox" inboxItems={[gate]} collapsed={false} onCollapsedChange={vi.fn()} />);
		expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
		expect(screen.getByText("规划已完成，等待确认")).toBeInTheDocument();
	});

	it("renders the assistant on the chat tab", async () => {
		const onTabChange = vi.fn();
		render(<AgentPanel {...base} tab="chat" onTabChange={onTabChange} collapsed={false} onCollapsedChange={vi.fn()} />);
		expect(screen.getByRole("tab", { name: "助手" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByTestId("assistant-chat")).toBeInTheDocument();
		expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("tab", { name: "活动" }));
		expect(onTabChange).toHaveBeenCalledWith("activity");
	});
});
