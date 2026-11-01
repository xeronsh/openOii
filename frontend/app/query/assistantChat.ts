import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import { chatApi } from "~/services/api";
import { ApiError } from "~/types/errors";
import type { ChatConfirmCard, ChatItem, ChatState } from "~/types";
import { toast } from "~/utils/toast";

const patch = (projectId: number, update: (state: ChatState) => ChatState) =>
	appQueryClient.setQueryData<ChatState>(projectQueryKeys.chat(projectId), (old) => (old ? update(old) : old));

/** chat_message: one saved message (deduped by id, so a refetch race is harmless). */
export function applyChatMessage(projectId: number, message: ChatItem): void {
	patch(projectId, (state) =>
		state.messages.some((item) => item.id === message.id) ? state : { ...state, messages: [...state.messages, message] },
	);
}

/** chat_status: busy flag, streaming text and the open confirmation card. */
export function applyChatStatus(
	projectId: number,
	status: { busy: boolean; text?: string; pending?: ChatConfirmCard | null },
): void {
	patch(projectId, (state) => ({ ...state, busy: status.busy, text: status.text ?? "", pending: status.pending ?? null }));
	// A finished reply resyncs once, in case a message event was missed.
	if (!status.busy) void appQueryClient.invalidateQueries({ queryKey: projectQueryKeys.chat(projectId) });
}

/** Send a message to the assistant; false keeps the draft in the input. */
export async function sendChat(projectId: number, content: string): Promise<boolean> {
	try {
		await chatApi.send(projectId, content);
		patch(projectId, (state) => ({ ...state, busy: true }));
		return true;
	} catch (error) {
		if (error instanceof ApiError && error.status === 409) {
			toast.info({ title: "请稍候", message: "助手还在回答上一条消息" });
		} else {
			toast.error({ title: "发送失败", message: error instanceof Error ? error.message : "请重试" });
		}
		return false;
	}
}
