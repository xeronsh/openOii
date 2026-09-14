import { appendMessage, updateMessageFeed } from "~/query/messageFeed";
import { useEditorStore, type RunMode } from "~/stores/editorStore";
import type {
	AgentMessage,
	AgentThinkingEventData,
	VersionCreatedEventData,
	VersionRollbackEventData,
	CritiqueResultEventData,
	RunAwaitingConfirmEventData,
	RunCompletedEventData,
	RunConfirmedEventData,
	RunFailedEventData,
	RunProgressEventData,
	RunStartedEventData,
	WsEvent,
} from "~/types";
import { toast } from "~/utils/toast";
import { resolveEventStage } from "~/utils/workflowStage";

const TRANSIENT_MESSAGE_PATTERNS = [
	/^正在生成视频\s+\d+\/\d+/,
	/^开始生成\s+\d+\s*个分镜生成视频/,
	/^开始拼接\s+\d+\s*个分镜视频/,
];

let messageIdCounter = 0;
function generateMessageId(): string {
	return `msg_${Date.now()}_${++messageIdCounter}`;
}

function shouldAutoConfirm(_agent: string | null, runMode: RunMode): boolean {
	return runMode === "yolo";
}

function clearLoadingStates(projectId: number, agentFilter?: string): void {
	updateMessageFeed(projectId, (messages) =>
		messages.map((msg) =>
			msg.isLoading && (!agentFilter || msg.agent === agentFilter)
				? { ...msg, isLoading: false }
				: msg,
		),
	);
}

function isTransientProgressMessage(msg: AgentMessage): boolean {
	const content = msg.content.trim();
	return Boolean(msg.isLoading) || TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(content));
}

function cleanupStaleMessages(projectId: number, completedAgent?: string): void {
	updateMessageFeed(projectId, (messages) =>
		messages.filter((msg) => {
			if (completedAgent && msg.agent !== completedAgent) return true;
			if (
				msg.role === "info" &&
				(msg.content.includes("已确认") || msg.content.includes("继续执行"))
			)
				return false;
			if (!msg.content?.trim() && !msg.summary) return false;
			if (isTransientProgressMessage(msg)) return false;
			return true;
		}),
	);
}

function applyStage(
	store: ReturnType<typeof useEditorStore.getState>,
	data: Record<string, unknown>,
) {
	const stage = resolveEventStage(data);
	if (stage) store.setCurrentStage(stage);
}

type AutoConfirmFn = (runId: number) => void;

/**
 * UI projection for websocket events.
 *
 * Durable server entities are projected into TanStack Query by
 * `applyServerEvent`. This function owns only what the server does not own:
 * interaction state and the live run UI. The chat feed also lives in the query
 * cache now, so it is written through `~/query/messageFeed`.
 */
export function applyWsEvent(
	projectId: number,
	event: WsEvent,
	store: ReturnType<typeof useEditorStore.getState>,
	autoConfirm: AutoConfirmFn,
): void {
	switch (event.type) {
		case "connected":
			break;

		case "error": {
			const code = event.data.code as string | undefined;
			const msg = event.data.message as string | undefined;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "error",
				content: msg || code || "Unknown error",
				timestamp: new Date().toISOString(),
			});
			toast.error({ title: "服务器错误", message: msg || code || "" });
			break;
		}

		case "run_started": {
			const d = event.data as unknown as RunStartedEventData;
			store.setGenerating(true);
			store.setProgress(0);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "separator",
				content: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
				timestamp: new Date().toISOString(),
			});
			store.setCurrentRunId(d.run_id);
			store.setCurrentAgent(d.current_agent ?? null);
			store.setAwaitingConfirm(false);
			store.setRecoveryGate(null);
			applyStage(store, event.data);
			if (d.recovery_summary) store.setRecoverySummary(d.recovery_summary);
			if (Object.hasOwn(d, "provider_snapshot")) {
				store.setCurrentRunProviderSnapshot(d.provider_snapshot ?? null);
			}
			break;
		}

		case "run_progress": {
			const p = event.data as unknown as RunProgressEventData;
			if (!store.isGenerating && p.run_id) {
				store.setGenerating(true);
				store.setCurrentRunId(p.run_id);
			}
			store.setCurrentAgent(p.current_agent ?? null);
			store.setProgress(p.progress);
			if (p.recovery_summary) store.setRecoverySummary(p.recovery_summary);
			applyStage(store, event.data);
			break;
		}

		case "run_message": {
			const agent = event.data.agent as string;
			clearLoadingStates(projectId, agent);
			const msgProgress = event.data.progress as number | undefined;
			if (typeof msgProgress === "number" && msgProgress >= 0 && msgProgress <= 1) {
				store.setProgress(msgProgress);
			}
			const message: AgentMessage = {
				id: generateMessageId(),
				agent,
				role: event.data.role as string,
				content: event.data.content as string,
				summary: (event.data.summary as string | undefined) ?? undefined,
				timestamp: new Date().toISOString(),
				progress: msgProgress,
				isLoading: event.data.isLoading as boolean | undefined,
				phase: event.data.phase as AgentMessage["phase"],
				details: event.data.details as string | null | undefined,
			};
			if (isTransientProgressMessage(message)) cleanupStaleMessages(projectId, agent);
			appendMessage(projectId, message);
			break;
		}

		case "agent_thinking": {
			const td = event.data as unknown as AgentThinkingEventData;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: td.agent,
				role: "thinking",
				content: td.content,
				timestamp: new Date().toISOString(),
				phase: td.phase,
				details: td.details ?? undefined,
			});
			break;
		}

		case "run_awaiting_confirm": {
			clearLoadingStates(projectId);
			const gate = event.data as unknown as RunAwaitingConfirmEventData;
			if (!store.isGenerating) {
				store.setGenerating(true);
				store.setCurrentRunId(gate.run_id);
			}
			store.setAwaitingConfirm(true, gate.agent, gate.run_id);
			store.setRecoveryGate(gate);
			store.setRecoverySummary(gate.recovery_summary);
			applyStage(store, event.data);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: event.data.message as string,
				timestamp: new Date().toISOString(),
			});
			if (!gate.auto_mode && shouldAutoConfirm(gate.agent, store.runMode)) {
				autoConfirm(gate.run_id);
			}
			break;
		}

		case "run_confirmed": {
			const confirmed = event.data as unknown as RunConfirmedEventData;
			store.setAwaitingConfirm(false);
			store.setRecoveryGate(null);
			if (confirmed.recovery_summary) store.setRecoverySummary(confirmed.recovery_summary);
			applyStage(store, event.data);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: confirmed.auto_mode ? "自动确认，继续执行..." : "已确认，继续执行...",
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "run_completed": {
			clearLoadingStates(projectId);
			const d = event.data as unknown as RunCompletedEventData;
			cleanupStaleMessages(projectId);
			store.resetRunState();
			store.setProgress(1);
			const stage = resolveEventStage(event.data);
			if (stage) store.setCurrentStage(stage);
			else if (d.video_generation_pending) store.setCurrentStage("render");
			else store.setCurrentStage("compose");
			if (typeof d.message === "string" && d.message.trim()) {
				appendMessage(projectId, {
					id: generateMessageId(),
					agent: "system",
					role: "assistant",
					content: d.message,
					timestamp: new Date().toISOString(),
				});
			}
			break;
		}

		case "run_failed": {
			clearLoadingStates(projectId);
			cleanupStaleMessages(projectId);
			const d = event.data as unknown as RunFailedEventData;
			store.resetRunState();
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "error",
				content: `生成失败: ${d.error}`,
				timestamp: new Date().toISOString(),
			});
			toast.error({ title: "生成失败", message: d.error || "未知错误", duration: 5000 });
			break;
		}

		case "run_cancelled": {
			clearLoadingStates(projectId);
			store.resetRunState();
			store.setProgress(0);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: "生成已停止",
				timestamp: new Date().toISOString(),
			});
			break;
		}

		// character_* / shot_* / shots_reordered / data_cleared /
		// outline_updated / project_updated carry durable server entities only;
		// they are projected into the query cache by applyServerEvent.

		case "critique_result": {
			const critData = event.data as unknown as CritiqueResultEventData;
			const scoreStr = critData.score.toFixed(1);
			const dimStr = Object.entries(critData.dimensions)
				.map(([k, v]) => `${k}: ${v}`)
				.join(" | ");
			const issuesStr = critData.issues.length ? critData.issues.join("；") : "无";
			const sugStr = critData.suggestions.length ? critData.suggestions.join("；") : "无";
			const entityLabel = critData.entity_type === "character" ? "角色" : "分镜";
			const statusText = critData.will_regenerate ? "分数低于阈值，将重新生成" : "质量达标";
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "critic",
				role: "assistant",
				content: `${entityLabel}审查结果：总分 ${scoreStr}/10\n${dimStr}\n问题: ${issuesStr}\n建议: ${sugStr}\n${statusText}`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "version_created": {
			const versionData = event.data as unknown as VersionCreatedEventData;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: `${versionData.entity_type === "character" ? "角色" : "分镜"} ${versionData.entity_id} 已保存版本 v${versionData.version}`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "version_rollback": {
			const rollbackData = event.data as unknown as VersionRollbackEventData;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: `${rollbackData.entity_type === "character" ? "角色" : "分镜"} ${rollbackData.entity_id} 已从 v${rollbackData.from_version} 回滚到 v${rollbackData.to_version}`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		// audio_generated mutates shot.tts_url / shot.bgm_type in the query cache.

		case "export_completed": {
			const exportData = event.data as unknown as import("~/types").ExportCompletedEventData;
			const formatLabel = exportData.format === "webtoon" ? "Webtoon 长图" : "导出文件";
			if (exportData.status === "failed") {
				toast.error({
					title: "导出失败",
					message: `${formatLabel}生成失败${exportData.error ? `: ${exportData.error}` : ""}`,
					duration: 5000,
				});
			}
			break;
		}

		case "bible_updated": {
			const bibleData = event.data as unknown as import("~/types").BibleUpdatedEventData;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "critic",
				role: "info",
				content: `角色圣经已更新${bibleData.has_embedding ? "（含人脸特征）" : ""}`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "consistency_eval_completed": {
			const evalData = event.data as unknown as import("~/types").ConsistencyEvalCompletedEventData;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "critic",
				role: "info",
				content: `一致性评估完成：综合评分 ${evalData.overall_score.toFixed(1)}/100，${evalData.character_count} 个角色已评估`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "pong":
		case "echo":
			break;
	}
}
