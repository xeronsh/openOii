import { MEDIA, imageReady, videoReady } from "~/components/ui/media";
import { useRef, useState } from "react";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { getStaticUrl } from "~/services/api";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import {
	addCharacterReference,
	approveCharacter,
	approveShot,
	computeCharacterEmbedding,
	regenerateCharacter,
	regenerateShot,
	removeCharacterReference,
	saveShotPatch,
} from "./cardActions";
import type {
	ComicWorkflowNode,
	ComicWorkflowSection,
	WorkflowNodeStatus,
} from "../graph/types";

const SECTION_STYLE = {
	brief: {
		accent: "bg-primary",
		surface: "bg-primary/5",
	},
	elements: {
		accent: "bg-primary",
		surface: "bg-primary/5",
	},
	shotline: {
		accent: "bg-info",
		surface: "bg-info/5",
	},
	output: {
		accent: "bg-ink",
		surface: "bg-paper-200/45",
	},
} as const;

const STATUS_COPY: Record<WorkflowNodeStatus, { label: string; cls: string }> = {
	draft: { label: "待生成", cls: "bg-paper-200 text-ink-muted" },
	generating: { label: "生成中", cls: "bg-warning/15 text-warning-fg" },
	review: { label: "待确认", cls: "bg-warning/15 text-warning-fg" },
	unconfirmed: { label: "未确认", cls: "bg-paper-200 text-ink-muted" },
	approved: { label: "已批准", cls: "bg-success/15 text-success-fg" },
	blocked: { label: "阻塞", cls: "bg-error/15 text-error-fg" },
	superseded: { label: "需重合成", cls: "bg-warning/15 text-warning-fg" },
	ready: { label: "可用", cls: "bg-success/15 text-success-fg" },
};

function stopCanvasPointer(e: React.PointerEvent<HTMLElement>) {
	e.stopPropagation();
}

/** 卡内交互控件：阻止冒泡到卡片 onClick（选中节点）与画布手势 */
function stopAll(e: React.SyntheticEvent) {
	e.stopPropagation();
}

/**
 * 就地编辑文本：点击进入编辑，Enter / 失焦保存，Esc 取消。
 * 编辑态是组件本地 state——store 更新只在保存成功后发生，
 * 因此输入过程不会被 graph 投影重建打断。
 */
function InlineEditableText({
	value,
	placeholder,
	displayClassName,
	rows = 2,
	disabled = false,
	ariaLabel,
	save,
}: {
	value: string | null | undefined;
	placeholder: string;
	displayClassName: string;
	rows?: number;
	disabled?: boolean;
	ariaLabel: string;
	save: (next: string) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);

	const commit = async () => {
		const next = draft.trim();
		if (next === (value ?? "").trim()) {
			setEditing(false);
			return;
		}
		setSaving(true);
		const ok = await save(next);
		setSaving(false);
		if (ok) setEditing(false);
	};

	if (!editing) {
		return (
			<button
				type="button"
				disabled={disabled}
				aria-label={`编辑${ariaLabel}`}
				title={disabled ? undefined : "点击编辑"}
				onPointerDown={stopAll}
				onClick={(e) => {
					stopAll(e);
					if (disabled) return;
					setDraft(value ?? "");
					setEditing(true);
				}}
				className={`block w-full cursor-text rounded-sm text-left transition-colors duration-fast hover:bg-ink/5 ${displayClassName}`}
			>
				{value ? (
					value
				) : (
					<span className="italic text-ink-subtle">{placeholder}</span>
				)}
			</button>
		);
	}

	return (
		<textarea
			autoFocus
			rows={rows}
			value={draft}
			disabled={saving}
			aria-label={ariaLabel}
			onPointerDown={stopAll}
			onClick={stopAll}
			onChange={(e) => setDraft(e.target.value)}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					void commit();
				}
				if (e.key === "Escape") setEditing(false);
			}}
			onBlur={() => void commit()}
			className="w-full resize-none rounded-sm border-2 border-primary bg-paper-100 p-1.5 text-xs leading-relaxed text-ink"
		/>
	);
}

/** 待确认卡的动作行：通过 / 重做 直接上卡，不必逐个打开面板 */
function ReviewActions({
	onApprove,
	onRedo,
}: {
	onApprove: () => Promise<boolean>;
	onRedo: () => Promise<boolean>;
}) {
	const [busy, setBusy] = useState<"approve" | "redo" | null>(null);

	const run = async (kind: "approve" | "redo", fn: () => Promise<boolean>) => {
		setBusy(kind);
		await fn();
		setBusy(null);
	};

	return (
		<div className="flex gap-1" onPointerDown={stopAll}>
			<button
				type="button"
				disabled={busy !== null}
				onClick={(e) => {
					stopAll(e);
					void run("approve", onApprove);
				}}
				className="btn-doodle touch-target-dense h-6 min-h-6 flex-1 px-1.5 text-xs bg-success text-success-content"
			>
				{busy === "approve" ? (
					<span className="spinner-doodle h-3 w-3" aria-hidden="true" />
				) : (
					<SvgIcon name="check" size={12} />
				)}
				通过
			</button>
			<button
				type="button"
				disabled={busy !== null}
				onClick={(e) => {
					stopAll(e);
					void run("redo", onRedo);
				}}
				className="btn-doodle touch-target-dense h-6 min-h-6 flex-1 px-1.5 text-xs bg-transparent text-ink hover:bg-paper-200"
			>
				{busy === "redo" ? (
					<span className="spinner-doodle h-3 w-3" aria-hidden="true" />
				) : (
					<SvgIcon name="refresh-cw" size={12} />
				)}
				重做
			</button>
		</div>
	);
}

function statusBadge(status: WorkflowNodeStatus) {
	const copy = STATUS_COPY[status] ?? STATUS_COPY.draft;
	return (
		<span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs font-medium ${copy.cls}`}>
			<span className={`h-2 w-2 rounded-full bg-current ${status === "generating" ? "animate-pulse" : "opacity-60"}`} />
			{copy.label}
		</span>
	);
}

function MediaPreviewButton({
	src,
	title,
	type,
}: {
	src: string | null;
	title: string;
	type: "image" | "video";
}) {
	if (!src) return null;

	return (
		<button
			type="button"
			className="btn-doodle touch-target pointer-events-auto h-12 min-h-12 w-12 bg-paper-100/90 text-ink hover:bg-primary hover:text-primary-content"
			aria-label={type === "image" ? "预览图片" : "预览视频"}
			title={type === "image" ? "预览图片" : "预览视频"}
			onPointerDown={stopCanvasPointer}
			onClick={() => {
				if (type === "image") {
					canvasEvents.emit("preview-image", { src, alt: title });
				} else {
					canvasEvents.emit("preview-video", { src, title });
				}
			}}
		>
			<SvgIcon name={type === "image" ? "image" : "play"} size={16} />
		</button>
	);
}

function EmptyMedia({ label, busy = false }: { label: string; busy?: boolean }) {
	// 生成中：同一套媒体微光占位，告诉用户“图正在来”而不是“没有图”
	return (
		<div
			className={`flex h-full w-full items-center justify-center text-xs text-ink-muted ${busy ? MEDIA : "bg-paper-300"}`}
			data-busy={busy || undefined}
		>
			{busy ? "生成中…" : label}
		</div>
	);
}

/** 参考图管理条：缩略图 + 上传 + 删除 + 特征重算，全部就地完成 */
function CharacterRefStrip({
	node,
}: {
	node: Extract<ComicWorkflowNode, { kind: "character" }>;
}) {
	const fileRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState<"upload" | "embed" | number | null>(null);
	const refs = node.character.reference_images ?? [];
	const projectId = node.character.project_id;

	const upload = async (file: File | undefined) => {
		if (!file) return;
		setBusy("upload");
		await addCharacterReference(node.entityId, projectId, file);
		setBusy(null);
		if (fileRef.current) fileRef.current.value = "";
	};

	return (
		<div className="mt-1.5 flex items-center gap-1" onPointerDown={stopAll}>
			<span className="shrink-0 font-mono text-xs uppercase text-ink-muted">
				参考 {refs.length}
			</span>
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
				{refs.slice(0, 3).map((url, index) => (
					<span key={`${url}-${index}`} className="group relative shrink-0">
						<img
							src={getStaticUrl(url) ?? url}
							alt={`参考图 ${index + 1}`}
							className={`${MEDIA} h-7 w-7 rounded-sm border border-line-strong object-cover`}
							draggable={false}
							{...imageReady}
						/>
						<button
							type="button"
							aria-label={`删除参考图 ${index + 1}`}
							disabled={busy !== null}
							onClick={(e) => {
								stopAll(e);
								setBusy(index);
								void removeCharacterReference(
									node.entityId,
									projectId,
									index,
								).finally(() => setBusy(null));
							}}
							className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-error text-error-content group-hover:flex"
						>
							{busy === index ? (
								<span className="spinner-doodle h-2 w-2" aria-hidden="true" />
							) : (
								<SvgIcon name="x" size={8} />
							)}
						</button>
					</span>
				))}
				<button
					type="button"
					aria-label="上传参考图"
					disabled={busy !== null}
					onClick={(e) => {
						stopAll(e);
						fileRef.current?.click();
					}}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-dashed border-line-strong text-ink-muted transition-colors duration-fast hover:border-primary/50 hover:text-primary"
				>
					{busy === "upload" ? (
						<span className="spinner-doodle h-3 w-3" aria-hidden="true" />
					) : (
						<SvgIcon name="plus" size={12} />
					)}
				</button>
			</div>
			{refs.length > 0 ? (
				<button
					type="button"
					aria-label="重算角色特征"
					title="用当前参考图重算一致性特征"
					disabled={busy !== null}
					onClick={(e) => {
						stopAll(e);
						setBusy("embed");
						void computeCharacterEmbedding(node.entityId).finally(() =>
							setBusy(null),
						);
					}}
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors duration-fast hover:bg-ink/10 hover:text-ink"
				>
					{busy === "embed" ? (
						<span className="spinner-doodle h-3 w-3" aria-hidden="true" />
					) : (
						<SvgIcon name="refresh-cw" size={12} />
					)}
				</button>
			) : null}
			<input
				ref={fileRef}
				type="file"
				accept="image/*"
				className="hidden"
				onChange={(e) => void upload(e.target.files?.[0])}
			/>
		</div>
	);
}

function CharacterCard({
	node,
}: {
	node: Extract<ComicWorkflowNode, { kind: "character" }>;
}) {
	const imageUrl = getStaticUrl(node.imageUrl);
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="relative aspect-[4/3] bg-paper-300">
				{imageUrl ? (
					<img
						src={imageUrl}
						alt={node.title}
						draggable={false}
						decoding="async"
						loading="lazy"
						className={`${MEDIA} h-full w-full object-cover`}
						{...imageReady}
					/>
				) : (
					<EmptyMedia label="等待角色图" busy={node.status === "generating"} />
				)}
				<div className="absolute right-2 top-2">
					<MediaPreviewButton src={imageUrl} title={node.title} type="image" />
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col p-3">
				<CardHeader node={node} icon="star" accentClass="bg-primary" compact />
				{node.character.description ? (
					<p className="m-0 mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
						{node.character.description}
					</p>
				) : null}
				<CharacterRefStrip node={node} />
				<div className="mt-auto flex flex-wrap gap-1 pt-1.5">
					{node.character.has_embedding ? (
							<span className="inline-flex rounded-full border border-primary/30 bg-primary px-1.5 py-0.5 text-xs text-primary-content">资产一致性</span>
					) : null}
					{node.character.visual_notes ? (
							<span className="inline-flex rounded-full border border-line bg-paper-100/90 px-1.5 py-0.5 text-xs text-ink-muted">视觉笔记</span>
					) : null}
				</div>
				{node.status === "review" ? (
					<div className="pt-1.5">
						<ReviewActions
							onApprove={() => approveCharacter(node.entityId)}
							onRedo={() => regenerateCharacter(node.entityId)}
						/>
					</div>
				) : null}
			</div>
		</div>
	);
}

function ShotCard({ node }: { node: Extract<ComicWorkflowNode, { kind: "shot" }> }) {
	const imageUrl = getStaticUrl(node.imageUrl);
	const videoUrl = getStaticUrl(node.videoUrl);
	const previewType = videoUrl ? "video" : "image";
	const previewUrl = videoUrl || imageUrl;
	const isFirstShot = node.shot.order === 1;
	const cell = node.gridCell ?? node.shot.order;
	const editLocked = node.status === "generating";

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="relative h-32 shrink-0 bg-paper-300">
				{imageUrl ? (
					<img
						src={imageUrl}
						alt={node.title}
						draggable={false}
						decoding="async"
						loading={isFirstShot ? "eager" : "lazy"}
						{...(isFirstShot
							? ({ fetchpriority: "high" } as { fetchpriority: "high" })
							: {})}
						className={`${MEDIA} h-full w-full object-cover`}
						{...imageReady}
					/>
				) : (
					<EmptyMedia label="等待分镜图" busy={node.status === "generating"} />
				)}
				{/* 九宫格 cell index */}
				<span className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-sm border border-line-strong bg-info px-1 font-mono text-xs font-bold text-info-content">
					{cell}
				</span>
				<span className="absolute bottom-1.5 left-1.5 inline-flex rounded-full border border-line bg-paper-100/90 px-1.5 py-0.5 text-xs tabular-nums">
					{node.shot.duration ? `${node.shot.duration}s` : "未定时长"}
				</span>
				<div className="absolute right-2 top-2">
					<MediaPreviewButton
						src={previewUrl}
						title={node.title}
						type={previewType}
					/>
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col p-3">
				<CardHeader node={node} icon="clapperboard" accentClass="bg-info" compact />
				<p className="m-0 mt-1 font-mono text-xs uppercase tracking-wide text-ink-muted">
					格 {cell}
				</p>
				<div className="mt-1.5">
					<InlineEditableText
						value={node.shot.description}
						placeholder="添加画面描述"
						ariaLabel={`格 ${cell} 画面描述`}
						rows={3}
						disabled={editLocked}
						displayClassName="line-clamp-3 p-0.5 text-xs leading-relaxed text-ink-muted"
						save={(next) =>
							saveShotPatch(node.entityId, {
								expected_revision: node.shot.revision,
								description: next || null,
							})
						}
					/>
				</div>
				<div className="mt-1">
					<InlineEditableText
						value={node.shot.dialogue}
						placeholder="添加对白"
						ariaLabel={`格 ${cell} 对白`}
						rows={2}
						disabled={editLocked}
						displayClassName="line-clamp-2 p-0.5 text-xs italic text-primary"
						save={(next) =>
							saveShotPatch(node.entityId, {
								expected_revision: node.shot.revision,
								dialogue: next || null,
							})
						}
					/>
				</div>
				<div className="mt-auto flex flex-wrap gap-1 pt-1.5">
					{node.characterNames.length > 0 ? (
						<span className="inline-flex max-w-full truncate rounded-full border border-primary/30 bg-primary px-1.5 py-0.5 text-xs text-primary-content">
							{node.characterNames.join("、")}
						</span>
					) : null}
					{node.shot.camera ? (
						<span className="inline-flex rounded-full border border-line bg-paper-100/80 px-1.5 py-0.5 text-xs text-ink-muted">{node.shot.camera}</span>
					) : null}
				</div>
				{node.status === "review" ? (
					<div className="pt-1.5">
						<ReviewActions
							onApprove={() => approveShot(node.entityId)}
							onRedo={() => regenerateShot(node.entityId)}
						/>
					</div>
				) : null}
			</div>
		</div>
	);
}

function OutputCard({
	node,
}: {
	node: Extract<ComicWorkflowNode, { kind: "output" }>;
}) {
	const videoUrl = getStaticUrl(node.videoUrl);
	const statusText = outputStateLabel(node.outputState);
	const needsRecompose =
		node.outputState === "needs_recompose" || node.outputState === "blocked";

	return (
		<div className="flex h-full flex-col p-4">
			<CardHeader node={node} icon="play-circle" accentClass="bg-primary" />

			{/* 内联播放器：交付台上直接看，不用先开弹窗 */}
			<div
				className="relative mt-3 aspect-video shrink-0 overflow-hidden rounded-lg bg-paper-300"
				onPointerDown={stopAll}
			>
				{videoUrl ? (
					<video
						src={videoUrl}
						className={`${MEDIA} h-full w-full object-cover`}
						{...videoReady}
						controls
						preload="metadata"
						playsInline
					/>
				) : (
					<EmptyMedia label={statusText} />
				)}
			</div>

			{videoUrl || needsRecompose ? (
				<div className="mt-2 flex gap-1.5" onPointerDown={stopAll}>
					{videoUrl ? (
						<a
							href={videoUrl}
							download
							// 成片在另一个源上，download 属性会被忽略；新标签打开，工作台留在原处
							target="_blank"
							rel="noopener"
							onClick={stopAll}
							className="btn-doodle touch-target-dense h-7 min-h-7 flex-1 px-2 text-xs bg-primary text-primary-content"
						>
							<SvgIcon name="download" size={12} />
							下载成片
						</a>
					) : null}
					{needsRecompose ? (
						<button
							type="button"
							onClick={(e) => {
								stopAll(e);
								canvasEvents.emit("request-regenerate", {
									source: "output-card",
								});
							}}
							className="btn-doodle touch-target-dense h-7 min-h-7 flex-1 px-2 text-xs bg-transparent text-ink hover:bg-paper-200"
						>
							<SvgIcon name="refresh-cw" size={12} />
							重新合成
						</button>
					) : null}
				</div>
			) : null}

			{node.blockingClips.length > 0 ? (
				<div className="mt-2 min-h-0 overflow-y-auto rounded-lg border border-warning/25 bg-warning/10 p-2">
					<p className="m-0 font-mono text-xs uppercase text-warning-fg">
						阻塞项 {node.blockingClips.length}
					</p>
					<ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-xs leading-relaxed text-ink">
						{node.blockingClips.map((clip) => (
							<li key={clip.shot_id}>
								格 {clip.order} · {clip.reason}
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="m-0 mt-2 text-xs text-ink-muted">{statusText}</p>
			)}

			{node.exports.length > 0 ? (
				<div className="mt-auto pt-2" onPointerDown={stopAll}>
					<p className="m-0 font-mono text-xs uppercase text-ink-muted">
						导出记录 {node.exports.length}
					</p>
					<div className="mt-1 flex flex-col gap-0.5">
						{node.exports.slice(-3).map((url, index) => (
							<a
								key={`${url}-${index}`}
								href={getStaticUrl(url) ?? url}
								download
								onClick={stopAll}
								className="flex items-center gap-1 truncate text-xs text-ink-muted transition-colors duration-fast hover:text-ink"
							>
								<SvgIcon name="arrow-down-to-line" size={12} />
								<span className="truncate">
									{url.split("/").pop() ?? `导出 ${index + 1}`}
								</span>
							</a>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function outputStateLabel(state: Extract<ComicWorkflowNode, { kind: "output" }>["outputState"]) {
	if (state === "ready") return "成片可用";
	if (state === "needs_recompose") return "需要重新合成";
	if (state === "blocked") return "阻塞";
	return "等待合成";
}

function CardHeader({
	node,
	icon,
	accentClass,
	compact = false,
}: {
	node: ComicWorkflowNode;
	icon: "lightbulb" | "star" | "clapperboard" | "play-circle";
	accentClass: string;
	compact?: boolean;
}) {
	return (
		<div className="flex items-start gap-2">
			<div
				className={`flex shrink-0 items-center justify-center rounded-md text-primary-content ${accentClass} ${
					compact ? "h-7 w-7" : "h-8 w-8"
				}`}
			>
				<SvgIcon name={icon} size={compact ? 13 : 15} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="m-0 truncate text-sm font-bold">
						{node.title}
					</p>
					{statusBadge(node.status)}
				</div>
				<p className="m-0 truncate font-mono text-xs uppercase text-ink-muted">
					{node.subtitle}
				</p>
			</div>
		</div>
	);
}

export interface WorkflowFrameViewProps {
	section: ComicWorkflowSection;
	title: string;
	eyebrow: string;
	countLabel: string;
	draggable?: boolean;
	empty?: boolean;
}

/** 空分区的引导：告诉第一次用的人这里会出现什么、下一步做什么 */
const EMPTY_HINT: Partial<Record<ComicWorkflowSection, string>> = {
	elements: "规划完成后，角色会出现在这里。",
	shotline: "规划完成后，分镜会出现在这里。",
	output: "分镜都有了视频后，成片会出现在这里。",
};

/** 分区框（React Flow 父节点）。 */
export function WorkflowFrameView({
	section,
	title,
	eyebrow,
	countLabel,
	draggable = true,
	empty = false,
}: WorkflowFrameViewProps) {
	const hint = empty ? EMPTY_HINT[section] : undefined;
	const style = SECTION_STYLE[section];
	return (
		<section
			aria-label={title}
			className={`flex h-full w-full flex-col rounded-lg border border-line p-3 text-ink ${
				draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
			} ${style.surface}`}
		>
			<div className="flex items-center gap-2">
				<span className={`h-7 w-1 rounded-full ${style.accent}`} />
				<div className="min-w-0">
					<p className="m-0 font-mono text-xs uppercase text-ink-muted">
						{eyebrow}
					</p>
					{/* countLabel 并入标题行尾：头部固定两行，layout 侧 frameHeader=56 才装得下 */}
					<div className="flex min-w-0 items-baseline gap-2">
						<p className="m-0 truncate text-md font-bold leading-tight">
							{title}
						</p>
						{countLabel ? (
							<p className="m-0 shrink-0 font-mono text-xs uppercase text-ink-muted">
								{countLabel}
							</p>
						) : null}
					</div>
				</div>
			</div>
			{hint ? (
				<p className="m-0 flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-muted">
					{hint}
				</p>
			) : null}
		</section>
	);
}

/** 卡片边框随状态：默认 hairline，悬停加深；生成中/阻塞用状态色提示。 */
const CARD_TONE: Partial<Record<WorkflowNodeStatus, string>> & { draft: string } = {
	draft: "border-line hover:border-border-strong",
	generating: "border-warning/50",
	blocked: "border-error/50",
};

/** 业务卡片（React Flow 节点）。选中由 React Flow 管理。 */
export function WorkflowCardView({
	node,
	draggable = false,
	selected = false,
}: {
	node: ComicWorkflowNode;
	draggable?: boolean;
	selected?: boolean;
}) {
	return (
		<article
			aria-label={node.title}
			data-status={node.status}
			className={`h-full select-none overflow-hidden rounded-lg bg-paper-100 text-ink transition duration-fast ease-standard ${
				node.kind === "output" ? "comic-frame" : `border ${CARD_TONE[node.status] ?? CARD_TONE.draft}`
			} ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${selected ? "ring-2 ring-primary ring-offset-2 ring-offset-paper-100" : ""}`}
		>
			{node.kind === "character" ? <CharacterCard node={node} /> : null}
			{node.kind === "shot" ? <ShotCard node={node} /> : null}
			{node.kind === "output" ? <OutputCard node={node} /> : null}
		</article>
	);
}
