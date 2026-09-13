import { useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { Button } from "~/components/ui/Button";
import { EmptyState } from "~/components/ui/EmptyState";
import { SvgIcon, type IconName } from "~/components/ui/SvgIcon";
import { assetsApi, getStaticUrl } from "~/services/api";
import type { Asset } from "~/types";
import { toast } from "~/utils/toast";
import { ApiError } from "~/types/errors";
import type { ComicWorkflowNode } from "../graph/types";
import { WorkflowInspector } from "../inspector/WorkflowInspector";
import { UniverseTimelinePanel } from "./UniverseTimelinePanel";

export type WorkspaceSidebarTab = "chat" | "inspector" | "assets" | "universe";

interface WorkspaceSidebarProps {
	activeTab: WorkspaceSidebarTab;
	onTabChange: (tab: WorkspaceSidebarTab) => void;
	projectId: number;
	selectedNode: ComicWorkflowNode | null;
	structureLocked: boolean;
	onSendFeedback: (content: string) => void;
	onConfirm: (feedback?: string) => void;
	onCancel: () => void;
	isGenerating: boolean;
	collapsed?: boolean;
	onCollapsedChange?: (collapsed: boolean) => void;
	/** Optional selection label shown above chat (canvas → Agent binding). */
	selectionLabel?: string | null;
	/** Multi-select node ids from 九宫格 canvas. */
	selectedNodeIds?: string[];
	/** Project IP universe for promote/import actions. */
	universeId?: number | null;
	/** OiiOii-style default: agent chat on the left of canvas. */
	placement?: "left" | "right";
}

const BASE_TABS: Array<{
	key: WorkspaceSidebarTab;
	label: string;
	icon: IconName;
}> = [
	{ key: "chat", label: "对话", icon: "book-open" },
	{ key: "inspector", label: "属性", icon: "layers" },
	{ key: "assets", label: "资产", icon: "archive" },
];

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

function tabId(tab: WorkspaceSidebarTab): string {
	return `workspace-tab-${tab}`;
}

function panelId(tab: WorkspaceSidebarTab): string {
	return `workspace-panel-${tab}`;
}

export function WorkspaceSidebar({
	activeTab,
	onTabChange,
	projectId,
	selectedNode,
	structureLocked,
	onSendFeedback,
	onConfirm,
	onCancel,
	isGenerating,
	collapsed = false,
	onCollapsedChange,
	selectionLabel = null,
	selectedNodeIds = [],
	universeId = null,
	placement = "left",
}: WorkspaceSidebarProps) {
	const TABS = universeId
		? [
				...BASE_TABS,
				{ key: "universe" as const, label: "宇宙", icon: "star" as IconName },
			]
		: BASE_TABS;

	const tabRefs = useRef<Record<WorkspaceSidebarTab, HTMLButtonElement | null>>({
		chat: null,
		inspector: null,
		assets: null,
		universe: null,
	});
	const isLeft = placement === "left";

	const selectTab = (tab: WorkspaceSidebarTab) => {
		onTabChange(tab);
		onCollapsedChange?.(false);
	};

	const focusTab = (tab: WorkspaceSidebarTab) => {
		onTabChange(tab);
		tabRefs.current[tab]?.focus();
	};

	const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const currentIndex = TABS.findIndex((tab) => tab.key === activeTab);
		if (currentIndex < 0) return;

		const keyHandlers: Record<string, () => void> = {
			ArrowRight: () =>
				focusTab(TABS[(currentIndex + 1) % TABS.length].key),
			ArrowDown: () =>
				focusTab(TABS[(currentIndex + 1) % TABS.length].key),
			ArrowLeft: () =>
				focusTab(TABS[(currentIndex - 1 + TABS.length) % TABS.length].key),
			ArrowUp: () =>
				focusTab(TABS[(currentIndex - 1 + TABS.length) % TABS.length].key),
			Home: () => focusTab(TABS[0].key),
			End: () => focusTab(TABS[TABS.length - 1].key),
		};

		const handler = keyHandlers[event.key];
		if (!handler) return;
		event.preventDefault();
		handler();
	};

	return (
		<aside
			className={clsx(
				"z-sticky flex shrink-0 flex-col border-base-content/10 bg-base-100 transition-[width] duration-normal",
				// <lg：参与布局的普通块（与预览区上下分栏），不再是遮住画布的底部浮层；折叠只在 lg+ 生效
				"relative h-[min(58vh,520px)] w-full border-t-2 lg:h-full lg:border-t-0",
				isLeft ? "lg:border-r" : "lg:border-l",
				collapsed
					? "lg:w-sidebar-collapsed"
					: "lg:w-sidebar",
			)}
			aria-label="Agent 工作区"
			data-shell="agent-column"
		>
			<div
				className={clsx(
					"grid gap-0.5 border-b border-base-content/10 p-0.5",
					// <lg 折叠按钮不渲染，占位列只在 lg+ 存在
					collapsed
						? "grid-cols-1"
						: "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_var(--touch-target-dense)]",
				)}
			>
				<div
					className={clsx("grid gap-0.5", collapsed ? "grid-cols-1" : "grid-cols-3")}
					role="tablist"
					aria-label="工作区面板"
					aria-orientation={collapsed ? "vertical" : "horizontal"}
					onKeyDown={handleTabKeyDown}
				>
					{TABS.map((tab) => (
						<button
							key={tab.key}
							type="button"
							ref={(node) => {
								tabRefs.current[tab.key] = node;
							}}
							id={tabId(tab.key)}
							className={clsx(
								"touch-target-dense flex items-center justify-center gap-1 rounded-sm text-2xs font-semibold transition-colors duration-fast",
								activeTab === tab.key
									? "bg-primary text-primary-content"
									: "text-bc-muted hover:bg-base-200",
							)}
							onClick={() => selectTab(tab.key)}
							aria-label={tab.label}
							title={tab.label}
							role="tab"
							aria-selected={activeTab === tab.key}
							aria-controls={panelId(tab.key)}
							tabIndex={activeTab === tab.key ? 0 : -1}
						>
							<SvgIcon name={tab.icon} size={12} />
							<span className={collapsed ? "sr-only" : ""}>{tab.label}</span>
						</button>
					))}
				</div>
				<button
					type="button"
					// <lg 收起后没有任何入口能再展开，因此折叠按钮只在 lg+ 出现
					className="touch-target-dense hidden items-center justify-center rounded-sm text-bc-muted transition-colors duration-fast hover:bg-base-200 lg:flex"
					onClick={() => onCollapsedChange?.(!collapsed)}
					aria-label={collapsed ? "展开工作区" : "收起工作区"}
					title={collapsed ? "展开工作区" : "收起工作区"}
				>
					<SvgIcon
						name="chevron-right"
						size={13}
						className={clsx(
							"transition-transform duration-fast",
							isLeft
								? collapsed
									? ""
									: "rotate-180"
								: collapsed
									? "rotate-180"
									: "",
						)}
					/>
				</button>
			</div>

			<div
				id={panelId(activeTab)}
				className={clsx("min-h-0 flex-1 overflow-hidden", collapsed && "hidden")}
				role="tabpanel"
				aria-labelledby={tabId(activeTab)}
				tabIndex={0}
			>
				{activeTab === "chat" ? (
					<div className="flex h-full min-h-0 flex-col">
						{selectionLabel ? (
							<div className="shrink-0 border-b border-accent/25 bg-accent/10 px-2 py-1">
								<p className="m-0 truncate text-2xs font-bold text-accent">
									<span className="font-mono font-normal text-bc-muted">
										绑定 ·{" "}
									</span>
									{selectionLabel}
								</p>
							</div>
						) : null}
						<div className="min-h-0 flex-1 overscroll-contain">
							<ChatPanel
								onSendFeedback={onSendFeedback}
								onConfirm={onConfirm}
								onCancel={onCancel}
								isGenerating={isGenerating}
							/>
						</div>
					</div>
				) : null}
				{activeTab === "inspector" ? (
					<WorkflowInspector
						projectId={projectId}
						selectedNode={selectedNode}
						selectedNodeIds={selectedNodeIds}
						structureLocked={structureLocked}
						universeId={universeId}
					/>
				) : null}
				{activeTab === "assets" ? (
					<AssetsPanel projectId={projectId} active={activeTab === "assets"} />
				) : null}
				{activeTab === "universe" && universeId ? (
					<UniverseTimelinePanel
						universeId={universeId}
						currentProjectId={projectId}
					/>
				) : null}
			</div>
		</aside>
	);
}

function AssetsPanel({ projectId, active }: { projectId: number; active: boolean }) {
	const queryClient = useQueryClient();
	const [assetType, setAssetType] = useState<"all" | "character" | "scene">("all");
	const [search, setSearch] = useState("");
	const filterType = assetType === "all" ? undefined : assetType;

	const { data, isLoading } = useQuery({
		queryKey: ["assets", filterType, search],
		queryFn: () => assetsApi.list({ assetType: filterType, search: search || undefined }),
		enabled: active,
	});

	const useAssetMutation = useMutation({
		mutationFn: (asset: Asset) => assetsApi.useInProject(asset.id, projectId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["characters", projectId] });
			queryClient.invalidateQueries({ queryKey: ["shots", projectId] });
			toast.success({ title: "资产库", message: "已添加到当前项目" });
		},
		onError: (error) =>
			toast.error({
				title: "资产库",
				message: errorMessage(error, "添加失败"),
			}),
	});

	const deleteAssetMutation = useMutation({
		mutationFn: (id: number) => assetsApi.delete(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["assets"] });
			toast.success({ title: "资产库", message: "已删除" });
		},
		onError: (error) =>
			toast.error({
				title: "资产库",
				message: errorMessage(error, "删除失败"),
			}),
	});

	const items = data?.items ?? [];

	return (
		<div className="flex h-full min-h-0 flex-col" data-shell="asset-panel">
			<div className="border-b border-base-content/10 px-2 py-1.5">
				<div className="mb-1.5 flex items-center justify-between gap-2">
					<div className="min-w-0">
						<p className="m-0 font-mono text-2xs uppercase tracking-wide text-bc-muted">
							assets
						</p>
						<h2 className="m-0 font-heading text-sm font-bold">
							资产库
						</h2>
					</div>
					<span className="rounded-full border border-base-content/10 bg-base-200 px-2 py-0.5 font-mono text-2xs tabular-nums text-bc-muted">
						{data?.total ?? 0}
					</span>
				</div>
				<input
					id="workspace-asset-search"
					name="assetSearch"
					className="input input-bordered input-sm h-8 min-h-8 w-full bg-base-100 text-xs"
					placeholder="搜索资产"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<div className="mt-1.5 grid grid-cols-3 gap-0.5">
					{(["all", "character", "scene"] as const).map((type) => (
						<button
							key={type}
							type="button"
							className={clsx(
								"touch-target-dense h-8 min-h-8 rounded-sm text-2xs font-semibold transition-colors duration-fast",
								assetType === type
									? "bg-primary text-primary-content"
									: "bg-base-200 text-bc-muted hover:bg-base-300",
							)}
							onClick={() => setAssetType(type)}
						>
							{assetTypeLabel(type)}
						</button>
					))}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
				{isLoading ? (
					<div className="flex h-28 items-center justify-center">
						<span className="loading loading-spinner loading-sm text-primary" aria-label="加载中" />
					</div>
				) : items.length === 0 ? (
					<EmptyState
						compact
						icon={<SvgIcon name="archive" size={22} />}
						title="暂无资产"
						description="生成角色/场景后会出现在这里"
					/>
				) : (
					<div className="grid grid-cols-2 gap-1.5">
						{items.map((asset) => (
							<AssetTile
								key={asset.id}
								asset={asset}
								onUse={() => useAssetMutation.mutate(asset)}
								onDelete={() => deleteAssetMutation.mutate(asset.id)}
								busy={useAssetMutation.isPending || deleteAssetMutation.isPending}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function AssetTile({
	asset,
	busy,
	onUse,
	onDelete,
}: {
	asset: Asset;
	busy: boolean;
	onUse: () => void;
	onDelete: () => void;
}) {
	const imageUrl = getStaticUrl(asset.image_url);
	return (
		<div className="overflow-hidden rounded-md border-2 border-base-content/10 bg-base-100 shadow-brutal-sm">
			<div className="aspect-[4/3] bg-base-200">
				{imageUrl ? (
					<img
						src={imageUrl}
						alt={asset.name}
						className="h-full w-full object-cover"
						loading="lazy"
					/>
				) : (
					<div className="flex h-full items-center justify-center text-base-content/25">
						<SvgIcon name="image" size={20} />
					</div>
				)}
			</div>
			<div className="p-1.5">
				<div className="flex items-center gap-1">
					<span className="rounded-full border border-base-content/10 bg-base-200 px-1.5 py-px font-mono text-2xs font-bold text-bc-muted">
						{asset.asset_type === "character" ? "角色" : "场景"}
					</span>
					<h3 className="m-0 min-w-0 flex-1 truncate font-heading text-2xs font-bold">
						{asset.name}
					</h3>
				</div>
				<div className="mt-1.5 flex justify-end gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className="!h-7 !min-h-7 gap-1 !px-1.5 text-2xs"
						disabled={busy}
						onClick={onUse}
					>
						<SvgIcon name="plus" size={11} />
						使用
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="!h-7 !min-h-7 !px-1.5 text-error"
						disabled={busy}
						onClick={onDelete}
						aria-label="删除资产"
					>
						<SvgIcon name="trash-2" size={11} />
					</Button>
				</div>
			</div>
		</div>
	);
}

function assetTypeLabel(type: "all" | "character" | "scene"): string {
	if (type === "all") return "全部";
	if (type === "character") return "角色";
	return "场景";
}
