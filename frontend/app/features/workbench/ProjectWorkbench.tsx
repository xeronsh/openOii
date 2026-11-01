import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { TopBar } from "~/components/layout/TopBar";
import { StudioControls } from "~/components/layout/StudioControls";
import { Button } from "~/components/ui/Button";
import { ButtonLink } from "~/components/ui/ButtonLink";
import { Card } from "~/components/ui/Card";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { buildComicWorkflow } from "~/features/comic-workflow/graph/buildComicWorkflow";
import { AgentPanel, type AgentPanelTab } from "~/features/comic-workflow/agent/AgentPanel";
import { InboxPanel, type InboxActions } from "~/features/comic-workflow/agent/InboxPanel";
import { AssistantChat } from "~/components/chat/AssistantChat";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { deriveInboxItems } from "~/features/comic-workflow/agent/inboxItems";
import { InspectorPanel } from "~/features/comic-workflow/inspector/InspectorPanel";
import { PromptBar, type PromptChip } from "~/features/workbench/PromptBar";
import { stepForStage } from "~/utils/workflowSteps";
import {
	deriveStudioStatus,
	studioStatusText,
} from "~/features/comic-workflow/state/deriveStudioStatus";
import { RunTimingBar } from "~/features/comic-workflow/agent/RunTimingBar";
import { subscribeTitleBadge, titleBadge, withTitleBadge } from "~/utils/runNotifications";
import { useIsMobileWorkbench } from "~/features/comic-workflow/mobile/useIsMobileWorkbench";
import { usePreloadedComponent } from "~/utils/preloadComponent";
import {
	keyboardLayerChunk,
	loadViewportWorkbenchChunks,
	mobilePreviewChunk,
	prefetchOtherWorkbenchChunk,
} from "~/features/workbench/workbenchChunks";
import { useRunController } from "~/features/run/useRunController";
import { RegenerateDialog } from "~/features/run/RegenerateDialog";
import { ConfirmModal } from "~/components/ui/ConfirmModal";
import { projectQueryKeys } from "~/query/queryKeys";
import { useProjectData } from "~/features/projects/useProjectData";
import { exportApi, getStaticUrl, projectsApi } from "~/services/api";
import { useRunStateSelect } from "~/hooks/useRunState";
import { useEditorStore } from "~/stores/editorStore";
import { readRunState as readRunStateSnapshot, type RunState } from "~/query/runState";
import { AGENT_NAME_MAP, type VersionEntityType } from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";
import { SvgIcon } from "~/components/ui/SvgIcon";
import "~/components/ui/icons/workbenchIcons";

// 本模块一求值就拉当前视口的子 chunk，和项目数据请求并行；数据到时通常已就绪，首帧直接同步渲染。
// 不用顶层 await：它会让 rollup 把共享模块拆成一堆小 chunk
void loadViewportWorkbenchChunks().catch(() => {});
prefetchOtherWorkbenchChunk();

const WorkflowCanvas = lazy(() =>
	import("~/features/comic-workflow/canvas/ComicWorkflowCanvas").then((m) => ({
		default: m.ComicWorkflowCanvas,
	})),
);
const AssetDrawer = lazy(() =>
	import("~/components/panels/AssetDrawer").then((m) => ({ default: m.AssetDrawer })),
);
const VersionCompareDrawer = lazy(() =>
	import("~/components/panels/VersionCompareDrawer").then((m) => ({
		default: m.VersionCompareDrawer,
	})),
);

// 窄于 1280px 时 Agent 面板与检查器互斥：开一个就收另一个，给画布留出空间
const isNarrowStudio = () => typeof window !== "undefined" && window.innerWidth < 1280;

/** Only the fields the shell renders: streamed text (liveStream) stays out; progress snaps to 1% steps. */
function selectWorkbenchRun(state: RunState) {
	return {
		isGenerating: state.isGenerating,
		currentRunId: state.currentRunId,
		currentStage: state.currentStage,
		progress: Math.round(state.progress * 100) / 100,
		awaitingConfirm: state.awaitingConfirm,
		recoveryControl: state.recoveryControl,
		currentStep: state.currentStep,
		recoveryGate: state.recoveryGate,
		awaitingAgent: state.awaitingAgent,
		feedbackReceipt: state.feedbackReceipt,
	};
}

export function ProjectWorkbench({ projectId }: { projectId: number }) {
	const queryClient = useQueryClient();
	const runState = useRunStateSelect(projectId, selectWorkbenchRun, { owner: true });
	const {
		isGenerating: runIsGenerating,
		currentRunId: runCurrentRunId,
		currentStage: runCurrentStage,
		progress: runProgress,
		awaitingConfirm: runAwaitingConfirm,
		recoveryControl: runRecoveryControl,
	} = runState;
	const runModePreference = useEditorStore((s) => s.runMode);
	const hasActiveRun = runIsGenerating || Boolean(runCurrentRunId);
	const hasRecovery = Boolean(runRecoveryControl);
	// 窄于 1440px 默认收起，避免浮层盖住画布；待确认时仍会自动展开
	const [agentCollapsed, setAgentCollapsedState] = useState(
		() => typeof window !== "undefined" && window.innerWidth < 1440,
	);
	const [inspectorOpen, setInspectorOpenState] = useState(
		() => typeof window === "undefined" || window.innerWidth >= 1280,
	);
	const setAgentCollapsed = useCallback((collapsed: boolean) => {
		setAgentCollapsedState(collapsed);
		if (!collapsed && isNarrowStudio()) setInspectorOpenState(false);
	}, []);
	const setInspectorOpen = useCallback((open: boolean) => {
		setInspectorOpenState(open);
		if (open && isNarrowStudio()) setAgentCollapsedState(true);
	}, []);
	const [agentTab, setAgentTab] = useState<AgentPanelTab>("activity");
	const [assetsOpen, setAssetsOpen] = useState(false);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
	const [versionOpen, setVersionOpen] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [versionTarget, setVersionTarget] = useState<{
		entityType: VersionEntityType;
		entityId: number;
	} | null>(null);

	useEffect(() => {
		return canvasEvents.on("version-history", (target) => {
			setVersionTarget(
				target.entityType && target.entityId != null
					? { entityType: target.entityType, entityId: target.entityId }
					: null,
			);
			setVersionOpen(true);
		});
	}, []);


	const { project, characters, shots, projectLoading, projectError } = useProjectData(projectId);
	useEffect(() => {
		setSelectedNodeId(null);
		setSelectedNodeIds([]);
		const editor = useEditorStore.getState();
		editor.setSelectedShot(null);
		editor.setSelectedCharacter(null);
		editor.setHighlightedMessage(null);
	}, [projectId]);

	// 已有产物时「重新生成」先确认；空项目的「开始生成」直接开始
	const hasContent = Boolean(project?.video_url || characters.length > 0 || shots.length > 0);
	const [regenerateOpen, setRegenerateOpen] = useState(false);
	const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
	const { data: regeneratePlan } = useQuery({
		queryKey: projectQueryKeys.regeneratePlan(projectId),
		queryFn: () => projectsApi.getRegeneratePlan(projectId),
		enabled: projectId > 0 && Boolean(project) && hasContent,
	});
	const previousVersion = regeneratePlan?.previous_version ?? null;

	const {
		handleGenerate,
		handleChat,
		handleConfirm,
		handleCancel,
		handleResume,
		generatePending,
		gateDecisionPending,
		lastRunStatus,
		handleRestorePrevious,
		restorePending,
	} = useRunController({
		projectId,
		project,
		characters,
		shots,
		currentRunId: runCurrentRunId,
		isGenerating: runIsGenerating,
		recoveryControl: runRecoveryControl,
		selectedNodeId,
		selectedNodeIds,
		onRequestRegenerate: hasContent ? () => setRegenerateOpen(true) : undefined,
	});
	// 正在跑的就是那次重新生成：上一版成片还能下载
	const regeneratingFromPrevious =
		previousVersion !== null && hasActiveRun && previousVersion.run_id === runCurrentRunId;
	const previousDownloadUrl =
		regeneratingFromPrevious && previousVersion?.video_url ? getStaticUrl(previousVersion.video_url) : null;
	const canRestorePrevious = Boolean(previousVersion?.restorable) && !hasActiveRun && !hasRecovery;

	useEffect(() => {
		if (!runIsGenerating) {
			const progress = readRunStateSnapshot(projectId).progress;
			if (progress === 1) {
				queryClient.invalidateQueries({ queryKey: ["characters", projectId] });
				queryClient.invalidateQueries({ queryKey: ["shots", projectId] });
			}
		}
	}, [runIsGenerating, projectId, queryClient]);



	// 一张图供 Inspector、Brief 回落和 PromptBar chip 共用；选中变化不重建
	const workflowNodes = useMemo(
		() =>
			project
				? buildComicWorkflow({
						project,
						characters,
						shots,
						blockingClips: project.blocking_clips,
						isGenerating: runIsGenerating,
						awaitingConfirm: runAwaitingConfirm,
						currentStep: runState.currentStep,
						target: runState.recoveryControl?.active_run,
					}).nodes
				: [],
		[project, characters, shots, runIsGenerating, runAwaitingConfirm, runState.currentStep, runState.recoveryControl],
	);
	const selectedWorkflowNode = workflowNodes.find((node) => node.id === selectedNodeId) ?? null;
	// Brief 不在画布上（见 layoutComicWorkflow）：未选中任何卡片时，
	// 右栏 Inspector 回落到它，项目级上下文保持可达。
	const briefNode = workflowNodes.find((node) => node.kind === "brief") ?? null;
	// PromptBar 上下文：每个选中对象一个 chip；处于审批门时多一个审批门 chip
	const selectionChips = useMemo<PromptChip[]>(
		() =>
			selectedNodeIds.flatMap((id) => {
				const node = workflowNodes.find((n) => n.id === id);
				if (!node) return [];
				const label =
					node.kind === "shot"
						? `分镜 S${String(node.shot.order).padStart(2, "0")}`
						: node.kind === "character"
							? `角色 ${node.title}`
							: node.kind === "output"
								? "成片"
								: "项目";
				return [{ id, label }];
			}),
		[workflowNodes, selectedNodeIds],
	);
	// 和状态胶囊、审批卡同一套步骤名（「分镜画面 · 待确认」）
	const gateLabel = runAwaitingConfirm
		? (stepForStage(runState.recoveryGate?.current_stage ?? runState.recoveryGate?.stage ?? runState.currentStep)?.label ??
			AGENT_NAME_MAP[runState.awaitingAgent ?? ""] ??
			"当前阶段")
		: null;
	const removeSelection = useCallback(
		(id: string) => {
			canvasEvents.emit("set-workflow-selection", {
				nodeIds: selectedNodeIds.filter((nodeId) => nodeId !== id),
			});
		},
		[selectedNodeIds],
	);

	// 选中目标变化时打开检查器；手动收起后同一选中不再强行弹开
	const selectionKey = selectedNodeIds.length > 0 ? selectedNodeIds.join(",") : (selectedNodeId ?? "");
	useEffect(() => {
		if (selectionKey) setInspectorOpen(true);
	}, [selectionKey, setInspectorOpen]);

	const handleSelectedNodeIdChange = useCallback((nodeId: string | null) => {
		setSelectedNodeId(nodeId);
	}, []);

	const handleSelectedNodeIdsChange = useCallback((nodeIds: string[]) => {
		setSelectedNodeIds(nodeIds);
		if (nodeIds[0]) {
			setSelectedNodeId(nodeIds[0]);
		} else {
			setSelectedNodeId(null);
		}
	}, []);

	// 只等项目主数据；角色/分镜/消息让各区域自行渐进加载（canvas graph 是响应式构建的）
	const workspaceLoading = projectLoading;
	const isMobileWorkbench = useIsMobileWorkbench();
	const MobileWorkbenchPreview = usePreloadedComponent(mobilePreviewChunk, isMobileWorkbench);
	const KeyboardLayer = usePreloadedComponent(keyboardLayerChunk, !isMobileWorkbench);

	const inboxItems = useMemo(
		() =>
			deriveInboxItems({
				awaitingConfirm: runAwaitingConfirm,
				awaitingAgent: runState.awaitingAgent,
				recoveryGate: runState.recoveryGate,
				recoveryControl: runRecoveryControl,
				isGenerating: hasActiveRun,
				projectStatus: project?.status,
				blockingClips: project?.blocking_clips,
				feedbackReceipt: runState.feedbackReceipt,
				characters,
				shots,
			}),
		[
			characters,
			shots,
			runState.feedbackReceipt,
			runAwaitingConfirm,
			runState.awaitingAgent,
			runState.recoveryGate,
			runRecoveryControl,
			hasActiveRun,
			project?.status,
			project?.blocking_clips,
		],
	);

	// 有新的待处理条目就展开面板并切到收件箱；自动确认模式下的审批门会自动通过，不打扰；
	// 清空后回到活动流
	const seenInboxIds = useRef<Set<string>>(new Set());
	useEffect(() => {
		const fresh = inboxItems.filter(
			(item) =>
				!seenInboxIds.current.has(item.id) &&
				!(item.kind === "gate" && runModePreference === "yolo"),
		);
		const hadItems = seenInboxIds.current.size > 0;
		seenInboxIds.current = new Set(inboxItems.map((item) => item.id));
		if (fresh.length > 0) {
			setAgentTab("inbox");
			setAgentCollapsed(false);
		} else if (hadItems && inboxItems.length === 0) {
			// 处理完了就回到活动流
			setAgentTab("activity");
		}
	}, [inboxItems, runModePreference]);

	// 输入框发给助手：桌面端顺手切到「助手」页签，回答就在眼前
	const sendToAssistant = (content: string) => {
		setAgentTab("chat");
		setAgentCollapsed(false);
		return handleChat(content);
	};

	const openInbox = useCallback(() => {
		setAgentTab("inbox");
		setAgentCollapsed(false);
	}, []);

	const inboxActions: InboxActions = {
		onConfirm: handleConfirm,
		onRequestChanges: () => {
			document.querySelector<HTMLTextAreaElement>('[data-shell="prompt-bar"] textarea')?.focus();
		},
		onResume: handleResume,
		onCancel: handleCancel,
		onRetry: hasContent ? () => setRegenerateOpen(true) : handleGenerate,
		onSelectShot: (shotId) => canvasEvents.emit("select-workflow-node", { nodeId: `shot:${shotId}` }),
		onFocusNode: (nodeId) => canvasEvents.emit("focus-workflow-node", { nodeId }),
		retryDisabled: generatePending,
		gatePending: gateDecisionPending,
	};

	const derivedStudioStatus = useMemo(
		() =>
			deriveStudioStatus({
				isGenerating: runIsGenerating,
				currentRunId: runCurrentRunId,
				awaitingConfirm: runAwaitingConfirm,
				recoveryControl: runRecoveryControl,
				projectStatus: project?.status,
				projectVideoUrl: project?.video_url,
				blockingClips: project?.blocking_clips,
				lastRunStatus,
				currentStage: runCurrentStage,
				currentStep: runState.currentStep,
				progress: runProgress,
			}),
		[
			runIsGenerating,
			runCurrentRunId,
			runAwaitingConfirm,
			runRecoveryControl,
			project?.status,
			project?.video_url,
			project?.blocking_clips,
			lastRunStatus,
			runCurrentStage,
			runState.currentStep,
			runProgress,
		],
	);
	// 待处理数只认收件箱条目
	const studioStatus = useMemo(
		() => ({ ...derivedStudioStatus, pendingCount: inboxItems.length }),
		[derivedStudioStatus, inboxItems.length],
	);

	// 标签页标题前缀显示状态，切到别的标签也能看到进度
	// 后台收到「待确认 / 完成 / 失败」时再加【角标】，回到页面即消失
	const projectTitle = project?.title;
	const badge = useSyncExternalStore(subscribeTitleBadge, titleBadge, titleBadge);
	useEffect(() => {
		if (projectTitle === undefined) return;
		const previous = document.title;
		document.title = withTitleBadge(`${studioStatusText(studioStatus)} · ${projectTitle || "漫剧工作台"} - openOii`, badge);
		return () => {
			document.title = previous;
		};
	}, [studioStatus, projectTitle, badge]);


	const handleOpenVersions = () => {
		setVersionTarget(null);
		setVersionOpen(true);
	};

	const handleExportWebtoon = async () => {
		if (exporting) return;
		setExporting(true);
		// 「导出中」一直显示到有结果，再被「导出完成 / 导出失败」替换，两者不叠在一起
		let pending: string | null = null;
		const clearPending = () => {
			if (pending) toast.dismiss(pending);
			pending = null;
		};
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
					clearPending();
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
				clearPending();
				toast.error({ title: "导出失败", message: "生成失败，请重试" });
			};
			pending = toast.info({ title: "导出中", message: "正在生成 Webtoon 长图", duration: 0 });
			await poll(started.export_id);
		} catch (error) {
			clearPending();
			toast.error({
				title: "导出失败",
				message: error instanceof Error ? error.message : "未知错误",
			});
		} finally {
			clearPending();
			setExporting(false);
		}
	};

	if (workspaceLoading) {
		return (
			<div className="page-shell items-center justify-center gap-3 bg-paper-100">
				<SvgIcon name="refresh-cw" size={20} className="animate-pulse text-ink-muted" />
				<p className="text-sm text-ink-muted">正在加载项目…</p>
			</div>
		);
	}

	const projectApiError = projectError instanceof ApiError ? projectError : null;
	const projectNotFound = projectApiError?.status === 404;

	// 非 404 的加载失败：独立错误面板 + 持久重试入口（toast 会自动消失）
	if (projectError && !projectNotFound && !project) {
		return (
			<div className="page-shell items-center justify-center bg-paper-100">
				<Card className="max-w-sm text-center">
					<h1 className="mb-2 text-xl font-bold text-pretty">
						无法加载项目
					</h1>
					<p className="mb-4 text-sm text-ink-muted">
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
							<SvgIcon name="refresh-cw" size={16} />
							重试
						</Button>
						<ButtonLink to="/" variant="ghost">返回首页</ButtonLink>
					</div>
				</Card>
			</div>
		);
	}

	if (!project) {
		// 「项目未找到」只留给真 404（或查询确实返回空）
		return (
			<div className="page-shell items-center justify-center bg-paper-100">
				<Card className="text-center">
					<h1 className="mb-4 text-xl font-bold text-pretty">
						项目未找到
					</h1>
					<ButtonLink to="/" variant="primary">返回首页</ButtonLink>
				</Card>
			</div>
		);
	}

	return (
		<div className="page-shell bg-paper-100 font-sans" data-shell="director-desk">
			{/* 工作台是全站唯一无 h1 的页面；画布 shape 不再承载标题语义 */}
			<h1 className="sr-only">{project.title || "漫剧工作台"}</h1>
			<a
				href="#workbench-main"
				className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-toast rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-content"
			>
				跳到工作台
			</a>
			<a
				href="#chat-message-input"
				onClick={(event) => {
					const input = document.getElementById("chat-message-input");
					if (!input) return;
					event.preventDefault();
					input.focus();
				}}
				className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-toast rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-content"
			>
				跳到输入栏
			</a>
			{!isMobileWorkbench && KeyboardLayer ? <KeyboardLayer projectId={projectId} shots={shots} characters={characters} /> : null}
			<TopBar
				projectId={projectId}
				center={
	<StudioControls
						isGenerating={hasActiveRun}
						studioStatus={studioStatus}
						awaitingConfirm={runAwaitingConfirm}
						hasRecovery={hasRecovery}
						onGenerate={hasContent ? () => setRegenerateOpen(true) : handleGenerate}
						onCancel={handleCancel}
						onOpenInbox={openInbox}
						generateDisabled={generatePending || hasActiveRun}
						generatePending={generatePending}
						onRegenerate={hasContent ? () => setRegenerateOpen(true) : undefined}
						onRestorePrevious={canRestorePrevious ? () => setRestoreConfirmOpen(true) : undefined}
						restoreBusy={restorePending}
						previousDownloadUrl={previousDownloadUrl}
						onOpenVersions={handleOpenVersions}
						onExport={handleExportWebtoon}
						exportBusy={exporting}
						downloadUrl={project?.video_url ? getStaticUrl(`/api/v1/projects/${projectId}/final-video`) : null}
					/>
				}
			/>


			{/* Keep setup focused; the empty workflow canvas appears after a run starts. */}
			<main
				id="workbench-main"
				className={
					isMobileWorkbench
						? "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
						: "relative flex min-h-0 flex-1 overflow-hidden"
				}
				aria-label="漫剧工作台"
			>
				{isMobileWorkbench && MobileWorkbenchPreview ? (
					<MobileWorkbenchPreview
						projectId={projectId}
						studioStatus={studioStatus}
						videoUrl={project.video_url}
						shots={shots}
						characters={characters}
						inbox={
							inboxItems.length > 0 ? (
								<InboxPanel items={inboxItems} actions={inboxActions} />
							) : null
						}
						chat={<AssistantChat projectId={projectId} hideEmpty />}
						activity={<ChatPanel projectId={projectId} isGenerating={hasActiveRun} limit={5} />}
						timing={hasActiveRun ? <RunTimingBar projectId={projectId} inline /> : null}
						primaryAction={
							hasActiveRun && !runAwaitingConfirm ? (
								<Button
									size="sm"
									variant="ghost"
									onClick={handleCancel}
									className="h-8 min-h-8 gap-1 px-2 text-error-fg hover:bg-error/10"
									aria-label="停止生成"
								>
									<SvgIcon name="stop" size={14} /> 停止
								</Button>
							) : null
						}
					/>
				) : null}

				{!isMobileWorkbench ? (
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						<div className="relative isolate min-h-0 flex-1 overflow-hidden workbench-canvas-frame">
							<Suspense
								fallback={
									<div className="flex h-full w-full items-center justify-center bg-paper-100 text-sm text-ink-muted">
										正在加载画布…
									</div>
								}
							>
								<WorkflowCanvas
									key={projectId}
									projectId={projectId}
									onSelectedNodeIdChange={handleSelectedNodeIdChange}
									onSelectedNodeIdsChange={handleSelectedNodeIdsChange}
									onOpenAssets={() => setAssetsOpen(true)}
									fitInsets={{
										left: agentCollapsed ? 0 : 372,
										right: inspectorOpen ? 332 : 0,
									}}
								/>
							</Suspense>
							<AgentPanel
								projectId={projectId}
								onCancel={handleCancel}
								isGenerating={hasActiveRun}
								collapsed={agentCollapsed}
								onCollapsedChange={setAgentCollapsed}
								tab={agentTab}
								onTabChange={setAgentTab}
								inboxItems={inboxItems}
								inboxActions={inboxActions}
							/>
							<InspectorPanel
								projectId={projectId}
								selectedNode={selectedWorkflowNode}
								selectedNodeIds={selectedNodeIds}
								structureLocked={hasActiveRun || runAwaitingConfirm}
								atGate={runAwaitingConfirm}
								universeId={project?.universe_id ?? null}
								briefNode={briefNode}
								open={inspectorOpen}
								onOpenChange={setInspectorOpen}
							/>
							<PromptBar
								floating
								selection={selectionChips}
								onRemoveSelection={removeSelection}
								gateLabel={gateLabel}
								awaitingConfirm={runAwaitingConfirm}
								onSend={sendToAssistant}
								onConfirm={handleConfirm}
							/>
						</div>
					</div>
				) : null}

			</main>

			{isMobileWorkbench ? (
				<PromptBar
					selection={selectionChips}
					gateLabel={gateLabel}
					awaitingConfirm={runAwaitingConfirm}
					onSend={handleChat}
					onConfirm={handleConfirm}
				/>
			) : null}

			{assetsOpen ? (
				<Suspense fallback={null}>
					<AssetDrawer open projectId={projectId} onClose={() => setAssetsOpen(false)} />
				</Suspense>
			) : null}

			<RegenerateDialog
				open={regenerateOpen}
				projectId={projectId}
				pending={generatePending}
				onClose={() => setRegenerateOpen(false)}
				onConfirm={() => {
					handleGenerate();
					setRegenerateOpen(false);
				}}
			/>

			<ConfirmModal
				isOpen={restoreConfirmOpen}
				onClose={() => setRestoreConfirmOpen(false)}
				onConfirm={() => {
					if (previousVersion) handleRestorePrevious(previousVersion.run_id);
					setRestoreConfirmOpen(false);
				}}
				title="恢复上一版？"
				message={`成片、大纲和画布（${previousVersion?.character_count ?? 0} 个角色、${previousVersion?.shot_count ?? 0} 个分镜）会回到这次重新生成之前；重新生成得到的这一版会被替换。`}
				confirmText="恢复上一版"
				variant="warning"
				isLoading={restorePending}
			/>

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
		</div>
	);
}
