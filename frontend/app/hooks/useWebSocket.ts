import { useCallback, useEffect, useRef } from "react";
import { applyServerEvent } from "~/query/applyServerEvent";
import { appQueryClient } from "~/query/client";
import { useEditorStore } from "~/stores/editorStore";
import type { WsEvent } from "~/types";
import { getWsBase } from "~/utils/runtimeBase";
import { toast } from "~/utils/toast";
import { applyWsEvent } from "./applyWsEvent";

export { applyWsEvent } from "./applyWsEvent";

const WS_BASE = getWsBase();
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const WS_CURSOR_PREFIX = "openoii.ws.cursor.";

type DurableWsEvent = WsEvent & { event_id?: number };

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
	if (
		typeof window === "undefined" ||
		!Number.isSafeInteger(eventId) ||
		eventId < 0
	)
		return;
	window.sessionStorage.setItem(cursorKey(projectId), String(eventId));
}

/**
 * Project websocket transport.
 *
 * Durable server state is projected into the same application TanStack Query
 * cache used by HTTP hydration. Zustand receives a separate UI/run/message
 * projection while the final legacy entity mirrors are being removed.
 */
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
			if (import.meta.env.DEV) console.debug("[WS] 已连接到项目", projectId);
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

				applyServerEvent(appQueryClient, projectId, data);
				applyWsEvent(projectId, data, useEditorStore.getState().runMode, scheduleAutoConfirm);

				if (eventId !== null) {
					lastEventIdRef.current = eventId;
					writeWsCursor(projectId, eventId);
				}
			} catch (error) {
				if (import.meta.env.DEV) console.error("[WS] 解析错误:", error);
				toast.error({
					title: "数据格式错误",
					message: "服务器返回了无法识别的数据，请刷新页面重试",
					duration: 3000,
				});
			}
		};

		ws.onerror = (error) => {
			if (import.meta.env.DEV) console.error("[WS] 连接错误:", error);
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
			if (import.meta.env.DEV) console.debug("[WS] 连接断开");
			globalConnections.delete(projectId);
			if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
				reconnectAttempts.current += 1;
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
		if (!projectId) return;
		const ws = globalConnections.get(projectId);
		if (ws) {
			ws.close();
			globalConnections.delete(projectId);
		}
	}, [projectId, clearReconnectTimer, clearAutoConfirm]);

	const send = useCallback(
		(data: Record<string, unknown>) => {
			if (!projectId) return;
			const ws = globalConnections.get(projectId);
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
		},
		[projectId],
	);

	sendRef.current = send;

	useEffect(() => {
		reconnectAttempts.current = 0;
		lastEventIdRef.current = projectId ? readWsCursor(projectId) : null;
		connect();
		return () => clearReconnectTimer();
	}, [projectId, connect, clearReconnectTimer]);

	return { send, disconnect, reconnect: connect, clearAutoConfirm };
}
