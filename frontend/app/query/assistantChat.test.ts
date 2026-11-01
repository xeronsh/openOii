import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("~/services/api", () => ({ chatApi: { send } }));
vi.mock("~/utils/toast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { applyWsEvent } from "~/hooks/applyWsEvent";
import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import { ApiError } from "~/types/errors";
import type { ChatState } from "~/types";
import { toast } from "~/utils/toast";
import { sendChat } from "./assistantChat";

const key = projectQueryKeys.chat(1);
const read = () => appQueryClient.getQueryData<ChatState>(key);
const event = (type: string, data: Record<string, unknown>) =>
	applyWsEvent(1, { type, data } as never, "manual", vi.fn());

describe("assistant chat cache", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		appQueryClient.clear();
	});

	it("ignores events until the conversation is loaded", () => {
		event("chat_message", { message: { id: 1, role: "user", text: "hi" } });
		expect(read()).toBeUndefined();
	});

	it("appends messages once and mirrors the status", () => {
		appQueryClient.setQueryData<ChatState>(key, { messages: [], busy: false, text: "", pending: null });
		const message = { id: 3, role: "assistant", text: "好的" };
		event("chat_message", { message });
		event("chat_message", { message });
		expect(read()?.messages).toEqual([message]);

		const pending = { tool_call_id: "t1", tool: "重画分镜", summary: "重画第 2 镜的画面" };
		event("chat_status", { busy: true, text: "正在", pending });
		expect(read()).toMatchObject({ busy: true, text: "正在", pending });
		const refetch = vi.spyOn(appQueryClient, "invalidateQueries");
		event("chat_status", { busy: false });
		expect(read()).toMatchObject({ busy: false, text: "", pending: null });
		expect(refetch).toHaveBeenCalledWith({ queryKey: key });
	});

	it("marks the assistant busy after a send and keeps the draft on failure", async () => {
		appQueryClient.setQueryData<ChatState>(key, { messages: [], busy: false, text: "", pending: null });
		send.mockResolvedValueOnce({ accepted: true });
		await expect(sendChat(1, "进度?")).resolves.toBe(true);
		expect(read()?.busy).toBe(true);

		send.mockRejectedValueOnce(new ApiError({ code: "CHAT_BUSY", message: "busy", status: 409 }));
		await expect(sendChat(1, "再问")).resolves.toBe(false);
		expect(toast.info).toHaveBeenCalledWith({ title: "请稍候", message: "助手还在回答上一条消息" });
	});
});
