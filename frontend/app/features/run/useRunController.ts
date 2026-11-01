import { useMutation } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { appendMessage, clearMessageFeed } from "~/query/messageFeed";
import { sendChat } from "~/query/assistantChat";
import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import { patchRunState, readRunState, resetRunState } from "~/query/runState";
import { useProjectWebSocket } from "~/hooks/useWebSocket";
import { resyncRunState } from "~/query/resyncRunState";
import { setFeedbackReceipt } from "~/hooks/applyWsEvent";
import { useEditorStore } from "~/stores/editorStore";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { projectsApi, runsApi } from "~/services/api";
import type {
	Character,
	Project,
	RecoveryControlRead,
	Shot,
} from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";
import { toSimplifiedStage } from "~/utils/workflowStage";
import type { LastRunTerminalStatus } from "../comic-workflow/state/deriveStudioStatus";

function isRecoveryControlRead(value: unknown): value is RecoveryControlRead {
	if (typeof value !== "object" || value === null) return false;
	const control = value as Partial<RecoveryControlRead>;
	return (
		(control.state === "active" || control.state === "recoverable") &&
		Boolean(control.active_run && control.recovery_summary)
	);
}

export function useRunController(args: {
	projectId: number;
	project: Project | undefined;
	characters: Character[];
	shots: Shot[];
	currentRunId: number | null;
	isGenerating: boolean;
	recoveryControl: RecoveryControlRead | null;
	selectedNodeId: string | null;
	selectedNodeIds: string[];
	/** 有产物时，画布上的「重新合成」等入口先走重新生成确认框 */
	onRequestRegenerate?: () => void;
}) {
	const {
		projectId,
		project,
		characters,
		shots,
		currentRunId,
		isGenerating,
		recoveryControl,
		selectedNodeId,
		selectedNodeIds,
		onRequestRegenerate,
	} = args;
	const [searchParams, setSearchParams] = useSearchParams();
	const { send } = useProjectWebSocket(projectId);
	const [lastRunStatus, setLastRunStatus] = useState<LastRunTerminalStatus>(null);
	const requestTokenRef = useRef(0);
	const cancelPendingRef = useRef(false);
	const autoStartTriggered = useRef(false);
	const hasActiveRun = isGenerating || Boolean(currentRunId);

	useLayoutEffect(() => {
		requestTokenRef.current += 1;
		autoStartTriggered.current = false;
	}, [projectId]);

	const syncRunStateWithActiveRun = (run: {
		id: number;
		current_agent?: string | null;
		progress?: number | null;
		provider_snapshot?: Project["provider_settings"] | null;
	}) => {
		patchRunState(projectId, {
			isGenerating: true,
			currentRunId: run.id,
			currentAgent: run.current_agent ?? "orchestrator",
			progress: typeof run.progress === "number" ? run.progress : 0,
			currentRunProviderSnapshot: run.provider_snapshot ?? null,
			awaitingConfirm: false,
			awaitingAgent: null,
			recoveryControl: null,
			recoverySummary: null,
			recoveryGate: null,
		});
		setLastRunStatus(null);
	};

	const generateMutation = useMutation({
		mutationFn: ({
			requestToken,
			skillId,
		}: {
			requestToken: number;
			skillId?: string | null;
		}) =>
			projectsApi
				.startRun(projectId, {
					auto_mode: useEditorStore.getState().runMode === "yolo",
					skill_id: skillId || undefined,
				})
				.then((run) => ({ run, requestToken })),
		onSuccess: ({ run, requestToken }) => {
			if (requestToken !== requestTokenRef.current) return;
			syncRunStateWithActiveRun(run);
		},
		onError: (error: Error | ApiError, variables) => {
			if (variables?.requestToken !== requestTokenRef.current) return;
			autoStartTriggered.current = false;
			const apiError = error instanceof ApiError ? error : null;
			// 版本不兼容也是 409，但不是「正忙」：直接说明原因
			const isConflict = apiError?.status === 409 && apiError.code !== "RUN_WORKFLOW_INCOMPATIBLE";

			if (isConflict) {
				const control = apiError && isRecoveryControlRead(apiError.response)
					? apiError.response
					: undefined;
				if (control) {
					patchRunState(projectId, {
						recoveryControl: control,
						recoverySummary: control.recovery_summary,
						isGenerating: control.state === "active",
						...(control.state === "active"
							? {
								currentRunId: control.active_run.id,
								currentAgent: control.active_run.current_agent,
								progress: control.active_run.progress,
							}
							: {}),
					});
					const stage = toSimplifiedStage(
						control.recovery_summary.next_stage ??
							control.recovery_summary.current_stage,
					);
					if (stage) patchRunState(projectId, { currentStage: stage });
					toast.info({
						title: control.state === "active" ? "已有生成正在进行" : "发现可恢复的运行",
						message:
							control.state === "active"
								? "已接管当前运行的进度，可选择停止后重新生成"
								: "可从上次中断的阶段继续，或停止后重新开始",
						duration: 5000,
					});
				} else {
					toast.warning({ title: "请稍等片刻", message: "另一个任务正在进行，完成后再试" });
				}
				return;
			}

			toast.error({
				title: "生成失败",
				message: apiError?.message || error.message || "生成过程出错，请重试或联系支持",
				details: import.meta.env.DEV ? JSON.stringify(apiError?.details) : undefined,
			});
		},
		onSettled: () => {
			patchRunState(projectId, { startingRun: false });
			// 新运行带着上一版：菜单里的「下载上一版成片」随之更新
			void appQueryClient.invalidateQueries({ queryKey: projectQueryKeys.regeneratePlan(projectId) });
			resyncRunState(projectId, { project: true });
		},
	});

	/** 闸门处的两个决定：批准，或要求修改（重做本阶段后回到同一闸门）。 */
	const gateDecisionError = (error: Error | ApiError, fallback: string) => {
		const apiError = error instanceof ApiError ? error : null;
		if (apiError?.status === 409) {
			toast.info({ title: "运行状态已变化", message: apiError.message || fallback });
			return;
		}
		toast.error({ title: fallback, message: apiError?.message || error.message || "请重试" });
	};

	const confirmMutation = useMutation({
		mutationFn: ({ runId }: { runId: number }) => runsApi.confirm(runId),
		onError: (error: Error | ApiError, { runId }) => {
			if (!(error instanceof ApiError) || error.status === 0 || error.status === undefined) {
				// 网络失败时退回 WS 信号，按钮不能失效
				send({ type: "confirm", data: { run_id: runId } });
				return;
			}
			gateDecisionError(error, "确认没有生效");
		},
		onSettled: () => resyncRunState(projectId),
	});

	const gateFeedbackMutation = useMutation({
		mutationFn: (args: {
			runId: number;
			content: string;
			entityType?: "character" | "shot";
			entityIds?: number[];
		}) =>
			runsApi.gateFeedback(args.runId, {
				content: args.content,
				...(args.entityType && args.entityIds?.length
					? { entity_type: args.entityType, entity_ids: args.entityIds }
					: {}),
			}),
		onSuccess: (result, args) => {
			const state = readRunState(projectId);
			const previous = state.feedbackReceipt;
			const gateStage = state.recoveryGate?.current_stage ?? state.recoveryGate?.stage ?? null;
			if (previous?.id === result.feedback_id) return;
			setFeedbackReceipt(projectId, {
				id: result.feedback_id,
				// 轮次由服务端按已保存的回执算出；旧后端没有时才本地推
				round: result.round ?? (state.recoveryGate?.feedback?.round ?? 0) + 1,
				state: "received",
				content: args.content,
				reason: null,
				gate: gateStage,
				entityType: args.entityType ?? null,
				entityIds: args.entityIds ?? null,
			});
		},
		onError: (error: Error | ApiError) => gateDecisionError(error, "修改意见没有提交"),
		onSettled: () => resyncRunState(projectId),
	});

	const cancelMutation = useMutation({
		mutationFn: ({ runId }: { runId: number }) => runsApi.cancel(runId),
		onSuccess: (result, { runId }) => {
			const state = readRunState(projectId);
			const ownsCurrentRun = state.currentRunId !== null
				? state.currentRunId === runId
				: !state.isGenerating && state.recoveryControl?.active_run.id === runId;
			if (result?.status === "cancelled" && result.cancelled > 0) {
				if (ownsCurrentRun) {
					setLastRunStatus("cancelled");
					resetRunState(projectId);
					appendMessage(projectId, {
						agent: "system",
						role: "system",
						content: "生成已停止",
						icon: "stop",
						timestamp: new Date().toISOString(),
					});
				}
				return;
			}
			if (result?.status === "no_active_run") {
				if (ownsCurrentRun) resetRunState(projectId);
				appQueryClient.invalidateQueries({ queryKey: projectQueryKeys.runState(projectId) });
				toast.info({ title: "运行状态已同步", message: "该运行已结束，正在刷新当前状态" });
				return;
			}
			toast.info({
				title: "停止尚未完成",
				message: "已提交停止请求，生成仍在停止中",
			});
		},
		onError: (error: Error | ApiError, { runId }) => {
			if (readRunState(projectId).currentRunId === runId) resetRunState(projectId);
			appQueryClient.invalidateQueries({ queryKey: projectQueryKeys.runState(projectId) });
			toast.warning({
				title: "停止结果未知",
				message: "请求可能已送达，正在同步运行状态；请刷新后确认结果",
				details: error.message,
			});
		},
		onSettled: () => {
			cancelPendingRef.current = false;
			resyncRunState(projectId, { project: true });
		},
	});

	const resumeMutation = useMutation({
		mutationFn: () => {
			if (recoveryControl?.state !== "recoverable") throw new Error("没有可恢复的运行");
			return runsApi.resume(recoveryControl.active_run.id);
		},
		onSuccess: (run) => {
			patchRunState(projectId, {
				isGenerating: true,
				currentRunId: run.id,
				currentAgent: run.current_agent,
				progress: run.progress,
				currentRunProviderSnapshot: run.provider_snapshot ?? null,
				recoveryControl: null,
				recoverySummary: null,
				recoveryGate: null,
			});
			const nextStage = toSimplifiedStage(
				recoveryControl?.recovery_summary.next_stage ??
					recoveryControl?.recovery_summary.current_stage,
			);
			if (nextStage) patchRunState(projectId, { currentStage: nextStage });
			setLastRunStatus(null);
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			toast.error({
				title: "恢复失败",
				message: apiError?.message || error.message || "无法恢复当前运行，请重试",
			});
		},
		onSettled: () => resyncRunState(projectId, { project: true }),
	});

	const recomposeMutation = useMutation({
		mutationFn: () => projectsApi.recompose(projectId),
		onSuccess: (run) => {
			patchRunState(projectId, {
				isGenerating: true,
				currentRunId: run.id,
				currentAgent: run.current_agent,
				progress: run.progress,
				currentRunProviderSnapshot: run.provider_snapshot ?? null,
				currentStage: "compose",
				recoveryControl: null,
				recoverySummary: null,
				recoveryGate: null,
			});
			setLastRunStatus(null);
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			toast.error({
				title: "重新合成失败",
				message: apiError?.message || error.message || "无法开始重新合成，请重试",
			});
		},
		onSettled: () => resyncRunState(projectId, { project: true }),
	});

	const restoreMutation = useMutation({
		mutationFn: (runId: number) => runsApi.restorePrevious(runId),
		onSuccess: (result) => {
			toast.success({
				title: result.restored ? "已恢复上一版" : "已经是上一版",
				message: result.restored ? "成片、大纲、角色和分镜都回到了重新生成之前" : "没有需要恢复的改动",
			});
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			toast.error({ title: "恢复失败", message: apiError?.message || error.message || "请重试" });
		},
		onSettled: () => {
			for (const key of [
				projectQueryKeys.characters(projectId),
				projectQueryKeys.shots(projectId),
				projectQueryKeys.regeneratePlan(projectId),
			]) {
				void appQueryClient.invalidateQueries({ queryKey: key });
			}
			resyncRunState(projectId, { project: true });
		},
	});

	const handleRestorePrevious = (runId: number) => {
		if (!restoreMutation.isPending) restoreMutation.mutate(runId);
	};

	const handleGenerate = () => {
		if (generateMutation.isPending || hasActiveRun) return;
		const requestToken = requestTokenRef.current + 1;
		requestTokenRef.current = requestToken;
		setLastRunStatus(null);
		clearMessageFeed(projectId);
		// 创建运行要等服务端确认：按钮和时间线先给出「正在创建」
		patchRunState(projectId, { currentStage: "plan", startingRun: true });
		generateMutation.mutate({
			requestToken,
			skillId: searchParams.get("skill") || project?.skill_id || null,
		});
	};

	/** 输入框（非审批门）发给项目助手；选中的分镜/角色作为一行上下文附在后面。 */
	const handleChat = (content: string): Promise<boolean> => {
		const ids = selectedNodeIds.length > 0 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
		const picked = ids.flatMap((id) => {
			const [kind, raw] = id.split(":");
			const entityId = Number(raw);
			if (kind === "shot") {
				const order = shots.find((shot) => shot.id === entityId)?.order;
				return [`分镜 #${entityId}${order ? `（第 ${order} 镜）` : ""}`];
			}
			if (kind === "character") {
				const name = characters.find((item) => item.id === entityId)?.name;
				return [`角色 #${entityId}${name ? `（${name}）` : ""}`];
			}
			return [];
		});
		return sendChat(projectId, picked.length > 0 ? `${content}\n（选中：${picked.join("、")}）` : content);
	};

	/**
	 * 闸门处的决定。没有意见 = 批准；有意见 = 要求修改：engine 按意见重做本阶段，
	 * 产出新版本（或说明为什么没改）后回到同一闸门，绝不自动往下走。
	 * 返回 false 表示没提交成功，PromptBar 会把草稿放回去。
	 */
	const handleConfirm = (feedback?: string): Promise<boolean> => {
		const runId = currentRunId ?? readRunState(projectId).currentRunId;
		if (!runId) return Promise.resolve(false);
		const content = feedback?.trim() || "";
		if (!content) {
			return confirmMutation.mutateAsync({ runId }).then(
				() => true,
				() => false,
			);
		}
		const shotIds = selectedNodeIds
			.filter((id) => id.startsWith("shot:"))
			.map((id) => Number(id.split(":")[1]))
			.filter((id) => Number.isInteger(id) && id > 0);
		const characterIds = selectedNodeIds
			.filter((id) => id.startsWith("character:"))
			.map((id) => Number(id.split(":")[1]))
			.filter((id) => Number.isInteger(id) && id > 0);
		let entityType: "character" | "shot" | undefined;
		let entityIds: number[] | undefined;
		let annotated = content;
		if (shotIds.length > 0 && characterIds.length === 0) {
			entityType = "shot";
			entityIds = shotIds;
		} else if (characterIds.length > 0 && shotIds.length === 0) {
			entityType = "character";
			entityIds = characterIds;
		} else if (selectedNodeIds.length > 0) {
			// 混选没法定位到一类对象：把焦点写进意见，整阶段重做
			const focus = selectedNodeIds
				.map((id) => {
					if (id.startsWith("shot:")) {
						const shotId = Number(id.split(":")[1]);
						const order = shots.find((item) => item.id === shotId)?.order;
						return order === undefined ? "一格分镜" : `S${String(order).padStart(2, "0")}`;
					}
					if (id.startsWith("character:")) {
						const characterId = Number(id.split(":")[1]);
						return characters.find((item) => item.id === characterId)?.name || `角色${characterId}`;
					}
					return id;
				})
				.join("、");
			annotated = `${content}\n（绑定：${focus}）`;
		}
		return gateFeedbackMutation
			.mutateAsync({ runId, content: annotated, entityType, entityIds })
			.then(
				() => true,
				() => false,
			);
	};

	const handleCancel = () => {
		const activeRunId = currentRunId ?? recoveryControl?.active_run.id ?? null;
		if (activeRunId === null || cancelPendingRef.current) return;
		cancelPendingRef.current = true;
		requestTokenRef.current += 1;
		cancelMutation.mutate({ runId: activeRunId });
	};

	// 只有真正中断（recoverable）的运行才能“继续”；active 的运行还在跑
	const handleResume = () => {
		if (recoveryControl?.state === "recoverable") resumeMutation.mutate();
	};

	useEffect(() => {
		return canvasEvents.on("request-regenerate", ({ mode }) => {
			if (recoveryControl?.state === "recoverable") handleResume();
			else if (mode === "recompose") {
				if (!recomposeMutation.isPending) recomposeMutation.mutate();
			}
			else if (onRequestRegenerate) onRequestRegenerate();
			else handleGenerate();
		});
	});

	useEffect(() => {
		const autoStart = searchParams.get("autoStart");
		const skillId = searchParams.get("skill") || project?.skill_id || null;
		if (!autoStartTriggered.current && autoStart === "true" && project && !hasActiveRun) {
			autoStartTriggered.current = true;
			setSearchParams({}, { replace: true });
			const requestToken = requestTokenRef.current + 1;
			requestTokenRef.current = requestToken;
			setLastRunStatus(null);
			clearMessageFeed(projectId);
			patchRunState(projectId, { currentStage: "plan", startingRun: true });
			const useYolo = project.creation_mode
				? project.creation_mode === "quick"
				: skillId === "quick-short";
			useEditorStore.getState().setRunMode(useYolo ? "yolo" : "manual");
			generateMutation.mutate({ requestToken, skillId });
		}
	}, [project, searchParams, setSearchParams, generateMutation, hasActiveRun, projectId]);

	return {
		handleGenerate,
		handleChat,
		handleConfirm,
		handleCancel,
		handleResume,
		generatePending: generateMutation.isPending,
		handleRestorePrevious,
		restorePending: restoreMutation.isPending,
		gateDecisionPending: confirmMutation.isPending || gateFeedbackMutation.isPending,
		lastRunStatus,
	};
}
