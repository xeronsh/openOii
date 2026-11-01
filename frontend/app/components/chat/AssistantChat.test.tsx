import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "~/types";

const chatApi = vi.hoisted(() => ({ get: vi.fn(), confirm: vi.fn(), abort: vi.fn() }));
vi.mock("~/services/api", () => ({ chatApi }));
vi.mock("~/utils/toast", () => ({ toast: { error: vi.fn() } }));

import { toast } from "~/utils/toast";
import { AssistantChat } from "./AssistantChat";

const state = (extra: Partial<ChatState> = {}): ChatState => ({ messages: [], busy: false, text: "", pending: null, ...extra });

function show(data: ChatState, hideEmpty = false) {
	chatApi.get.mockResolvedValue(data);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<AssistantChat projectId={1} hideEmpty={hideEmpty} />
		</QueryClientProvider>,
	);
}

describe("AssistantChat", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatApi.abort.mockResolvedValue({ ok: true });
	});

	it("shows a hint for an empty conversation, or nothing on mobile", async () => {
		show(state());
		expect(await screen.findByText(/改动前会先请你确认/)).toBeInTheDocument();
		const { container } = show(state(), true);
		await waitFor(() => expect(chatApi.get).toHaveBeenCalledTimes(2));
		expect(container).toBeEmptyDOMElement();
	});

	it("renders user, assistant and tool rows plus the streaming reply", async () => {
		show(
			state({
				busy: true,
				text: "正在查看",
				messages: [
					{ id: 1, role: "user", text: "重画第2镜" },
					{ id: 2, role: "tool", text: "", tool: "查看项目", ok: true },
					{ id: 3, role: "tool", text: "没有这一镜", tool: "重画分镜", ok: false },
					{ id: 4, role: "assistant", text: "已停止", error: "模型调用失败" },
				],
			}),
		);
		expect(await screen.findByText("重画第2镜")).toBeInTheDocument();
		expect(screen.getByText("查看项目")).toBeInTheDocument();
		expect(screen.getByText("· 没有这一镜")).toBeInTheDocument();
		expect(screen.getByText("模型调用失败")).toBeInTheDocument();
		expect(screen.getByText("正在查看")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "停止回答" }));
		expect(chatApi.abort).toHaveBeenCalledWith(1);
	});

	it("shows a thinking pulse while busy without text", async () => {
		chatApi.abort.mockRejectedValue(new Error("gone"));
		show(state({ busy: true }));
		expect(await screen.findByRole("status")).toHaveTextContent("助手在想…");
		await userEvent.click(screen.getByRole("button", { name: "停止回答" }));
	});

	it("answers the confirmation card and reports a stale one", async () => {
		show(state({ busy: true, pending: { tool_call_id: "t1", tool: "重画分镜", summary: "重画第 2 镜的画面" } }));
		const card = await screen.findByTestId("chat-confirm");
		expect(card).toHaveTextContent("重画分镜 · 需要你确认");
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		chatApi.confirm.mockResolvedValueOnce({ ok: true });
		await userEvent.click(screen.getByRole("button", { name: "确认" }));
		expect(chatApi.confirm).toHaveBeenCalledWith(1, "t1", true);
		chatApi.confirm.mockRejectedValueOnce(new Error("404"));
		await userEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(chatApi.confirm).toHaveBeenLastCalledWith(1, "t1", false);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ title: "操作没有提交" })));
	});
});
