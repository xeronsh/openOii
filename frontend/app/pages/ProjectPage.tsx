import { ArrowPathIcon, StopIcon } from "@heroicons/react/24/outline";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Link,
	useParams,
	useSearchParams,
} from "react-router-dom";
import { TopBar } from "~/components/layout/TopBar";
import { StagePipeline } from "~/components/layout/StagePipeline";
import { StageView } from "~/components/layout/StageView";
import { Button } from "~/components/ui/Button";
import { Card } from "~/components/ui/Card";
import { useProjectWebSocket } from "~/hooks/useWebSocket";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { buildComicWorkflow } from "~/features/comic-workflow/graph/buildComicWorkflow";
import {
	WorkspaceSidebar,
	type WorkspaceSidebarTab,
} from "~/features/comic-workflow/sidebar/WorkspaceSidebar";
import {
	deriveWorkbenchStatus,
	type LastRunTerminalStatus,
} from "~/features/comic-workflow/state/deriveWorkbenchStatus";
import { MobileWorkbenchPreview } from "~/features/comic-workflow/mobile/MobileWorkbenchPreview";
import { useIsMobileWorkbench } from "~/features/comic-workflow/mobile/useIsMobileWorkbench";
import { projectsApi, runsApi, exportApi, getStaticUrl } from "~/services/api";
import { useEditorStore, useShallow } from "~/stores/editorStore";
import { projectQueryKeys } from "~/query/queryKeys";
import type {
	ProjectProviderSettings,
	RecoveryControlRead,
	VersionEntityType,
	WorkflowStage,
} from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";
import { toSimplifiedStage } from "~/utils/workflowStage";

const VersionCompareDrawer = lazy(() =>
	import("~/components/panels/VersionCompareDrawer").then((m) => ({
		default: m.VersionCompareDrawer,
	})),
);
const ConsistencyPanel = lazy(() =>
	import("~/components/panels/ConsistencyPanel").then((m) => ({
		default: m.ConsistencyPanel,
	})),
);

type FeedbackType = "plan" | "render" | "compose";

function feedbackTypeForStage(stage: WorkflowStage): FeedbackType {
	if (stage === "render" || stage === "render_approval") return "render";
	if (stage === "compose") return "compose";
	return "plan";
}

export function ProjectPage() {
	const { id } = useParams<{ id: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const projectId = parseInt(id || "0", 10);
	const queryClient = useQueryClient();
	const {
		isGenerating: storeIsGenerating,
		currentRunId: storeCurrentRunId,
		currentStage: storeCurrentStage,
		progress: storeProgress,
		awaitingConfirm: storeAwaitingConfirm,
		recoveryControl: storeRecoveryControl,
		runMode: storeRunMode,
	} = useEditorStore(
		useShallow((s) => ({
			isGenerating: s.isGenerating,
			currentRunId: s.currentRunId,
			currentStage: s.currentStage,
			progress: s.progress,
			awaitingConfirm: s.awaitingConfirm,
			recoveryControl: s.recoveryControl,
			runMode: s.runMode,
		})),
	);
	const hasActiveRun = storeIsGenerating || Boolean(storeCurrentRunId);
	const hasRecovery = Boolean(storeRecoveryControl);
	const [sidebarTab, setSidebarTab] = useState<WorkspaceSidebarTab>("chat");
	const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
	const [lastRunStatus, setLastRunStatus] =
		useState<LastRunTerminalStatus>(null);
	const [versionOpen, setVersionOpen] = useState(false);
	const [consistencyOpen, setConsistencyOpen] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [versionTarget, setVersionTarget] = useState<{
		entityType: VersionEntityType;
		entityId: number;
	} | null>(null);
	const autoStartTriggered = useRef(false);
	const generateRequestTokenRef = useRef(0);
	const retryCount = useRef(0);
	const messagesLoadedRef = useRef(false);
	const runModeInitializedRef = useRef<number | null>(null);

	const { send } = useProjectWebSocket(projectId);

	useEffect(() => {
		return canvasEvents.on("version-history", (target) => {
			setVersionTarget({ entityType: target.entityType, entityId: target.entityId });
			setVersionOpen(true);
		});
	}, []);

	const syncStoreWithActiveRun = (run: {
		id: number;
		current_agent?: string | null;
		progress?: number | null;
		provider_snapshot?: ProjectProviderSettings | null;
	}) => {
		const s = useEditorStore.getState();
		s.setGenerating(true);
		s.setCurrentRunId(run.id);
		s.setCurrentAgent(run.current_agent ?? "orchestrator");
		s.setProgress(typeof run.progress === "number" ? run.progress : 0);
		s.setCurrentRunProviderSnapshot(run.provider_snapshot ?? null);
		s.setAwaitingConfirm(false, null, run.id);
		s.setRecoveryControl(null);
		s.setRecoverySummary(null);
		s.setRecoveryGate(null);
		setLastRunStatus(null);
	};

	const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
		queryKey: projectQueryKeys.project(projectId),
		queryFn: () => projectsApi.get(projectId),
		enabled: projectId > 0,
		retry: 1,
	});

	useEffect(() => {
		if (projectError) {
			const apiError = projectError instanceof ApiError ? projectError : null;
			toast.error({
				title: "无法加载项目",
				message: apiError?.message || "项目数据获取失败，请重试",
				actions: [
					{
						label: "重试",
						onClick: () =>
							queryClient.invalidateQueries({
								queryKey: ["project", projectId],
							}),
					},
				],
			});
		}
	}, [projectError, projectId, queryClient]);

	const { data: characters = [] } = useQuery({
		queryKey: projectQueryKeys.characters(projectId),
		queryFn: () => projectsApi.getCharacters(projectId),
		enabled: !!project,
	});

	const { data: shots = [] } = useQuery({
		queryKey: projectQueryKeys.shots(projectId),
		queryFn: () => projectsApi.getShots(projectId),
		enabled: !!project,
	});

	const { data: messages } = useQuery({
		queryKey: projectQueryKeys.messages(projectId),
		queryFn: () => projectsApi.getMessages(projectId),
		enabled: !!project,
	});

	// 运行态水合：不必先撞一次 409 才能发现可恢复的运行
	const { data: hydratedGenerationState } = useQuery({
		queryKey: projectQueryKeys.generationState(projectId),
		queryFn: () => projectsApi.currentRun(projectId),
		enabled: projectId > 0,
		retry: 1,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (!hydratedGenerationState) return;
		const s = useEditorStore.getState();
		// WS 已建立实时态时不覆盖
		if (s.isGenerating || s.currentRunId) return;
		s.setRecoveryControl(hydratedGenerationState);
		s.setRecoverySummary(hydratedGenerationState.recovery_summary);
		if (hydratedGenerationState.state === "active") {
			// currentRunId 只在真活跃时设置：recoverable 状态设了会让
			// hasActiveRun 误判为生成中，把「恢复」按钮短路成只剩「停止」
			s.setCurrentRunId(hydratedGenerationState.active_run.id);
			s.setGenerating(true);
			s.setCurrentAgent(hydratedGenerationState.active_run.current_agent);
			s.setProgress(hydratedGenerationState.active_run.progress ?? 0);
		}
		const stage = toSimplifiedStage(
			hydratedGenerationState.recovery_summary.next_stage ??
				hydratedGenerationState.recovery_summary.current_stage,
		);
		if (stage) s.setCurrentStage(stage);
	}, [hydratedGenerationState]);

	useEffect(() => {
		if (project) {
			const editorStore = useEditorStore.getState();
			if (runModeInitializedRef.current !== project.id) {
				editorStore.setRunMode(
					project.creation_mode === "quick" ? "yolo" : "manual",
				);
				runModeInitializedRef.current = project.id;
			}
			// 初始阶段按项目真实状态落位，而不是每次打开都归零到 规划/0%。
			// 有实时运行态或恢复水合时让位给它们（recovery_summary 的 stage 更精确）。
			if (!editorStore.isGenerating && !editorStore.currentRunId) {
				if (project.status === "ready" && project.video_url) {
					editorStore.setCurrentStage("compose");
					editorStore.setProgress(1);
				}
			}
		}
	}, [project]);

	useLayoutEffect(() => {
		if (projectId <= 0) return;

		generateRequestTokenRef.current += 1;
		messagesLoadedRef.current = false;
		runModeInitializedRef.current = null;
		const editorStore = useEditorStore.getState();

		editorStore.clearMessages();
		editorStore.resetRunState();
		editorStore.setCurrentStage("plan");
		editorStore.setSelectedShot(null);
		editorStore.setSelectedCharacter(null);
		editorStore.setHighlightedMessage(null);
		setLastRunStatus(null);
		setSelectedNodeId(null);
		setSelectedNodeIds([]);
		setSidebarTab("chat");
	}, [projectId]);

	useEffect(() => {
		if (messages && !messagesLoadedRef.current) {
			messagesLoadedRef.current = true;
			const editorStore = useEditorStore.getState();
			messages.forEach((msg) => {
				editorStore.addMessage({
					id: `db_${msg.id}`,
					agent: msg.agent,
					role: msg.role,
					content: msg.content,
					timestamp: msg.created_at,
					progress: msg.progress ?? undefined,
					// 从数据库加载的消息不再显示为加载中
					isLoading: false,
				});
			});
		}
	}, [messages]);

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
			if (requestToken !== generateRequestTokenRef.current) return;
			syncStoreWithActiveRun(run);
			retryCount.current = 0;
		},
		onError: async (error: Error | ApiError, variables) => {
			if (variables?.requestToken !== generateRequestTokenRef.current) return;
			const apiError = error instanceof ApiError ? error : null;
			const isConflict =
				apiError?.status === 409 || error.message.includes("409");

			if (isConflict) {
				retryCount.current = 0;
				const control = apiError?.response as RecoveryControlRead | undefined;
				if (control) {
					const s = useEditorStore.getState();
					s.setRecoveryControl(control);
					s.setRecoverySummary(control.recovery_summary);
					s.setGenerating(control.state === "active");
					if (control.state === "active") {
						// recoverable 时不设 currentRunId，避免「恢复」按钮被短路成「停止」
						s.setCurrentRunId(control.active_run.id);
						s.setCurrentAgent(control.active_run.current_agent);
						s.setProgress(control.active_run.progress);
					}
					const stage = toSimplifiedStage(
						control.recovery_summary.next_stage ??
							control.recovery_summary.current_stage,
					);
					if (stage) s.setCurrentStage(stage);
					// 说明性提示：按钮此时会静默换成「恢复 / 停止」，
					// 不提示的话用户会以为点击没有生效
					toast.info({
						title:
							control.state === "active" ? "已有生成正在进行" : "发现可恢复的运行",
						message:
							control.state === "active"
								? "已接管当前运行的进度，可选择停止后重新生成"
								: "可从上次中断的阶段继续，或停止后重新开始",
						duration: 5000,
					});
				} else {
					toast.warning({
						title: "请稍等片刻",
						message: "另一个任务正在进行，完成后再试",
					});
				}
			} else {
				toast.error({
					title: "生成失败",
					message:
						apiError?.message ||
						error.message ||
						"生成过程出错，请重试或联系支持",
					details: import.meta.env.DEV
						? JSON.stringify(apiError?.details)
						: undefined,
				});
			}
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
				feedbackTypeForStage(storeCurrentStage),
				payload.entityType,
				payload.entityId,
				payload.entityIds?.length ? payload.entityIds : undefined,
			),
		onSuccess: (result) => {
			// Feedback starts a review-routed run; bind immediately so cancel/confirm work
			// even before the first WS event arrives.
			if (result?.run_id) {
				const s = useEditorStore.getState();
				s.setCurrentRunId(result.run_id);
				s.setGenerating(true);
				s.setCurrentAgent("review");
				s.setCurrentStage("review");
				s.setProgress(0);
				s.setRecoveryControl(null);
				s.setRecoverySummary(null);
			}
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			const isConflict =
				apiError?.status === 409 || error.message.includes("409");

			if (isConflict) {
				const control = apiError?.response as RecoveryControlRead | undefined;
				if (control?.active_run && control.recovery_summary) {
					const s = useEditorStore.getState();
					s.setRecoveryControl(control);
					s.setRecoverySummary(control.recovery_summary);
					s.setGenerating(control.state === "active");
					if (control.state === "active") {
						// recoverable 时不设 currentRunId，避免「恢复」按钮被短路成「停止」
						s.setCurrentRunId(control.active_run.id);
						s.setCurrentAgent(control.active_run.current_agent);
						s.setProgress(control.active_run.progress);
					}
					const stage = toSimplifiedStage(
						control.recovery_summary.next_stage ??
							control.recovery_summary.current_stage,
					);
					if (stage) s.setCurrentStage(stage);
					toast.info({
						title: "已有任务进行中",
						message: "已恢复当前运行控制，请先确认或停止",
					});
					return;
				}
				toast.info({
					title: "AI 正在思考",
					message: "请等待当前任务完成",
				});
			} else {
				toast.error({
					title: "提交失败",
					message: apiError?.message || error.message || "无法发送反馈，请重试",
				});
			}
		},
	});

	const cancelMutation = useMutation({
		mutationFn: () => {
			const runId =
				storeCurrentRunId ?? storeRecoveryControl?.active_run.id ?? null;
			if (runId === null) {
				throw new Error("没有可取消的运行");
			}
			return runsApi.cancel(runId);
		},
		onSuccess: (result) => {
			if (result?.status === "cancelled") {
				setLastRunStatus("cancelled");
			}
		},
		onSettled: () => {
			useEditorStore.getState().resetRunState();
			useEditorStore.getState().addMessage({
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
			const control = storeRecoveryControl;
			if (!control) {
				throw new Error("没有可恢复的运行");
			}
			return runsApi.resume(control.active_run.id);
		},
		onSuccess: (run) => {
			const control = storeRecoveryControl;
			const s = useEditorStore.getState();
			s.setGenerating(true);
			s.setCurrentRunId(run.id);
			s.setCurrentAgent(run.current_agent);
			s.setProgress(run.progress);
			s.setCurrentRunProviderSnapshot(run.provider_snapshot ?? null);
			if (control) {
				const nextStage = toSimplifiedStage(
					control.recovery_summary.next_stage ??
						control.recovery_summary.current_stage,
				);
				if (nextStage) {
					s.setCurrentStage(nextStage);
				}
			}
			s.setRecoveryControl(null);
			s.setRecoverySummary(null);
			s.setRecoveryGate(null);
			setLastRunStatus(null);
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			toast.error({
				title: "恢复失败",
				message:
					apiError?.message || error.message || "无法恢复当前运行，请重试",
			});
		},
	});

	const handleGenerate = async () => {
		if (generateMutation.isPending || hasActiveRun) return;
		const requestToken = generateRequestTokenRef.current + 1;
		generateRequestTokenRef.current = requestToken;
		setLastRunStatus(null);
		useEditorStore.getState().clearMessages();
		useEditorStore.getState().setCurrentStage("plan");
		generateMutation.mutate({
			requestToken,
			skillId: searchParams.get("skill") || project?.skill_id || null,
		});
	};

	const handleFeedback = (content: string) => {
		setLastRunStatus(null);
		// Bind canvas selection → Agent review context (Phase 2 / multi-cell)
		const ids = selectedNodeIds.length > 0
			? selectedNodeIds
			: selectedNodeId
				? [selectedNodeId]
				: [];
		const shotIds = ids
			.filter((id) => id.startsWith("shot:"))
			.map((id) => Number(id.split(":")[1]))
			.filter((n) => Number.isFinite(n));
		const charIds = ids
			.filter((id) => id.startsWith("character:"))
			.map((id) => Number(id.split(":")[1]))
			.filter((n) => Number.isFinite(n));

		let entityType: string | undefined;
		let entityId: number | undefined;
		let entityIds: number[] | undefined;
		let contextLabel = "";

		if (shotIds.length > 0 && charIds.length === 0) {
			entityType = "shot";
			entityId = shotIds[0];
			entityIds = shotIds;
			contextLabel =
				shotIds.length === 1
					? `（格 · 镜头 ${shots.find((s) => s.id === shotIds[0])?.order ?? shotIds[0]}）`
					: `（${shotIds.length} 个分镜格）`;
		} else if (charIds.length > 0 && shotIds.length === 0) {
			entityType = "character";
			entityId = charIds[0];
			entityIds = charIds;
			const char = characters.find((c) => c.id === charIds[0]);
			contextLabel =
				charIds.length === 1
					? char?.name
						? `（角色：${char.name}）`
						: `（角色 #${charIds[0]}）`
					: `（${charIds.length} 个角色）`;
		}

		feedbackMutation.mutate({ content, entityType, entityId, entityIds });
		useEditorStore.getState().addMessage({
			agent: "user",
			role: "user",
			content: contextLabel ? `${content}\n${contextLabel}` : content,
			timestamp: new Date().toISOString(),
		});
	};

	const handleConfirm = (feedback?: string) => {
		const runId = storeCurrentRunId;
		if (runId) {
			// Annotate gate confirm with canvas selection so backend review can scope
			let annotated = feedback?.trim() || "";
			if (annotated && selectedNodeIds.length > 0) {
				const focus = selectedNodeIds
					.map((id) => {
						if (id.startsWith("shot:")) {
							const sid = Number(id.split(":")[1]);
							const shot = shots.find((s) => s.id === sid);
							return `格${shot?.order ?? sid}`;
						}
						if (id.startsWith("character:")) {
							const cid = Number(id.split(":")[1]);
							const char = characters.find((c) => c.id === cid);
							return char?.name || `角色${cid}`;
						}
						return id;
					})
					.join("、");
				annotated = `${annotated}\n（绑定：${focus}）`;
			}
			send({
				type: "confirm",
				data: { run_id: runId, feedback: annotated || feedback },
			});
			if (annotated || feedback) {
				useEditorStore.getState().addMessage({
					agent: "user",
					role: "user",
					content: annotated || feedback || "",
					timestamp: new Date().toISOString(),
				});
			}
		}
	};

	const handleCancel = () => {
		const activeRunId =
			storeCurrentRunId ?? storeRecoveryControl?.active_run.id ?? null;
		if (
			!activeRunId &&
			!storeIsGenerating &&
			storeRecoveryControl?.state !== "active"
		) {
			return;
		}
		generateRequestTokenRef.current += 1;
		cancelMutation.mutate();
	};

	const handleResume = () => {
		if (!storeRecoveryControl) return;
		resumeMutation.mutate();
	};

	// 成片卡「重新合成」：有可恢复运行时走恢复（省钱），否则重新生成。
	// 无依赖数组：每次渲染重订阅，保证闭包始终新鲜。
	useEffect(() => {
		return canvasEvents.on("request-regenerate", () => {
			if (storeRecoveryControl) {
				handleResume();
			} else {
				void handleGenerate();
			}
		});
	});

	useEffect(() => {
		if (!storeIsGenerating) {
			const progress = useEditorStore.getState().progress;
			if (progress === 1) {
				queryClient.invalidateQueries({ queryKey: ["characters", projectId] });
				queryClient.invalidateQueries({ queryKey: ["shots", projectId] });
			}
		}
	}, [storeIsGenerating, projectId, queryClient]);

	// The message feed is the only client-owned server-shaped state left: it is
	// appended from WS events and hydrated once from HTTP. Cache updates from WS
	// already invalidate the project, so no extra timestamp bridge is needed.

	useEffect(() => {
		if (storeAwaitingConfirm && storeRunMode === "manual") {
			setSidebarTab("chat");
			setWorkspaceCollapsed(false);
		}
	}, [storeAwaitingConfirm, storeRunMode]);

	useEffect(() => {
		const autoStart = searchParams.get("autoStart");
		const skillId =
			searchParams.get("skill") || project?.skill_id || null;
		if (
			autoStart === "true" &&
			project &&
			!autoStartTriggered.current &&
			!hasActiveRun
		) {
			const editorStore = useEditorStore.getState();
			autoStartTriggered.current = true;
			// Clear autoStart noise; skill is durable on project
			setSearchParams({}, { replace: true });
			const requestToken = generateRequestTokenRef.current + 1;
			generateRequestTokenRef.current = requestToken;
			setLastRunStatus(null);
			editorStore.clearMessages();
			editorStore.setCurrentStage("plan");
			// quick skill prefers yolo
			if (skillId === "quick-short" || project.creation_mode === "quick") {
				editorStore.setRunMode("yolo");
			}
			generateMutation.mutate({ requestToken, skillId });
		}
	}, [project, searchParams, setSearchParams, generateMutation, hasActiveRun]);

	const selectedWorkflowNode = useMemo(() => {
		if (!project || !selectedNodeId) return null;
		const graph = buildComicWorkflow({
			project,
			characters,
			shots,
			blockingClips: project.blocking_clips,
			isGenerating: storeIsGenerating,
		});
		return graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
	}, [project, characters, shots, selectedNodeId, storeIsGenerating]);

	const handleSelectedNodeIdChange = useCallback((nodeId: string | null) => {
		setSelectedNodeId(nodeId);
		if (nodeId) {
			setSidebarTab("inspector");
			setWorkspaceCollapsed(false);
		}
	}, []);

	const handleSelectedNodeIdsChange = useCallback((nodeIds: string[]) => {
		setSelectedNodeIds(nodeIds);
		if (nodeIds[0]) {
			setSelectedNodeId(nodeIds[0]);
			setSidebarTab("inspector");
			setWorkspaceCollapsed(false);
		} else {
			setSelectedNodeId(null);
		}
	}, []);

	// 只等项目主数据；角色/分镜/消息让各区域自行渐进加载（canvas graph 是响应式构建的）
	const workspaceLoading = projectLoading;
	const isMobileWorkbench = useIsMobileWorkbench();

	const workbenchStatus = useMemo(
		() =>
			deriveWorkbenchStatus({
				isGenerating: storeIsGenerating,
				currentRunId: storeCurrentRunId,
				awaitingConfirm: storeAwaitingConfirm,
				recoveryControl: storeRecoveryControl,
				projectStatus: project?.status,
				projectVideoUrl: project?.video_url,
				blockingClips: project?.blocking_clips,
				lastRunStatus,
			}),
		[
			storeIsGenerating,
			storeCurrentRunId,
			storeAwaitingConfirm,
			storeRecoveryControl,
			project?.status,
			project?.video_url,
			project?.blocking_clips,
			lastRunStatus,
		],
	);


	const handleOpenVersions = () => {
		setVersionTarget(null);
		setVersionOpen(true);
	};

	const handleExportWebtoon = async () => {
		if (exporting) return;
		setExporting(true);
		try {
			const started = await exportApi.triggerWebtoon(projectId);
			const poll = async (exportId: string): Promise<void> => {
				const response = await exportApi.getStatus(projectId, exportId);
				if (response.status === "processing") {
					await new Promise((r) => setTimeout(r, 2000));
					return poll(exportId);
				}
				if (response.status === "completed" && response.download_url) {
					const url = getStaticUrl(response.download_url);
					toast.success({
						title: "导出完成",
						message: "Webtoon 长图已生成",
						duration: 8000,
						actions: url
							? [{ label: "下载", onClick: () => window.open(url, "_blank"), variant: "primary" }]
							: undefined,
					});
					return;
				}
				toast.error({ title: "导出失败", message: "生成失败，请重试" });
			};
			toast.info({ title: "导出中", message: "正在生成 Webtoon 长图", duration: 4000 });
			await poll(started.export_id);
		} catch (error) {
			toast.error({
				title: "导出失败",
				message: error instanceof Error ? error.message : "未知错误",
			});
		} finally {
			setExporting(false);
		}
	};

	if (workspaceLoading) {
		return (
			<div className="page-shell items-center justify-center gap-3 bg-base-100">
				<ArrowPathIcon
					className="h-5 w-5 animate-pulse text-bc-muted"
					aria-hidden="true"
				/>
				<p className="font-mono text-sm text-bc-muted">正在加载项目…</p>
			</div>
		);
	}

	const projectApiError = projectError instanceof ApiError ? projectError : null;
	const projectNotFound = projectApiError?.status === 404;

	// 非 404 的加载失败：独立错误面板 + 持久重试入口（toast 会自动消失）
	if (projectError && !projectNotFound && !project) {
		return (
			<div className="page-shell items-center justify-center bg-base-100">
				<Card className="max-w-sm text-center">
					<h1 className="mb-2 text-xl font-heading font-bold text-pretty">
						无法加载项目
					</h1>
					<p className="mb-4 text-sm text-bc-muted">
						{projectApiError?.message || "项目数据获取失败，请检查网络后重试"}
					</p>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button
							variant="primary"
							onClick={() =>
								queryClient.invalidateQueries({
									queryKey: ["project", projectId],
								})
							}
						>
							<ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
							重试
						</Button>
						<Link to="/">
							<Button variant="ghost">返回首页</Button>
						</Link>
					</div>
				</Card>
			</div>
		);
	}

	if (!project) {
		// 「项目未找到」只留给真 404（或查询确实返回空）
		return (
			<div className="page-shell items-center justify-center bg-base-100">
				<Card className="text-center">
					<h1 className="mb-4 text-xl font-heading font-bold text-pretty">
						项目未找到
					</h1>
					<Link to="/">
						<Button variant="primary">返回首页</Button>
					</Link>
				</Card>
			</div>
		);
	}

	return (
		<div className="page-shell bg-base-100 font-sans" data-shell="director-desk">
			{/* 工作台是全站唯一无 h1 的页面；画布 shape 不再承载标题语义 */}
			<h1 className="sr-only">{project.title || "漫剧工作台"}</h1>
			<a
				href="#workbench-main"
				className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-modal rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-content"
			>
				跳到工作台
			</a>
			<TopBar projectId={projectId} />
			<StagePipeline
				currentStage={storeCurrentStage}
				isGenerating={hasActiveRun}
				progress={storeProgress}
				workbenchStatus={workbenchStatus}
				awaitingConfirm={storeAwaitingConfirm}
				hasRecovery={hasRecovery}
				onGenerate={handleGenerate}
				onResume={handleResume}
				onCancel={handleCancel}
				onToggleChat={() => {
					setSidebarTab("chat");
					setWorkspaceCollapsed(false);
				}}
				generateDisabled={generateMutation.isPending || hasActiveRun}
				onOpenVersions={handleOpenVersions}
				onOpenConsistency={() => setConsistencyOpen(true)}
				onExport={handleExportWebtoon}
				exportBusy={exporting}
			/>

			{/* OiiOii-style: Agent/chat left · canvas right；<lg 不挂载 tldraw，改为只读预览 + 侧栏上下分栏 */}
			<main
				id="workbench-main"
				className={
					isMobileWorkbench
						? "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
						: "relative flex min-h-0 flex-1 overflow-hidden"
				}
				aria-label="漫剧工作台"
			>
				{isMobileWorkbench ? (
					<MobileWorkbenchPreview
						projectId={projectId}
						workbenchStatus={workbenchStatus}
						videoUrl={project.video_url}
						shots={shots}
						characters={characters}
						onRetry={hasRecovery ? handleResume : handleGenerate}
						retryDisabled={
							generateMutation.isPending || (hasActiveRun && !hasRecovery)
						}
					/>
				) : null}

				<WorkspaceSidebar
					activeTab={sidebarTab}
					onTabChange={setSidebarTab}
					projectId={projectId}
					selectedNode={selectedWorkflowNode}
					structureLocked={hasActiveRun || storeAwaitingConfirm}
					onSendFeedback={handleFeedback}
					onConfirm={handleConfirm}
					onCancel={handleCancel}
					isGenerating={hasActiveRun}
					collapsed={isMobileWorkbench ? false : workspaceCollapsed}
					onCollapsedChange={setWorkspaceCollapsed}
					selectionLabel={
						selectedNodeIds.length > 1
							? `多选 · ${selectedNodeIds.length} 项`
							: selectedWorkflowNode
								? selectedWorkflowNode.kind === "shot"
									? `格 ${(selectedWorkflowNode as { gridCell?: number }).gridCell ?? selectedWorkflowNode.title} · ${selectedWorkflowNode.title}`
									: `${selectedWorkflowNode.kind} · ${selectedWorkflowNode.title}`
								: null
					}
					selectedNodeIds={selectedNodeIds}
					universeId={project?.universe_id ?? null}
					placement="left"
				/>

				{!isMobileWorkbench ? (
					<div className="relative min-w-0 flex-1 overflow-hidden workbench-canvas-frame">
						<StageView
							projectId={projectId}
							onSelectedNodeIdChange={handleSelectedNodeIdChange}
							onSelectedNodeIdsChange={handleSelectedNodeIdsChange}
						/>
					</div>
				) : null}
			</main>

			{versionOpen && (
				<Suspense fallback={null}>
					<VersionCompareDrawer
						open
						projectId={project.id}
						initialEntityType={versionTarget?.entityType}
						initialEntityId={versionTarget?.entityId ?? null}
						onClose={() => setVersionOpen(false)}
					/>
				</Suspense>
			)}

			{consistencyOpen && (
				<Suspense fallback={null}>
					<ConsistencyPanel
						projectId={project.id}
						onClose={() => setConsistencyOpen(false)}
					/>
				</Suspense>
			)}
		</div>
	);
}
