import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/Button";
import { EmptyState } from "~/components/ui/EmptyState";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import {
	assetsApi,
	charactersApi,
	getStaticUrl,
	projectsApi,
	shotsApi,
	universesApi,
} from "~/services/api";
import { useEditorStore } from "~/stores/editorStore";
import type {
	Character,
	CharacterUpdatePayload,
	Project,
	Shot,
	ShotUpdatePayload,
} from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";
import type { ComicWorkflowNode } from "../graph/types";

type InspectorTab = "overview" | "content" | "actions";

interface WorkflowInspectorProps {
	projectId: number;
	selectedNode: ComicWorkflowNode | null;
	selectedNodeIds?: string[];
	structureLocked: boolean;
	universeId?: number | null;
}

const TAB_LABELS: Record<InspectorTab, string> = {
	overview: "概览",
	content: "内容",
	actions: "操作",
};

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

export function WorkflowInspector({
	projectId,
	selectedNode,
	selectedNodeIds = [],
	structureLocked,
	universeId = null,
}: WorkflowInspectorProps) {
	const [activeTab, setActiveTab] = useState<InspectorTab>("overview");

	useEffect(() => {
		setActiveTab("overview");
	}, [selectedNode?.id]);

	const multiShotIds = selectedNodeIds
		.filter((id) => id.startsWith("shot:"))
		.map((id) => Number(id.split(":")[1]))
		.filter((n) => Number.isFinite(n));

	if (!selectedNode && multiShotIds.length === 0) {
		return (
			<EmptyState
				compact
				icon={<SvgIcon name="layers" size={22} />}
				title="选择画布卡片"
				description="可多选分镜格 · 批量重做本格"
				className="h-full"
			/>
		);
	}

	if (!selectedNode && multiShotIds.length > 0) {
		return (
			<MultiShotActions
				projectId={projectId}
				shotIds={multiShotIds}
				structureLocked={structureLocked}
			/>
		);
	}

	if (!selectedNode) return null;

	return (
		<div className="flex h-full min-h-0 flex-col bg-base-100" data-shell="inspector">
			<div className="border-b border-base-content/10 px-2 py-1.5">
				<p className="m-0 font-mono text-2xs uppercase text-bc-muted">
					{selectedNode.kind}
				</p>
				<h2 className="m-0 truncate font-heading text-sm font-bold">
					{selectedNode.title}
				</h2>
				<p className="m-0 truncate text-2xs text-bc-muted">
					{selectedNode.subtitle}
				</p>
			</div>

			<div className="flex gap-0.5 border-b border-base-content/10 p-0.5">
				{(Object.keys(TAB_LABELS) as InspectorTab[]).map((tab) => (
					<button
						key={tab}
						type="button"
						className={`touch-target-dense flex-1 rounded-sm text-2xs font-semibold transition-colors duration-fast ${
							activeTab === tab
								? "bg-primary text-primary-content"
								: "text-bc-muted hover:bg-base-200"
						}`}
						onClick={() => setActiveTab(tab)}
					>
						{TAB_LABELS[tab]}
					</button>
				))}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
				{activeTab === "overview" ? (
					<OverviewTab node={selectedNode} />
				) : null}
				{activeTab === "content" ? (
					<ContentTab
						projectId={projectId}
						node={selectedNode}
						structureLocked={structureLocked}
					/>
				) : null}
				{activeTab === "actions" ? (
					<ActionsTab
						projectId={projectId}
						node={selectedNode}
						structureLocked={structureLocked}
						universeId={universeId}
						multiShotIds={multiShotIds}
					/>
				) : null}
			</div>
		</div>
	);
}

function OverviewTab({ node }: { node: ComicWorkflowNode }) {
	if (node.kind === "brief") {
		return (
			<FieldList
				items={[
					["标题", node.project.title],
					["风格", node.project.style || "未设置"],
					["目标镜头", node.project.target_shot_count ?? "未设置"],
					["角色", node.metrics.characterCount],
					["镜头", node.metrics.shotCount],
					["总时长", node.metrics.totalDuration ? `${node.metrics.totalDuration}s` : "未定"],
				]}
			/>
		);
	}

	if (node.kind === "character") {
		return (
			<FieldList
				items={[
					["名称", node.character.name],
					["审阅状态", node.character.approval_state],
					["版本", `v${node.character.approval_version}`],
					["一致性特征", node.character.has_embedding ? "已计算" : "未计算"],
				]}
			/>
		);
	}

	if (node.kind === "shot") {
		return (
			<FieldList
				items={[
					["宫格", `格 ${node.gridCell ?? node.shot.order}`],
					["顺序", node.shot.order],
					["场景", node.shot.scene || "未设置"],
					["机位", node.shot.camera || "未设置"],
					["时长", node.shot.duration ? `${node.shot.duration}s` : "未设置"],
					["角色", node.characterNames.join("、") || "未绑定"],
					["审阅状态", node.shot.approval_state],
					["版本", `v${node.shot.approval_version}`],
				]}
			/>
		);
	}

	return (
		<FieldList
			items={[
				["状态", node.subtitle],
				["视频", node.videoUrl ? "已生成" : "未生成"],
				["阻塞镜头", node.blockingClips.length],
			]}
		/>
	);
}

function FieldList({ items }: { items: Array<[string, string | number]> }) {
	return (
		<div className="space-y-1">
			{items.map(([label, value]) => (
				<div
					key={label}
					className="flex items-start justify-between gap-3 border-b border-base-content/10 pb-1.5 text-sm"
				>
					<span className="font-mono text-2xs uppercase text-bc-muted">
						{label}
					</span>
					<span className="min-w-0 text-right text-base-content/75">{value}</span>
				</div>
			))}
		</div>
	);
}

function ContentTab({
	projectId,
	node,
	structureLocked,
}: {
	projectId: number;
	node: ComicWorkflowNode;
	structureLocked: boolean;
}) {
	if (node.kind === "brief") {
		return (
			<ProjectDraftForm
				projectId={projectId}
				project={node.project as Project}
				disabled={structureLocked}
			/>
		);
	}
	if (node.kind === "character") {
		return (
			<CharacterDraftForm character={node.character} disabled={structureLocked} />
		);
	}
	if (node.kind === "shot") {
		return <ShotDraftForm shot={node.shot} disabled={structureLocked} />;
	}
	return (
		<div className="space-y-3 text-sm text-bc-muted">
			<p className="m-0">输出节点不直接编辑内容。</p>
			{node.blockingClips.length > 0 ? (
				<div className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-warning">
					{node.blockingClips.map((clip) => (
						<p key={clip.order} className="m-0">
							镜头 {clip.order}: {clip.reason}
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}

function ProjectDraftForm({
	projectId,
	project,
	disabled,
}: {
	projectId: number;
	project: Project;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState(project.title ?? "");
	const [story, setStory] = useState(project.story ?? "");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setTitle(project.title ?? "");
		setStory(project.story ?? "");
	}, [project.id, project.title, project.story]);

	const handleSave = async () => {
		setSaving(true);
		try {
			const updated = await projectsApi.update(projectId, {
				title: title.trim() || project.title,
				story: story.trim() || null,
			});
			const store = useEditorStore.getState();
			store.patchProject({ id: 0, title: updated.title ?? null, story: updated.story ?? null });
			queryClient.invalidateQueries({ queryKey: ["project", projectId] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success({ title: "Brief", message: "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell disabled={disabled}>
			<TextInput label="标题" value={title} onChange={setTitle} />
			<TextArea label="故事" value={story} onChange={setStory} rows={8} />
			<SaveButton disabled={disabled} loading={saving} onClick={handleSave} />
		</FormShell>
	);
}

function CharacterDraftForm({
	character,
	disabled,
}: {
	character: Character;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<CharacterUpdatePayload>({
		name: character.name,
		description: character.description ?? "",
		visual_notes: character.visual_notes ?? "",
	});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setDraft({
			name: character.name,
			description: character.description ?? "",
			visual_notes: character.visual_notes ?? "",
		});
	}, [character.id, character.name, character.description, character.visual_notes]);

	const handleSave = async () => {
		setSaving(true);
		try {
			const updated = await charactersApi.update(character.id, {
				name: textOrNull(draft.name),
				description: textOrNull(draft.description),
				visual_notes: textOrNull(draft.visual_notes),
			});
			useEditorStore.getState().updateCharacter(updated);
			queryClient.invalidateQueries({ queryKey: ["characters", character.project_id] });
			toast.success({ title: "角色", message: "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell disabled={disabled}>
			<TextInput
				label="名称"
				value={draft.name ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, name: value }))}
			/>
			<TextArea
				label="描述"
				value={draft.description ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, description: value }))
				}
				rows={5}
			/>
			<TextArea
				label="视觉笔记"
				value={draft.visual_notes ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, visual_notes: value }))
				}
				rows={4}
			/>
			<SaveButton disabled={disabled} loading={saving} onClick={handleSave} />
		</FormShell>
	);
}

function ShotDraftForm({ shot, disabled }: { shot: Shot; disabled: boolean }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<ShotUpdatePayload>({
		description: shot.description,
		scene: shot.scene ?? "",
		action: shot.action ?? "",
		dialogue: shot.dialogue ?? "",
		camera: shot.camera ?? "",
		duration: shot.duration,
		image_prompt: shot.image_prompt ?? "",
		prompt: shot.prompt ?? "",
	});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setDraft({
			description: shot.description,
			scene: shot.scene ?? "",
			action: shot.action ?? "",
			dialogue: shot.dialogue ?? "",
			camera: shot.camera ?? "",
			duration: shot.duration,
			image_prompt: shot.image_prompt ?? "",
			prompt: shot.prompt ?? "",
		});
	}, [
		shot.id,
		shot.description,
		shot.scene,
		shot.action,
		shot.dialogue,
		shot.camera,
		shot.duration,
		shot.image_prompt,
		shot.prompt,
	]);

	const handleSave = async () => {
		setSaving(true);
		try {
			const updated = await shotsApi.update(shot.id, {
				description: textOrNull(draft.description),
				scene: textOrNull(draft.scene),
				action: textOrNull(draft.action),
				dialogue: textOrNull(draft.dialogue),
				camera: textOrNull(draft.camera),
				duration: draft.duration ?? null,
				image_prompt: textOrNull(draft.image_prompt),
				prompt: textOrNull(draft.prompt),
			});
			useEditorStore.getState().updateShot(updated);
			queryClient.invalidateQueries({ queryKey: ["shots", shot.project_id] });
			toast.success({ title: "镜头", message: "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell disabled={disabled}>
			<TextArea
				label="描述"
				value={draft.description ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, description: value }))
				}
				rows={4}
			/>
			<TextInput
				label="场景"
				value={draft.scene ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, scene: value }))}
			/>
			<TextInput
				label="动作"
				value={draft.action ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, action: value }))}
			/>
			<TextArea
				label="对白"
				value={draft.dialogue ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, dialogue: value }))
				}
				rows={3}
			/>
			<div className="grid grid-cols-2 gap-2">
				<TextInput
					label="机位"
					value={draft.camera ?? ""}
					onChange={(value) =>
						setDraft((state) => ({ ...state, camera: value }))
					}
				/>
				<NumberInput
					label="时长"
					value={draft.duration ?? null}
					onChange={(value) =>
						setDraft((state) => ({ ...state, duration: value }))
					}
				/>
			</div>
			<TextArea
				label="首帧提示词"
				value={draft.image_prompt ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, image_prompt: value }))
				}
				rows={4}
			/>
			<TextArea
				label="视频提示词"
				value={draft.prompt ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, prompt: value }))}
				rows={4}
			/>
			<SaveButton disabled={disabled} loading={saving} onClick={handleSave} />
		</FormShell>
	);
}

function MultiShotActions({
	projectId,
	shotIds,
	structureLocked,
}: {
	projectId: number;
	shotIds: number[];
	structureLocked: boolean;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<string | null>(null);
	const writeDisabled = structureLocked || Boolean(busy);

	const batchRegen = (type: "image" | "video") =>
		void (async () => {
			setBusy(type);
			try {
				await Promise.all(shotIds.map((id) => shotsApi.regenerate(id, type)));
				queryClient.invalidateQueries({ queryKey: ["shots", projectId] });
				toast.success({
					title: type === "image" ? "批量重做首帧" : "批量重做视频",
					message: `已为 ${shotIds.length} 格启动任务`,
				});
			} catch (error) {
				toast.error({
					title: "批量重做失败",
					message: errorMessage(error, "请重试"),
				});
			} finally {
				setBusy(null);
			}
		})();

	return (
		<div className="flex h-full min-h-0 flex-col bg-base-100 p-2" data-shell="inspector-multi">
			<p className="m-0 font-mono text-2xs uppercase tracking-wide text-bc-muted">
				multi-shot
			</p>
			<h2 className="m-0 font-heading text-sm font-bold">
				已选 {shotIds.length} 格
			</h2>
			<p className="m-0 mt-1 text-2xs text-bc-muted">
				批量只动选中格 · 不改其他分镜
			</p>
			<div className="mt-2 space-y-1.5">
				{structureLocked ? (
					<div className="rounded-md border border-warning/25 bg-warning/10 px-2 py-1.5 text-2xs text-warning">
						生成运行中，批量操作已锁定。
					</div>
				) : null}
				<ActionButton
					icon="refresh-cw"
					label={`重做首帧 · ${shotIds.length} 格`}
					primary
					disabled={writeDisabled}
					loading={busy === "image"}
					onClick={() => batchRegen("image")}
				/>
				<ActionButton
					icon="play"
					label={`重做视频 · ${shotIds.length} 格`}
					disabled={writeDisabled}
					loading={busy === "video"}
					onClick={() => batchRegen("video")}
				/>
			</div>
		</div>
	);
}

function ActionsTab({
	projectId,
	node,
	structureLocked,
	universeId = null,
	multiShotIds = [],
}: {
	projectId: number;
	node: ComicWorkflowNode;
	structureLocked: boolean;
	universeId?: number | null;
	multiShotIds?: number[];
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState<string | null>(null);
	const writeDisabled = structureLocked || Boolean(busy);

	if (multiShotIds.length > 1) {
		return (
			<MultiShotActions
				projectId={projectId}
				shotIds={multiShotIds}
				structureLocked={structureLocked}
			/>
		);
	}

	const invalidateProjectData = () => {
		queryClient.invalidateQueries({ queryKey: ["project", projectId] });
		queryClient.invalidateQueries({ queryKey: ["characters", projectId] });
		queryClient.invalidateQueries({ queryKey: ["shots", projectId] });
		queryClient.invalidateQueries({ queryKey: ["assets"] });
	};

	const runAction = async (key: string, action: () => Promise<void>) => {
		setBusy(key);
		try {
			await action();
			invalidateProjectData();
		} catch (error) {
			toast.error({ title: "操作失败", message: errorMessage(error, "操作失败") });
		} finally {
			setBusy(null);
		}
	};

	if (node.kind === "brief") {
		return (
			<ActionStack>
				<p className="m-0 text-sm text-bc-muted">
					Brief 只在内容页编辑。生成、恢复和停止由对话面板控制。
				</p>
			</ActionStack>
		);
	}

	if (node.kind === "output") {
		const videoUrl = getStaticUrl(node.videoUrl);
		return (
			<ActionStack>
				<ActionButton
					icon="play"
					label="预览成片"
					disabled={!videoUrl}
					onClick={() => {
						if (!videoUrl) return;
						canvasEvents.emit("preview-video", {
							src: videoUrl,
							title: "最终成片",
						});
					}}
				/>
				<p className="m-0 text-xs text-bc-muted">
					输出节点状态由镜头和合成结果决定，不在画布里手动改写。
				</p>
			</ActionStack>
		);
	}

	const entityType = node.kind === "character" ? "character" : "shot";
	const entityId = node.entityId;

	const approve = () =>
		runAction("approve", async () => {
			if (node.kind === "character") {
				const updated = await charactersApi.approve(entityId);
				useEditorStore.getState().updateCharacter(updated);
			} else {
				const updated = await shotsApi.approve(entityId);
				useEditorStore.getState().updateShot(updated);
			}
			toast.success({ title: "审阅", message: "已批准" });
		});

	const regenerate = (type: "image" | "video" = "image") =>
		runAction(type === "image" ? "regenerate" : "regenerate-video", async () => {
			if (node.kind === "character") {
				await charactersApi.regenerate(entityId);
			} else {
				await shotsApi.regenerate(entityId, type);
			}
			const cell =
				node.kind === "shot" ? `格 ${node.gridCell ?? node.shot.order}` : "当前角色";
			toast.success({
				title:
					node.kind === "character"
						? "重新生成当前角色"
						: type === "image"
							? `重做本格 · 首帧（${cell}）`
							: `重做本格 · 视频（${cell}）`,
				message: "任务已启动，仅影响选中实体",
			});
		});

	const addToAssets = () =>
		runAction("asset", async () => {
			if (node.kind === "character") {
				await assetsApi.createFromCharacter(entityId);
			} else {
				await assetsApi.createFromShot(entityId);
			}
			toast.success({ title: "资产库", message: "已保存" });
		});

	const promoteToUniverse = () =>
		runAction("promote", async () => {
			if (!universeId || node.kind !== "character") return;
			await universesApi.promoteCharacter(universeId, entityId);
			queryClient.invalidateQueries({ queryKey: ["universe", universeId] });
			toast.success({
				title: "已提升到宇宙",
				message: "共享角色库已更新，后续章节可沿用",
			});
		});

	const syncToUniverse = () =>
		runAction("sync", async () => {
			if (node.kind !== "character") return;
			await universesApi.syncCharacter(entityId);
			if (universeId) {
				queryClient.invalidateQueries({ queryKey: ["universe", universeId] });
			}
			toast.success({
				title: "已同步回宇宙",
				message: "共享角色圣经版本 +1",
			});
		});

	const deleteNode = () =>
		runAction("delete", async () => {
			const confirmed = window.confirm(deleteMessage(node));
			if (!confirmed) return;
			if (node.kind === "character") {
				await charactersApi.delete(entityId);
				useEditorStore.getState().removeCharacter(entityId);
			} else {
				await shotsApi.delete(entityId);
				useEditorStore.getState().removeShot(entityId);
			}
			toast.success({ title: "删除", message: "已删除" });
		});

	const shotCellLabel =
		node.kind === "shot" ? `格 ${node.gridCell ?? node.shot.order}` : null;

	return (
		<ActionStack>
			{structureLocked ? (
				<div className="rounded-md border border-warning/25 bg-warning/10 px-2 py-1.5 text-2xs text-warning">
					生成运行中，结构写入操作已锁定。
				</div>
			) : null}
			{shotCellLabel ? (
				<div className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1.5 text-2xs leading-relaxed text-bc-muted">
					<strong className="text-accent">{shotCellLabel}</strong>
					{" · "}
					重做只刷新这一格，不影响其他分镜与角色资产。也可在对话里绑定本格发反馈；可多选多格批量重做。
				</div>
			) : null}
			<ActionButton
				icon="check"
				label={node.status === "approved" ? "已批准" : "批准此节点"}
				primary
				disabled={writeDisabled || node.status === "approved"}
				loading={busy === "approve"}
				onClick={approve}
			/>
			{node.kind === "shot" ? (
				<>
					<ActionButton
						icon="refresh-cw"
						label={`重做首帧 · ${shotCellLabel}`}
						disabled={writeDisabled}
						loading={busy === "regenerate"}
						onClick={() => regenerate("image")}
					/>
					<ActionButton
						icon="play"
						label={`重做视频 · ${shotCellLabel}`}
						disabled={writeDisabled}
						loading={busy === "regenerate-video"}
						onClick={() => regenerate("video")}
					/>
				</>
			) : (
				<>
					<ActionButton
						icon="refresh-cw"
						label="重新生成当前角色"
						disabled={writeDisabled}
						loading={busy === "regenerate"}
						onClick={() => regenerate("image")}
					/>
					{universeId ? (
						<>
							<ActionButton
								icon="star"
								label="提升到宇宙共享角色"
								disabled={writeDisabled}
								loading={busy === "promote"}
								onClick={promoteToUniverse}
							/>
							<ActionButton
								icon="refresh-cw"
								label="同步变更回宇宙"
								disabled={writeDisabled}
								loading={busy === "sync"}
								onClick={syncToUniverse}
							/>
						</>
					) : null}
				</>
			)}
			<ActionButton
				icon="archive"
				label="保存到资产库"
				disabled={writeDisabled}
				loading={busy === "asset"}
				onClick={addToAssets}
			/>
			<ActionButton
				icon="clock-3"
				label="版本"
				onClick={() =>
					canvasEvents.emit("version-history", { entityType, entityId })
				}
			/>
			<div className="border-t border-base-content/10 pt-3">
				<ActionButton
					icon="trash-2"
					label="删除"
					danger
					disabled={writeDisabled}
					loading={busy === "delete"}
					onClick={deleteNode}
				/>
			</div>
		</ActionStack>
	);
}

function deleteMessage(node: ComicWorkflowNode): string {
	if (node.kind === "character") {
		return "确定删除这个角色吗？引用它的镜头会失去角色关联。";
	}
	if (node.kind === "shot") {
		return "确定删除这个镜头吗？镜头顺序和最终合成需要重新确认。";
	}
	return "确定删除吗？";
}

function ActionStack({ children }: { children: ReactNode }) {
	return <div className="space-y-1.5">{children}</div>;
}

function ActionButton({
	icon,
	label,
	disabled,
	loading,
	danger,
	primary,
	onClick,
}: {
	icon: Parameters<typeof SvgIcon>[0]["name"];
	label: string;
	disabled?: boolean;
	loading?: boolean;
	danger?: boolean;
	primary?: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			variant={danger ? "error" : primary ? "primary" : "ghost"}
			size="sm"
			className={`w-full justify-start gap-1.5 !h-8 !min-h-8 text-xs ${danger ? "text-error" : ""}`}
			disabled={disabled}
			loading={loading}
			onClick={onClick}
		>
			<SvgIcon name={icon} size={13} />
			{label}
		</Button>
	);
}

function FormShell({
	disabled,
	children,
}: {
	disabled: boolean;
	children: ReactNode;
}) {
	return (
		<fieldset className="space-y-3" disabled={disabled}>
			{disabled ? (
				<div className="rounded-md border border-warning/25 bg-warning/10 px-2 py-1.5 text-2xs text-warning">
					生成运行中，保存操作已锁定。
				</div>
			) : null}
			{children}
		</fieldset>
	);
}

function TextInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-bc-muted">
				{label}
			</span>
			<input
				className="input input-bordered input-sm w-full bg-base-100"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

function NumberInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number | null;
	onChange: (value: number | null) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-bc-muted">
				{label}
			</span>
			<input
				type="number"
				min="0"
				step="1"
				className="input input-bordered input-sm w-full bg-base-100"
				value={value ?? ""}
				onChange={(event) =>
					onChange(event.target.value ? Number(event.target.value) : null)
				}
			/>
		</label>
	);
}

function TextArea({
	label,
	value,
	rows,
	onChange,
}: {
	label: string;
	value: string;
	rows: number;
	onChange: (value: string) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-bc-muted">
				{label}
			</span>
			<textarea
				className="textarea textarea-bordered w-full resize-none bg-base-100 text-sm"
				rows={rows}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

function SaveButton({
	disabled,
	loading,
	onClick,
}: {
	disabled: boolean;
	loading: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			variant="primary"
			size="sm"
			className="w-full"
			disabled={disabled}
			loading={loading}
			onClick={onClick}
		>
			保存
		</Button>
	);
}

function textOrNull(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}
