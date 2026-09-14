import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Tldraw,
	track,
	useEditor,
	type Editor,
	type TLComponents,
} from "tldraw";
import "tldraw/tldraw.css";
import { ImagePreviewModal, VideoPreviewModal } from "~/components/canvas/PreviewModals";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { projectQueryKeys } from "~/query/queryKeys";
import { projectsApi } from "~/services/api";
import { useEditorStore, useShallow } from "~/stores/editorStore";
import { useThemeStore } from "~/stores/themeStore";
import { toast } from "~/utils/toast";
import type { ComicWorkflowGraph } from "../graph/types";
import { buildComicWorkflow } from "../graph/buildComicWorkflow";
import { layoutComicWorkflow } from "../graph/layoutComicWorkflow";
import { ComicCanvasToolbar } from "./toolbar/ComicCanvasToolbar";
import { workflowShapeUtils } from "./shapes/WorkflowShapeUtils";
import {
	hasStaleWorkflowProjection,
	isProjectedWorkflowShape,
	nodeIdFromShape,
	syncTldrawProjection,
	type WorkflowInteractionMode,
} from "./syncTldrawProjection";

interface ComicWorkflowCanvasProps {
	projectId: number;
	onSelectedNodeIdChange?: (nodeId: string | null) => void;
	/** Multi-select 九宫格 / cast binding (ordered, primary first). */
	onSelectedNodeIdsChange?: (nodeIds: string[]) => void;
}

const components: TLComponents = {
	PageMenu: null,
	MainMenu: null,
	Toolbar: null,
	StylePanel: null,
	HelpMenu: null,
	DebugPanel: null,
	DebugMenu: null,
	MenuPanel: null,
	TopPanel: null,
	SharePanel: null,
	ActionsMenu: null,
	QuickActions: null,
	KeyboardShortcutsDialog: null,
	HelperButtons: null,
	ZoomMenu: null,
	ContextMenu: null,
};

export function ComicWorkflowCanvas({
	projectId,
	onSelectedNodeIdChange,
	onSelectedNodeIdsChange,
}: ComicWorkflowCanvasProps) {
	const editorRef = useRef<Editor | null>(null);
	const [isInitialized, setIsInitialized] = useState(false);
	const [previewImage, setPreviewImage] = useState<{
		src: string;
		alt: string;
	} | null>(null);
	const [previewVideo, setPreviewVideo] = useState<{
		src: string;
		title: string;
	} | null>(null);

	const { isGenerating, awaitingConfirm, currentRunId, blockingClips } = useEditorStore(
		useShallow((state) => ({
			isGenerating: state.isGenerating,
			awaitingConfirm: state.awaitingConfirm,
			currentRunId: state.currentRunId,
			blockingClips: state.blockingClips,
		})),
	);

	const { data: project, isLoading: projectLoading } = useQuery({
		queryKey: projectQueryKeys.project(projectId),
		queryFn: () => projectsApi.get(projectId),
		enabled: projectId > 0,
	});
	const { data: characters = [], isLoading: charactersLoading } = useQuery({
		queryKey: projectQueryKeys.characters(projectId),
		queryFn: () => projectsApi.getCharacters(projectId),
		enabled: projectId > 0,
	});
	const { data: shots = [], isLoading: shotsLoading } = useQuery({
		queryKey: projectQueryKeys.shots(projectId),
		queryFn: () => projectsApi.getShots(projectId),
		enabled: projectId > 0,
	});

	const graph = useMemo<ComicWorkflowGraph | null>(() => {
		if (!project) return null;
		return buildComicWorkflow({
			project,
			characters,
			shots,
			blockingClips,
			isGenerating,
		});
	}, [project, characters, shots, blockingClips, isGenerating]);

	const layout = useMemo(
		() => (graph ? layoutComicWorkflow(graph) : null),
		[graph],
	);
	const graphSignature = useMemo(
		() => (graph && layout ? JSON.stringify({ graph, layout }) : ""),
		[graph, layout],
	);
	const lastSignatureRef = useRef<string>("");
	const structureLocked = isGenerating || awaitingConfirm || Boolean(currentRunId);
	const [sortMode, setSortMode] = useState(false);
	const interactionMode: WorkflowInteractionMode = structureLocked
		? "locked"
		: sortMode
			? "sort"
			: "layout";

	useEffect(() => {
		if (structureLocked && sortMode) setSortMode(false);
	}, [structureLocked, sortMode]);

	useEffect(() => {
		const unsubscribers = [
			canvasEvents.on("preview-image", setPreviewImage),
			canvasEvents.on("preview-video", setPreviewVideo),
			canvasEvents.on("select-workflow-node", ({ nodeId }) => {
				onSelectedNodeIdChange?.(nodeId);
				onSelectedNodeIdsChange?.(nodeId ? [nodeId] : []);
			}),
		];
		return () => {
			unsubscribers.forEach((unsubscribe) => unsubscribe());
		};
	}, [onSelectedNodeIdChange, onSelectedNodeIdsChange]);

	const syncProjection = useCallback(
		(forceLayout = false) => {
			const editor = editorRef.current;
			if (!editor || !graph || !layout) return;
			syncTldrawProjection({
				editor,
				graph,
				layout,
				interactionMode,
				forceLayout,
			});
			lastSignatureRef.current = `${graphSignature}:${interactionMode}`;
		},
		[graph, graphSignature, interactionMode, layout],
	);

	const handleMount = useCallback(
		(editor: Editor) => {
			editorRef.current = editor;
			editor.user.updateUserPreferences({
				colorScheme: useThemeStore.getState().theme.endsWith("dark") ? "dark" : "light",
			});
			if (graph && layout) {
				syncTldrawProjection({ editor, graph, layout, interactionMode });
				lastSignatureRef.current = `${graphSignature}:${interactionMode}`;
				setTimeout(() => {
					editor.zoomToFit({ animation: { duration: 300 } });
				}, 100);
			}
			setIsInitialized(true);
		},
		[graph, graphSignature, interactionMode, layout],
	);

	const theme = useThemeStore((s) => s.theme);
	useEffect(() => {
		editorRef.current?.user.updateUserPreferences({
			colorScheme: theme.endsWith("dark") ? "dark" : "light",
		});
	}, [theme]);

	useEffect(() => {
		if (!isInitialized || !graph || !layout) return;
		const syncKey = `${graphSignature}:${interactionMode}`;
		if (lastSignatureRef.current === syncKey) return;
		syncProjection(false);
	}, [graph, graphSignature, interactionMode, isInitialized, layout, syncProjection]);

	const handleResetLayout = useCallback(() => {
		syncProjection(true);
		const editor = editorRef.current;
		if (editor) {
			setTimeout(() => {
				editor.zoomToFit({ animation: { duration: 260 } });
			}, 80);
		}
	}, [syncProjection]);

	if (projectLoading || charactersLoading || shotsLoading || !graph || !layout) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-base-100 text-sm text-bc-muted">
				正在加载工作流...
			</div>
		);
	}

	return (
		<>
			<div className="infinite-canvas-container relative h-full w-full">
				<Tldraw
					shapeUtils={workflowShapeUtils}
					components={components}
					onMount={handleMount}
					persistenceKey={`openoii-comic-workflow-v1-project-${projectId}`}
				>
					<SelectionBridge
						graph={graph}
						onSelectedNodeIdChange={onSelectedNodeIdChange}
						onSelectedNodeIdsChange={onSelectedNodeIdsChange}
					/>
					<ProjectionSyncBridge
						graph={graph}
						layout={layout}
						interactionMode={interactionMode}
					/>
					{sortMode ? (
						<ShotSortBridge
							projectId={projectId}
							graph={graph}
							onSorted={() => {
								setSortMode(false);
								syncProjection(true);
							}}
						/>
					) : null}
					<ComicCanvasToolbar
						projectId={projectId}
						onResetLayout={handleResetLayout}
						sortMode={sortMode}
						sortDisabled={structureLocked}
						onToggleSortMode={() => setSortMode((v) => !v)}
						fillDisabled={structureLocked}
					/>
				</Tldraw>
			</div>

			{previewImage ? (
				<ImagePreviewModal
					src={previewImage.src}
					alt={previewImage.alt}
					onClose={() => setPreviewImage(null)}
				/>
			) : null}

			{previewVideo ? (
				<VideoPreviewModal
					src={previewVideo.src}
					title={previewVideo.title}
					onClose={() => setPreviewVideo(null)}
				/>
			) : null}
		</>
	);
}

const SelectionBridge = track(function SelectionBridge({
	graph,
	onSelectedNodeIdChange,
	onSelectedNodeIdsChange,
}: {
	graph: ComicWorkflowGraph;
	onSelectedNodeIdChange?: (nodeId: string | null) => void;
	onSelectedNodeIdsChange?: (nodeIds: string[]) => void;
}) {
	const editor = useEditor();
	const selectedIds = editor.getSelectedShapeIds();
	const selectedNodeIds = useMemo(() => {
		const ids: string[] = [];
		for (const shapeId of selectedIds) {
			const shape = editor.getShape(shapeId);
			const nodeId = nodeIdFromShape(shape);
			if (!nodeId) continue;
			if (graph.nodes.some((node) => node.id === nodeId)) ids.push(nodeId);
		}
		return ids;
	}, [editor, graph.nodes, selectedIds]);

	useEffect(() => {
		onSelectedNodeIdsChange?.(selectedNodeIds);
		onSelectedNodeIdChange?.(selectedNodeIds[0] ?? null);
	}, [onSelectedNodeIdChange, onSelectedNodeIdsChange, selectedNodeIds]);

	return null;
});

/** After free-drag in sort mode, persist shot order by visual reading order. */
const ShotSortBridge = track(function ShotSortBridge({
	projectId,
	graph,
	onSorted,
}: {
	projectId: number;
	graph: ComicWorkflowGraph;
	onSorted: () => void;
}) {
	const editor = useEditor();
	const queryClient = useQueryClient();
	const settling = useRef(false);
	const timerRef = useRef<number | null>(null);

	useEffect(() => {
		const scheduleReorder = () => {
			if (settling.current) return;
			if (timerRef.current) window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => {
				if (settling.current) return;
				const path = editor.getPath();
				if (path.includes("translating") || path.includes("pointing")) return;

				const shotShapes = editor
					.getCurrentPageShapes()
					.filter((shape) => Boolean(nodeIdFromShape(shape)?.startsWith("shot:")))
					.map((shape) => {
						const nodeId = nodeIdFromShape(shape)!;
						const entityId = Number(nodeId.split(":")[1]);
						return { entityId, x: shape.x, y: shape.y };
					})
					.filter((item) => Number.isFinite(item.entityId));

				if (shotShapes.length < 2) return;
				const ordered = [...shotShapes].sort((a, b) => {
					const rowA = Math.round(a.y / 48);
					const rowB = Math.round(b.y / 48);
					if (rowA !== rowB) return rowA - rowB;
					return a.x - b.x;
				});
				const items = ordered.map((item, index) => ({
					shot_id: item.entityId,
					order: index + 1,
				}));
				const currentOrders = graph.nodes
					.filter((n) => n.kind === "shot" && n.entityId != null)
					.map((n) => ({
						shot_id: n.entityId as number,
						order: n.kind === "shot" ? n.shot.order : 0,
					}))
					.sort((a, b) => a.order - b.order);
				const same =
					currentOrders.length === items.length &&
					currentOrders.every((c, i) => c.shot_id === items[i].shot_id);
				if (same) return;

				settling.current = true;
				projectsApi
					.reorderShots(projectId, items)
					.then(() => {
						queryClient.invalidateQueries({ queryKey: projectQueryKeys.shots(projectId) });
						toast.success({
							title: "九宫格已重排",
							message: `已按阅读顺序更新 ${items.length} 格`,
						});
						onSorted();
					})
					.catch((error: Error) => {
						toast.error({ title: "重排失败", message: error.message || "请重试" });
					})
					.finally(() => {
						settling.current = false;
					});
			}, 320);
		};

		const unsub = editor.store.listen(scheduleReorder, {
			source: "user",
			scope: "document",
		});
		return () => {
			unsub();
			if (timerRef.current) window.clearTimeout(timerRef.current);
		};
	}, [editor, graph.nodes, onSorted, projectId, queryClient]);

	return null;
});

const ProjectionSyncBridge = track(function ProjectionSyncBridge({
	graph,
	layout,
	interactionMode,
}: {
	graph: ComicWorkflowGraph;
	layout: NonNullable<ReturnType<typeof layoutComicWorkflow>>;
	interactionMode: WorkflowInteractionMode;
}) {
	const editor = useEditor();
	const projectedSignature = editor
		.getCurrentPageShapes()
		.filter(isProjectedWorkflowShape)
		.map((shape) => `${shape.id}:${shape.type}:${shape.x}:${shape.y}`)
		.join("|");

	useEffect(() => {
		const currentShapes = editor.getCurrentPageShapes();
		if (
			!hasStaleWorkflowProjection({
				graph,
				layout,
				interactionMode,
				currentShapes,
			})
		) return;
		syncTldrawProjection({
			editor,
			graph,
			layout,
			interactionMode,
			forceLayout: false,
		});
	}, [editor, graph, interactionMode, layout, projectedSignature]);

	return null;
});
