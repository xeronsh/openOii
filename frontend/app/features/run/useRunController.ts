import { StopIcon } from "@heroicons/react/24/outline";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { appendMessage, clearMessageFeed } from "~/query/messageFeed";
import { patchRunState, resetRunState } from "~/query/runState";
import { useProjectWebSocket } from "~/hooks/useWebSocket";
import { useEditorStore } from "~/stores/editorStore";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { projectsApi, runsApi } from "~/services/api";
import type {
	Character,
	Project,
	RecoveryControlRead,
	Shot,
	WorkflowStage,
} from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";
import { toSimplifiedStage } from "~/utils/workflowStage";
import type { LastRunTerminalStatus } from "../comic-workflow/state/deriveWorkbenchStatus";

type FeedbackType = "plan" | "render" | "compose";

function isRecoveryControlRead(value: unknown): value is RecoveryControlRead {
	if (typeof value !== "object" || value === null) return false;
	const control = value as Partial<RecoveryControlRead>;
	return (
		(control.state === "active" || control.state === "recoverable") &&
		Boolean(control.active_run && control.recovery_summary)
	);
}

function feedbackTypeForStage(stage: WorkflowStage): FeedbackType {
	if (stage === "render" || stage === "render_approval") return "render";
	if (stage === "compose") return "compose";
	return "plan";
}

export function useRunController(args: {
	projectId: number;
	project: Project | undefined;
	characters: Character[];
	shots: Shot[];
	currentStage: WorkflowStage;
	currentRunId: number | null;
	isGenerating: boolean;
	recoveryControl: RecoveryControlRead | null;
	selectedNodeId: string | null;
	selectedNodeIds: string[];
}) {
	const {
		projectId,
		project,
		characters,
		shots,
		currentStage,
		currentRunId,
		isGenerating,
		recoveryControl,
		selectedNodeId,
		selectedNodeIds,
	} = args;
	const [searchParams, setSearchParams] = useSearchParams();
	const { send } = useProjectWebSocket(projectId);
	const [lastRunStatus, setLastRunStatus] = useState<LastRunTerminalStatus>(null);
	const requestTokenRef = useRef(0);
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
			if (searchParams.get("preflight") === "true") {
				const next = new URLSearchParams(searchParams);
				next.delete("preflight");
				next.delete("skill");
				next.delete("autoStart");
				setSearchParams(next, { replace: true });
			}
		},
		onError: (error: Error | ApiError, variables) => {
			if (variables?.requestToken !== requestTokenRef.current) return;
			autoStartTriggered.current = false;
			const apiError = error instanceof ApiError ? error : null;
			const isConflict = apiError?.status === 409;

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
	});

	const feedbackMutation = useMutation({
		mutationFn: (payload: {
			content: string;
			entityType?: string;
			entityId?: number;
			entityIds?: number[];
		}) =>
			projectsApi.feedback(
				projectId,
				payload.content,
				undefined,
				feedbackTypeForStage(currentStage),
				payload.entityType,
				payload.entityId,
				payload.entityIds?.length ? payload.entityIds : undefined,
			),
		onSuccess: (result) => {
			if (result?.run_id) {
				patchRunState(projectId, {
					currentRunId: result.run_id,
					isGenerating: true,
					currentAgent: "review",
					currentStage: "review",
					progress: 0,
					recoveryControl: null,
					recoverySummary: null,
				});
			}
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			const isConflict = apiError?.status === 409;
			if (isConflict) {
				const control = apiError && isRecoveryControlRead(apiError.response)
					? apiError.response
					: undefined;
				if (control?.active_run && control.recovery_summary) {
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
						control.recovery_summary.next_stage ?? control.recovery_summary.current_stage,
					);
					if (stage) patchRunState(projectId, { currentStage: stage });
					toast.info({ title: "已有任务进行中", message: "已恢复当前运行控制，请先确认或停止" });
					return;
				}
				toast.info({ title: "AI 正在思考", message: "请等待当前任务完成" });
				return;
			}
			toast.error({
				title: "提交失败",
				message: apiError?.message || error.message || "无法发送反馈，请重试",
			});
		},
	});

	const cancelMutation = useMutation({
		mutationFn: () => {
			const runId = currentRunId ?? recoveryControl?.active_run.id ?? null;
			if (runId === null) throw new Error("没有可取消的运行");
			return runsApi.cancel(runId);
		},
		onSuccess: (result) => {
			if (result?.status === "cancelled") setLastRunStatus("cancelled");
		},
		onSettled: () => {
			resetRunState(projectId);
			appendMessage(projectId, {
				agent: "system",
				role: "system",
				content: "生成已停止",
				icon: StopIcon,
				timestamp: new Date().toISOString(),
			});
		},
	});

	const resumeMutation = useMutation({
		mutationFn: () => {
			if (!recoveryControl) throw new Error("没有可恢复的运行");
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
	});

	const handleGenerate = () => {
		if (generateMutation.isPending || hasActiveRun) return;
		const requestToken = requestTokenRef.current + 1;
		requestTokenRef.current = requestToken;
		setLastRunStatus(null);
		clearMessageFeed(projectId);
		patchRunState(projectId, { currentStage: "plan" });
		generateMutation.mutate({
			requestToken,
			skillId: searchParams.get("skill") || project?.skill_id || null,
		});
	};

	const handleFeedback = (content: string) => {
		setLastRunStatus(null);
		const ids = selectedNodeIds.length > 0 ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
		const shotIds = ids
			.filter((id) => id.startsWith("shot:"))
			.map((id) => Number(id.split(":")[1]))
			.filter(Number.isFinite);
		const characterIds = ids
			.filter((id) => id.startsWith("character:"))
			.map((id) => Number(id.split(":")[1]))
			.filter(Number.isFinite);

		let entityType: string | undefined;
		let entityId: number | undefined;
		let entityIds: number[] | undefined;
		let contextLabel = "";
		if (shotIds.length > 0 && characterIds.length === 0) {
			entityType = "shot";
			entityId = shotIds[0];
			entityIds = shotIds;
			contextLabel = shotIds.length === 1
				? `（格 · 镜头 ${shots.find((shot) => shot.id === shotIds[0])?.order ?? shotIds[0]}）`
				: `（${shotIds.length} 个分镜格）`;
		} else if (characterIds.length > 0 && shotIds.length === 0) {
			entityType = "character";
			entityId = characterIds[0];
			entityIds = characterIds;
			const character = characters.find((item) => item.id === characterIds[0]);
			contextLabel = characterIds.length === 1
				? character?.name ? `（角色：${character.name}）` : `（角色 #${characterIds[0]}）`
				: `（${characterIds.length} 个角色）`;
		}

		feedbackMutation.mutate({ content, entityType, entityId, entityIds });
		appendMessage(projectId, {
			agent: "user",
			role: "user",
			content: contextLabel ? `${content}\n${contextLabel}` : content,
			timestamp: new Date().toISOString(),
		});
	};

	const handleConfirm = (feedback?: string) => {
		if (!currentRunId) return;
		let annotated = feedback?.trim() || "";
		if (annotated && selectedNodeIds.length > 0) {
			const focus = selectedNodeIds
				.map((id) => {
					if (id.startsWith("shot:")) {
						const shotId = Number(id.split(":")[1]);
						const shot = shots.find((item) => item.id === shotId);
						return `格${shot?.order ?? shotId}`;
					}
					if (id.startsWith("character:")) {
						const characterId = Number(id.split(":")[1]);
						const character = characters.find((item) => item.id === characterId);
						return character?.name || `角色${characterId}`;
					}
					return id;
				})
				.join("、");
			annotated = `${annotated}\n（绑定：${focus}）`;
		}
		send({ type: "confirm", data: { run_id: currentRunId, feedback: annotated || feedback } });
		if (annotated || feedback) {
			appendMessage(projectId, {
				agent: "user",
				role: "user",
				content: annotated || feedback || "",
				timestamp: new Date().toISOString(),
			});
		}
	};

	const handleCancel = () => {
		const activeRunId = currentRunId ?? recoveryControl?.active_run.id ?? null;
		if (!activeRunId && !isGenerating && recoveryControl?.state !== "active") return;
		requestTokenRef.current += 1;
		cancelMutation.mutate();
	};

	const handleResume = () => {
		if (recoveryControl) resumeMutation.mutate();
	};

	useEffect(() => {
		return canvasEvents.on("request-regenerate", () => {
			if (recoveryControl) handleResume();
			else handleGenerate();
		});
	});

	useEffect(() => {
		const autoStart = searchParams.get("autoStart");
		const skillId = searchParams.get("skill") || project?.skill_id || null;
		if (!autoStartTriggered.current && autoStart === "true" && project && !hasActiveRun) {
			autoStartTriggered.current = true;
			if (searchParams.get("preflight") === "true") {
				const next = new URLSearchParams(searchParams);
				next.delete("autoStart");
				setSearchParams(next, { replace: true });
			} else {
				setSearchParams({}, { replace: true });
			}
			const requestToken = requestTokenRef.current + 1;
			requestTokenRef.current = requestToken;
			setLastRunStatus(null);
			clearMessageFeed(projectId);
			patchRunState(projectId, { currentStage: "plan" });
			const useYolo = project.creation_mode
				? project.creation_mode === "quick"
				: skillId === "quick-short";
			useEditorStore.getState().setRunMode(useYolo ? "yolo" : "manual");
			generateMutation.mutate({ requestToken, skillId });
		}
	}, [project, searchParams, setSearchParams, generateMutation, hasActiveRun, projectId]);

	return {
		handleGenerate,
		handleFeedback,
		handleConfirm,
		handleCancel,
		handleResume,
		generatePending: generateMutation.isPending,
		lastRunStatus,
	};
}
