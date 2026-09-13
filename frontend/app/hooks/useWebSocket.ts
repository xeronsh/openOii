import { useEffect, useRef, useCallback } from "react";
import { useEditorStore, type RunMode } from "~/stores/editorStore";
import type {
	AgentMessage,
	AgentThinkingEventData,
	AudioGeneratedEventData,
	Character,
	VersionCreatedEventData,
	VersionRollbackEventData,
	CritiqueResultEventData,
	OutlineUpdatedEventData,
	ProjectUpdatedPayload,
	RunAwaitingConfirmEventData,
	RunCompletedEventData,
	RunConfirmedEventData,
	RunFailedEventData,
	RunProgressEventData,
	RunStartedEventData,
	Shot,
	ShotsReorderedEventData,
	WsEvent,
} from "~/types";
import { toast } from "~/utils/toast";
import { resolveEventStage } from "~/utils/workflowStage";
import { getWsBase } from "~/utils/runtimeBase";

const WS_BASE = getWsBase();
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const WS_CURSOR_PREFIX = "openoii.ws.cursor.";

type DurableWsEvent = WsEvent & { event_id?: number };

const TRANSIENT_MESSAGE_PATTERNS = [
	/^正在生成视频\s+\d+\/\d+/,
	/^开始生成\s+\d+\s*个分镜生成视频/,
	/^开始拼接\s+\d+\s*个分镜视频/,
];

let messageIdCounter = 0;
function generateMessageId(): string {
	return `msg_${Date.now()}_${++messageIdCounter}`;
}

const globalConnections = new Map<number, WebSocket>();

function cursorKey(projectId: number): string {
	return `${WS_CURSOR_PREFIX}${projectId}`;
}

export function readWsCursor(projectId: number): number | null {
	if (typeof window === "undefined") return null;
	const raw = window.sessionStorage.getItem(cursorKey(projectId));
	if (raw === null) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function writeWsCursor(projectId: number, eventId: number): void {
	if (typeof window === "undefined" || !Number.isSafeInteger(eventId) || eventId < 0) return;
	window.sessionStorage.setItem(cursorKey(projectId), String(eventId));
}

function shouldAutoConfirm(_agent: string | null, runMode: RunMode): boolean {
	if (runMode === "yolo") return true;
	return false;
}

export function useProjectWebSocket(projectId: number | null) {
	const reconnectAttempts = useRef(0);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const autoConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sendRef = useRef<(data: Record<string, unknown>) => void>(() => {});
	const lastEventIdRef = useRef<number | null>(
		projectId ? readWsCursor(projectId) : null,
	);

	const clearReconnectTimer = useCallback(() => {
		if (reconnectTimer.current) {
			clearTimeout(reconnectTimer.current);
			reconnectTimer.current = null;
		}
	}, []);

	const clearAutoConfirm = useCallback(() => {
		if (autoConfirmTimerRef.current) {
			clearTimeout(autoConfirmTimerRef.current);
			autoConfirmTimerRef.current = null;
		}
	}, []);

	const scheduleAutoConfirm = useCallback(
		(runId: number) => {
			clearAutoConfirm();
			autoConfirmTimerRef.current = setTimeout(() => {
				sendRef.current({ type: "confirm", data: { run_id: runId } });
			}, 1500);
		},
		[clearAutoConfirm],
	);

	const connect = useCallback(() => {
		if (!projectId) return;
		clearReconnectTimer();

		const existingWs = globalConnections.get(projectId);
		let ws = existingWs;
		if (
			!ws ||
			ws.readyState === WebSocket.CLOSED ||
			ws.readyState === WebSocket.CLOSING
		) {
			const persistedCursor = readWsCursor(projectId);
			lastEventIdRef.current = persistedCursor;
			const after = persistedCursor === null ? "" : `?after=${persistedCursor}`;
			ws = new WebSocket(`${WS_BASE}/ws/projects/${projectId}${after}`);
			globalConnections.set(projectId, ws);
		}

		ws.onopen = () => {
			const wasReconnecting = reconnectAttempts.current > 0;
			if (import.meta.env.DEV) {
				console.debug("[WS] 已连接到项目", projectId);
			}
			reconnectAttempts.current = 0;
			if (wasReconnecting) {
				toast.success({
					title: "重新连接成功",
					message: "可以继续创作了",
					duration: 2000,
				});
			}
		};

		ws.onmessage = (event) => {
			try {
				const data: DurableWsEvent = JSON.parse(event.data);
				const eventId =
				typeof data.event_id === "number" && Number.isSafeInteger(data.event_id)
					? data.event_id
					: null;
				if (
					eventId !== null &&
					lastEventIdRef.current !== null &&
					eventId <= lastEventIdRef.current
				) {
					return;
				}

				applyWsEvent(data, useEditorStore.getState(), scheduleAutoConfirm);

				if (eventId !== null) {
					lastEventIdRef.current = eventId;
					writeWsCursor(projectId, eventId);
				} else if (data.type === "connected") {
					const connectedCursor = Number(data.data.event_cursor);
					if (
						lastEventIdRef.current === null &&
						Number.isSafeInteger(connectedCursor) &&
						connectedCursor >= 0
					) {
						lastEventIdRef.current = connectedCursor;
						writeWsCursor(projectId, connectedCursor);
					}
				}
			} catch (e) {
				if (import.meta.env.DEV) {
					console.error("[WS] 解析错误:", e);
				}
				toast.error({
					title: "数据格式错误",
					message: "服务器返回了无法识别的数据，请刷新页面重试",
					duration: 3000,
				});
			}
		};

		ws.onerror = (error) => {
			if (import.meta.env.DEV) {
				console.error("[WS] 连接错误:", error);
			}
			toast.error({
				title: "无法连接到服务器",
				message: "请检查网络连接，或稍后重试",
				duration: 0,
				actions: [
					{
						label: "重新连接",
						onClick: () => {
							reconnectAttempts.current = 0;
							connect();
						},
					},
				],
			});
		};

		ws.onclose = () => {
			if (import.meta.env.DEV) {
				console.debug("[WS] 连接断开");
			}
			globalConnections.delete(projectId);

			if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
				reconnectAttempts.current++;
				if (import.meta.env.DEV) {
					console.debug(
						`[WS] ${RECONNECT_DELAY / 1000}秒后尝试重连 (${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`,
					);
				}
				toast.warning({
					title: "连接中断",
					message: `正在重新连接 (尝试 ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})`,
					duration: RECONNECT_DELAY,
				});
				reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
			} else {
				toast.error({
					title: "连接失败",
					message: "多次尝试后仍无法连接。请检查网络后刷新页面",
					duration: 0,
					actions: [
						{ label: "刷新页面", onClick: () => window.location.reload() },
					],
				});
			}
		};
	}, [projectId, clearReconnectTimer, scheduleAutoConfirm]);

	const disconnect = useCallback(() => {
		clearReconnectTimer();
		clearAutoConfirm();
		reconnectAttempts.current = MAX_RECONNECT_ATTEMPTS;
		if (projectId) {
			const ws = globalConnections.get(projectId);
			if (ws) {
				ws.close();
				globalConnections.delete(projectId);
			}
		}
	}, [projectId, clearReconnectTimer, clearAutoConfirm]);

	const send = useCallback(
		(data: Record<string, unknown>) => {
			if (!projectId) return;
			const ws = globalConnections.get(projectId);
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(data));
			}
		},
		[projectId],
	);

	sendRef.current = send;

	useEffect(() => {
		reconnectAttempts.current = 0;
		lastEventIdRef.current = projectId ? readWsCursor(projectId) : null;
		connect();
		return () => {
			clearReconnectTimer();
		};
	}, [projectId, connect, clearReconnectTimer]);

	return { send, disconnect, reconnect: connect, clearAutoConfirm };
}

function clearLoadingStates(
	store: ReturnType<typeof useEditorStore.getState>,
	agentFilter?: string,
): void {
	const currentMessages = useEditorStore.getState().messages;
	const updatedMessages = currentMessages.map((msg) => {
		if (msg.isLoading && (!agentFilter || msg.agent === agentFilter)) {
			return { ...msg, isLoading: false };
		}
		return msg;
	});
	if (updatedMessages.some((msg, idx) => msg !== currentMessages[idx])) {
		store.setMessages(updatedMessages);
	}
}

function isTransientProgressMessage(msg: AgentMessage): boolean {
	const content = msg.content.trim();
	return Boolean(msg.isLoading) || TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(content));
}

function cleanupStaleMessages(
	store: ReturnType<typeof useEditorStore.getState>,
	completedAgent?: string,
): void {
	const currentMessages = useEditorStore.getState().messages;
	const cleaned = currentMessages.filter((msg) => {
		if (completedAgent && msg.agent !== completedAgent) return true;
		if (
			msg.role === "info" &&
			(msg.content.includes("已确认") || msg.content.includes("继续执行"))
		)
			return false;
		if (!msg.content?.trim() && !msg.summary) return false;
		if (isTransientProgressMessage(msg)) return false;
		return true;
	});
	if (cleaned.length !== currentMessages.length) {
		store.setMessages(cleaned);
	}
}

function applyStage(
	store: ReturnType<typeof useEditorStore.getState>,
	data: Record<string, unknown>,
) {
	const stage = resolveEventStage(data);
	if (stage) store.setCurrentStage(stage);
}

type AutoConfirmFn = (runId: number) => void;

export function applyWsEvent(
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
			store.addMessage({
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
			store.addMessage({
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
			clearLoadingStates(store, agent);
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
			if (isTransientProgressMessage(message)) cleanupStaleMessages(store, agent);
			store.addMessage(message);
			break;
		}

		case "agent_thinking": {
			const td = event.data as unknown as AgentThinkingEventData;
			store.addMessage({
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
			clearLoadingStates(store);
			const gate = event.data as unknown as RunAwaitingConfirmEventData;
			if (!store.isGenerating) {
				store.setGenerating(true);
				store.setCurrentRunId(gate.run_id);
			}
			store.setAwaitingConfirm(true, gate.agent, gate.run_id);
			store.setRecoveryGate(gate);
			store.setRecoverySummary(gate.recovery_summary);
			if (gate.agent === "outline") {
				store.patchProject({
					id: 0,
					story_outline: gate.story_outline ?? null,
					visual_bible: gate.visual_bible ?? null,
				});
			}
			applyStage(store, event.data);
			store.addMessage({
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
			store.addMessage({
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: confirmed.auto_mode ? "自动确认，继续执行..." : "已确认，继续执行...",
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "run_completed": {
			clearLoadingStates(store);
			const d = event.data as unknown as RunCompletedEventData;
			cleanupStaleMessages(store);
			store.resetRunState();
			store.setProgress(1);
			const stage = resolveEventStage(event.data);
			if (stage) store.setCurrentStage(stage);
			else if (d.video_generation_pending) store.setCurrentStage("render");
			else store.setCurrentStage("compose");
			if (typeof d.message === "string" && d.message.trim()) {
				store.addMessage({
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
			clearLoadingStates(store);
			cleanupStaleMessages(store);
			const d = event.data as unknown as RunFailedEventData;
			store.resetRunState();
			store.addMessage({
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
			clearLoadingStates(store);
			store.resetRunState();
			store.setProgress(0);
			store.addMessage({
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: "生成已停止",
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "character_created":
		case "character_updated":
			if (event.data.character) store.updateCharacter(event.data.character as Character);
			break;

		case "shot_created":
		case "shot_updated":
			if (event.data.shot) store.updateShot(event.data.shot as Shot);
			break;

		case "shots_reordered": {
			const data = event.data as unknown as ShotsReorderedEventData;
			if (Array.isArray(data.shots)) {
				store.setShots([...data.shots].sort((a, b) => a.order - b.order || a.id - b.id));
			}
			break;
		}

		case "character_deleted": {
			const charId = event.data.character_id as number | undefined;
			if (charId !== undefined) store.setCharacters(store.characters.filter((c) => c.id !== charId));
			break;
		}

		case "shot_deleted": {
			const shotId = event.data.shot_id as number | undefined;
			if (shotId !== undefined) store.setShots(store.shots.filter((s) => s.id !== shotId));
			break;
		}

		case "data_cleared": {
			const clearedTypes = event.data.cleared_types as string[] | undefined;
			if (clearedTypes) {
				if (clearedTypes.includes("characters")) store.setCharacters([]);
				if (clearedTypes.includes("shots")) store.setShots([]);
			}
			store.patchProject({ id: 0, video_url: null });
			break;
		}

		case "outline_updated": {
			const od = event.data as unknown as OutlineUpdatedEventData;
			store.patchProject({
				id: 0,
				story_outline: od.story_outline ?? null,
				visual_bible: od.visual_bible ?? null,
				outline_approved: od.outline_approved,
			});
			store.setProjectUpdatedAt(Date.now());
			break;
		}

		case "project_updated": {
			const pd = event.data.project as ProjectUpdatedPayload | undefined;
			if (pd) store.patchProject(pd);
			store.setProjectUpdatedAt(Date.now());
			break;
		}

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
			store.addMessage({
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
			store.addMessage({
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
			store.addMessage({
				id: generateMessageId(),
				agent: "system",
				role: "info",
				content: `${rollbackData.entity_type === "character" ? "角色" : "分镜"} ${rollbackData.entity_id} 已从 v${rollbackData.from_version} 回滚到 v${rollbackData.to_version}`,
				timestamp: new Date().toISOString(),
			});
			break;
		}

		case "audio_generated": {
			const audioData = event.data as unknown as AudioGeneratedEventData;
			if (audioData.shot_id) {
				const shot = store.shots.find((s) => s.id === audioData.shot_id);
				if (shot) {
					store.updateShot({
						...shot,
						tts_url: audioData.tts_url ?? shot.tts_url,
						bgm_type: audioData.bgm_type ?? shot.bgm_type,
					});
				}
			}
			break;
		}

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
			store.addMessage({
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
			store.addMessage({
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
