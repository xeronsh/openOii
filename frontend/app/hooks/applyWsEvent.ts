import { isStageId, stepForStage } from "~/utils/workflowSteps";
import { appendMessage, readMessageFeed, updateMessageFeed } from "~/query/messageFeed";
import { patchRunState, readRunState, receiptFromGate, resetRunState } from "~/query/runState";
import type { RunMode } from "~/stores/editorStore";
import type {
	AgentMessage,
	AgentThinkingEventData,
	ChatItem,
	FeedbackReceipt,
	RunFeedbackEventData,
	LlmStreamEventData,
	VersionCreatedEventData,
	VersionRollbackEventData,
	CritiqueResultEventData,
	Project,
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
import { rememberFailedStream } from "~/features/comic-workflow/agent/liveStream";
import { clearGateTitleBadge, notifyRunEvent } from "~/utils/runNotifications";
import { appQueryClient } from "~/query/client";
import { applyChatMessage, applyChatStatus } from "~/query/assistantChat";
import { projectQueryKeys } from "~/query/queryKeys";

function cachedProjectTitle(projectId: number): string | null {
	return appQueryClient.getQueryData<Project>(projectQueryKeys.project(projectId))?.title ?? null;
}

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

/**
 * 换掉当前回执。被换下的那张（批准、换闸门、下一轮意见）留进活动时间线，
 * 让每轮「要求修改 → 结果」都有记录。
 */
export function setFeedbackReceipt(projectId: number, next: FeedbackReceipt | null): void {
	const previous = readRunState(projectId).feedbackReceipt;
	if (previous && previous.id !== next?.id) {
		const id = `receipt_${previous.id}`;
		let found = false;
		updateMessageFeed(projectId, (messages) =>
			messages.map((msg) => {
				if (msg.id !== id) return msg;
				found = true;
				return { ...msg, receipt: previous };
			}),
		);
		if (!found) {
			appendMessage(projectId, {
				id,
				agent: "system",
				role: "feedback",
				content: previous.content,
				receipt: previous,
				timestamp: new Date().toISOString(),
			});
		}
	}
	if (next) {
		// 回执一出现就落进时间线（排在这一轮重做的输出之前）；之后的状态就地更新
		const id = `receipt_${next.id}`;
		const archived = readMessageFeed(projectId).some((msg) => msg.id === id);
		if (archived) {
			updateMessageFeed(projectId, (messages) =>
				messages.map((msg) => (msg.id === id ? { ...msg, receipt: next } : msg)),
			);
		} else {
			appendMessage(projectId, {
				id,
				agent: "system",
				role: "feedback",
				content: next.content,
				receipt: next,
				timestamp: new Date().toISOString(),
			});
		}
	}
	patchRunState(projectId, { feedbackReceipt: next });
}

function receiptFromEvent(data: RunFeedbackEventData, previous: FeedbackReceipt | null): FeedbackReceipt {
	const id = data.feedback_id || data.id || previous?.id || `round-${data.round}`;
	const same = previous?.id === id ? previous : null;
	return {
		id,
		round: data.round || same?.round || 1,
		state: data.state,
		content: data.content ?? same?.content ?? "",
		reason: data.reason ?? null,
		gate: data.stage ?? data.gate ?? same?.gate ?? null,
		entityType: data.entity_type ?? same?.entityType ?? null,
		entityIds: data.entity_ids ?? same?.entityIds ?? null,
	};
}

function applyStage(projectId: number, data: Record<string, unknown>): void {
	const stage = resolveEventStage(data);
	if (stage) patchRunState(projectId, { currentStage: stage });
	const raw = data.stage ?? data.current_stage;
	if (isStageId(raw)) patchRunState(projectId, { currentStep: raw });
}

type AutoConfirmFn = (runId: number) => void;

/**
 * UI projection for websocket events.
 *
 * Single websocket reducer.
 *
 * Durable entities, the chat feed and the live run UI all live in the query
 * cache now, so one event is projected exactly once (messageFeed / runState /
 * applyServerEvent) instead of being written to a store and then mirrored.
 */
export function applyWsEvent(
	projectId: number,
	event: WsEvent,
	runMode: RunMode,
	autoConfirm: AutoConfirmFn,
): void {
	// `runMode` is a genuine client preference (manual/yolo) owned by the editor
	// store; everything else in this reducer writes to the query cache.
	switch (event.type) {
		case "connected":
			break;

		// Project assistant (ADR 0011): its own cache entry, separate from the workflow feed.
		case "chat_message":
			applyChatMessage(projectId, (event.data as { message: ChatItem }).message);
			break;
		case "chat_status":
			applyChatStatus(projectId, event.data as Parameters<typeof applyChatStatus>[1]);
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
			setFeedbackReceipt(projectId, null);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "separator",
				content: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
				timestamp: new Date().toISOString(),
			});
			patchRunState(projectId, {
				isGenerating: true,
				progress: 0,
				currentRunId: d.run_id,
				currentAgent: d.current_agent ?? null,
				awaitingConfirm: false,
				awaitingAgent: null,
				recoveryGate: null,
				liveStream: null,
			});
			rememberFailedStream(projectId, null);
			applyStage(projectId, event.data);
			if (d.recovery_summary) patchRunState(projectId, { recoverySummary: d.recovery_summary });
			if (Object.hasOwn(d, "provider_snapshot")) {
				patchRunState(projectId, { currentRunProviderSnapshot: d.provider_snapshot ?? null });
			}
			break;
		}

		case "run_progress": {
			const p = event.data as unknown as RunProgressEventData;
			if (!readRunState(projectId).isGenerating && p.run_id) {
				patchRunState(projectId, { isGenerating: true, currentRunId: p.run_id });
			}
			patchRunState(projectId, { currentAgent: p.current_agent ?? null });
			patchRunState(projectId, { progress: p.progress });
			if (p.recovery_summary) patchRunState(projectId, { recoverySummary: p.recovery_summary });
			applyStage(projectId, event.data);
			break;
		}

		case "run_message": {
			const agent = event.data.agent as string;
			clearLoadingStates(projectId, agent);
			// Message progress is the agent's own (0 at start, 1 when done), not the
			// run's; run_progress and llm_stream move the run progress.
			const msgProgress = event.data.progress as number | undefined;
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

		case "llm_stream": {
			const frame = event.data as unknown as LlmStreamEventData;
			if (frame.status === "done") {
				// A finished call leaves no row; its result arrives as normal messages.
				if (readRunState(projectId).liveStream?.streamId === frame.stream_id) {
					patchRunState(projectId, { liveStream: null });
				}
				break;
			}
			// Frames queued before a stop can land after it; a stopped run has no live row.
			const run = readRunState(projectId);
			if (!run.isGenerating) break;
			// Output so far nudges the run progress forward, never back.
			// One patch per frame: progress and the live row change together (one cache write, one render).
			const nudge =
				typeof frame.progress === "number" && frame.progress > run.progress && frame.progress <= 1
					? { progress: frame.progress }
					: {};
			patchRunState(projectId, {
				...nudge,
				liveStream: {
					streamId: frame.stream_id,
					agent: frame.agent,
					status: frame.status,
					thinking: frame.thinking ?? "",
					text: frame.text ?? "",
					chars: frame.chars ?? 0,
					error: frame.error ?? undefined,
				},
			});
			break;
		}

		case "run_awaiting_confirm": {
			clearLoadingStates(projectId);
			const gate = event.data as unknown as RunAwaitingConfirmEventData;
			// A gate means no call is in flight (its done frame may have been compacted away).
			patchRunState(projectId, { isGenerating: true, awaitingConfirm: true, awaitingAgent: gate.agent, currentRunId: gate.run_id, liveStream: null, recoveryGate: gate });
			patchRunState(projectId, { recoverySummary: gate.recovery_summary });
			// 同一闸门重做后回来时带着上一轮结果；首次到达没有回执
			setFeedbackReceipt(projectId, receiptFromGate(gate));
			applyStage(projectId, event.data);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: event.data.message as string,
				timestamp: new Date().toISOString(),
			});
			if (!gate.auto_mode && shouldAutoConfirm(gate.agent, runMode)) {
				autoConfirm(gate.run_id);
			} else if (!gate.auto_mode) {
				// 自动确认的闸门不打扰人：马上就继续了
				const step = stepForStage(gate.current_stage ?? gate.stage);
				notifyRunEvent({
					projectId,
					kind: "gate",
					body: step ? `${step.label} · 待确认` : "有一步等你确认",
					projectTitle: cachedProjectTitle(projectId),
				});
			}
			break;
		}

		case "run_feedback": {
			const data = event.data as unknown as RunFeedbackEventData;
			const state = readRunState(projectId);
			if (state.currentRunId !== null && data.run_id !== state.currentRunId) break;
			const receipt = receiptFromEvent(data, state.feedbackReceipt);
			setFeedbackReceipt(projectId, receipt);
			if (data.state === "regenerating") {
				// 重做期间不在闸门上：确认按钮收起，显示进行中
				patchRunState(projectId, {
					awaitingConfirm: false,
					awaitingAgent: null,
					recoveryGate: null,
					isGenerating: true,
				});
			}
			break;
		}

		case "run_confirmed": {
			const confirmed = event.data as unknown as RunConfirmedEventData;
			setFeedbackReceipt(projectId, null);
			// 闸门已经过了（别处确认或自动确认）：后台标题不该还挂着【待确认】
			clearGateTitleBadge();
			patchRunState(projectId, { awaitingConfirm: false, awaitingAgent: null, recoveryGate: null });
			if (confirmed.recovery_summary) patchRunState(projectId, { recoverySummary: confirmed.recovery_summary });
			applyStage(projectId, event.data);
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: confirmed.auto_mode ? "自动确认，继续执行…" : "已确认，继续执行…",
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "run_completed": {
			clearLoadingStates(projectId);
			const d = event.data as unknown as RunCompletedEventData;
			setFeedbackReceipt(projectId, null);
			cleanupStaleMessages(projectId);
			resetRunState(projectId);
			patchRunState(projectId, { progress: 1 });
			const stage = resolveEventStage(event.data);
			if (stage) patchRunState(projectId, { currentStage: stage });
			else if (d.video_generation_pending) patchRunState(projectId, { currentStage: "render" });
			else patchRunState(projectId, { currentStage: "compose" });
			if (typeof d.message === "string" && d.message.trim()) {
				appendMessage(projectId, {
					id: generateMessageId(),
					agent: "system",
					role: "assistant",
					content: d.message,
					timestamp: new Date().toISOString(),
				});
			}
			notifyRunEvent({
				projectId,
				kind: "completed",
				body: "生成完成，成片可以查看了",
				projectTitle: cachedProjectTitle(projectId),
			});
			break;
		}

		case "run_failed": {
			clearLoadingStates(projectId);
			cleanupStaleMessages(projectId);
			const d = event.data as unknown as RunFailedEventData;
			setFeedbackReceipt(projectId, null);
			// Keep the interrupted output on screen next to the failure.
			const interrupted = readRunState(projectId).liveStream;
			resetRunState(projectId);
			rememberFailedStream(projectId, interrupted);
			if (interrupted?.status === "error") patchRunState(projectId, { liveStream: interrupted });
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "system",
				role: "error",
				content: `生成失败: ${d.error}`,
				details: d.error_code
					? `${d.error_code}${d.retryable ? " · 可重试" : ""}`
					: undefined,
				timestamp: new Date().toISOString(),
			});
			toast.error({
				title: "生成失败",
				message: d.error || "未知错误",
				details: d.error_code ?? undefined,
				duration: 5000,
			});
			notifyRunEvent({
				projectId,
				kind: "failed",
				body: "生成失败，打开看看怎么继续",
				projectTitle: cachedProjectTitle(projectId),
			});
			break;
		}

		case "run_cancelled": {
			const data = event.data as { run_id?: number; run_ids?: number[]; project_id?: number };
			if (data.project_id !== undefined && data.project_id !== projectId) break;
			const state = readRunState(projectId);
			const activeRunId = state.recoveryControl?.active_run.id ?? state.currentRunId;
			if (
				activeRunId === null ||
				(data.run_id !== activeRunId && !data.run_ids?.includes(activeRunId))
			) break;
			clearLoadingStates(projectId);
			setFeedbackReceipt(projectId, null);
			resetRunState(projectId);
			patchRunState(projectId, { progress: 0 });
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
				role: "result",
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

		case "project_restored": {
			// 与服务端落库的那条同文（刷新后由 messages 接口还原）
			const reason = event.data.reason as string | undefined;
			appendMessage(projectId, {
				id: generateMessageId(),
				agent: "version",
				role: "assistant",
				content:
					reason === "restored"
						? "已恢复到上一版"
						: "已停止，项目放回了重新生成之前的版本（成片、角色、分镜都还在）",
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

		// The consistency report UI was removed; the backend may still emit this.
		case "consistency_eval_completed":
		case "pong":
		case "echo":
			break;
	}
}
