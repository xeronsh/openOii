import {
	HTMLContainer,
	Rectangle2d,
	ShapeUtil,
	T,
	type Geometry2d,
	type RecordProps,
} from "tldraw";
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
} from "../cardActions";
import type { ComicWorkflowNode, WorkflowNodeStatus } from "../../graph/types";
import {
	WORKFLOW_SHAPE_TYPES,
	type WorkflowCardShape,
	type WorkflowFrameShape,
} from "./types";

const SECTION_STYLE = {
	brief: {
		accent: "bg-primary",
		surface: "bg-primary/5",
	},
	elements: {
		accent: "bg-secondary",
		surface: "bg-secondary/5 halftone-bg",
	},
	shotline: {
		accent: "bg-accent",
		surface: "bg-accent/5 halftone-bg",
	},
	output: {
		accent: "bg-base-content",
		surface: "bg-base-200/45",
	},
} as const;

const STATUS_COPY: Record<WorkflowNodeStatus, { label: string; cls: string }> = {
	draft: { label: "待生成", cls: "badge-ghost" },
	generating: { label: "生成中", cls: "badge-warning" },
	review: { label: "待审阅", cls: "badge-warning" },
	approved: { label: "已批准", cls: "badge-success" },
	blocked: { label: "阻塞", cls: "badge-error" },
	superseded: { label: "需重合成", cls: "badge-warning" },
	ready: { label: "可用", cls: "badge-success" },
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
				className={`block w-full cursor-text rounded-sm text-left transition-colors hover:bg-base-content/5 ${displayClassName}`}
			>
				{value ? (
					value
				) : (
					<span className="italic text-bc-subtle">{placeholder}</span>
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
			className="w-full resize-none rounded-sm border-2 border-primary bg-base-100 p-1.5 text-xs leading-relaxed text-base-content focus:outline-none"
		/>
	);
}

/** 待审阅卡的动作行：通过 / 重做 直接上卡，不必逐个打开面板 */
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
				className="btn btn-success btn-xs h-6 min-h-6 flex-1 gap-1 px-1.5 text-xs"
			>
				{busy === "approve" ? (
					<span className="loading loading-spinner loading-xs" />
				) : (
					<SvgIcon name="check" size={11} />
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
				className="btn btn-ghost btn-xs h-6 min-h-6 flex-1 gap-1 border-base-content/20 px-1.5 text-xs"
			>
				{busy === "redo" ? (
					<span className="loading loading-spinner loading-xs" />
				) : (
					<SvgIcon name="refresh-cw" size={11} />
				)}
				重做
			</button>
		</div>
	);
}

function selectWorkflowNode(nodeId: string) {
	canvasEvents.emit("select-workflow-node", { nodeId });
}

function statusBadge(status: WorkflowNodeStatus) {
	const copy = STATUS_COPY[status] ?? STATUS_COPY.draft;
	return (
		<span className={`badge badge-sm gap-1 whitespace-nowrap ${copy.cls}`}>
			<span className="h-2 w-2 rounded-full bg-current opacity-60" />
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
			className="btn btn-circle pointer-events-auto h-12 min-h-12 w-12 border-2 border-base-content/20 bg-base-100/90 text-base-content shadow-brutal-sm hover:bg-primary hover:text-primary-content"
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
			<SvgIcon name={type === "image" ? "image" : "play"} size={17} />
		</button>
	);
}

function EmptyMedia({ label }: { label: string }) {
	return (
		<div className="flex h-full w-full items-center justify-center bg-base-300 text-xs text-bc-muted">
			{label}
		</div>
	);
}

function BriefCard({ node }: { node: Extract<ComicWorkflowNode, { kind: "brief" }> }) {
	const duration = node.metrics.totalDuration
		? `${node.metrics.totalDuration}s`
		: "未定";

	return (
		<div className="flex h-full flex-col p-4">
			<CardHeader node={node} icon="lightbulb" accentClass="bg-primary" />
			<div className="mt-4 grid grid-cols-3 gap-2">
				<Metric label="角色" value={node.metrics.characterCount} />
				<Metric label="镜头" value={node.metrics.shotCount} />
				<Metric label="时长" value={duration} />
			</div>
			{/* 行数上限与固定卡高匹配：超限走省略号，而不是被 overflow-hidden 齐腰裁半个字 */}
			<div className="mt-4 min-h-0 flex-1 space-y-3 overflow-hidden">
				{node.project.story ? (
					<p className="m-0 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-base-content/75">
						{node.project.story}
					</p>
				) : (
					<p className="m-0 text-sm text-bc-muted">等待故事输入</p>
				)}
				{node.project.summary ? (
					<p className="m-0 line-clamp-3 rounded-lg border border-secondary/20 bg-secondary/10 p-2 text-xs leading-relaxed text-bc-muted">
						{node.project.summary}
					</p>
				) : null}
			</div>
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
			<span className="shrink-0 font-mono text-2xs uppercase text-bc-muted">
				参考 {refs.length}
			</span>
			<div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
				{refs.slice(0, 3).map((url, index) => (
					<span key={`${url}-${index}`} className="group relative shrink-0">
						<img
							src={getStaticUrl(url) ?? url}
							alt={`参考图 ${index + 1}`}
							className="h-7 w-7 rounded-sm border border-base-content/20 object-cover"
							draggable={false}
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
								<span className="loading loading-spinner h-2 w-2" />
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
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-dashed border-base-content/25 text-bc-muted transition-colors hover:border-primary/50 hover:text-primary-ink"
				>
					{busy === "upload" ? (
						<span className="loading loading-spinner loading-xs" />
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
					className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-bc-muted transition-colors hover:bg-base-content/10 hover:text-base-content"
				>
					{busy === "embed" ? (
						<span className="loading loading-spinner loading-xs" />
					) : (
						<SvgIcon name="refresh-cw" size={11} />
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
			<div className="relative aspect-[4/3] bg-base-300">
				{imageUrl ? (
					<img
						src={imageUrl}
						alt={node.title}
						draggable={false}
						decoding="async"
						loading="lazy"
						className="h-full w-full object-cover"
					/>
				) : (
					<EmptyMedia label="等待角色图" />
				)}
				<div className="absolute right-2 top-2">
					<MediaPreviewButton src={imageUrl} title={node.title} type="image" />
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col p-3">
				<CardHeader node={node} icon="star" accentClass="bg-secondary" compact />
				{node.character.description ? (
					<p className="m-0 mt-1.5 line-clamp-2 text-xs leading-relaxed text-bc-muted">
						{node.character.description}
					</p>
				) : null}
				<CharacterRefStrip node={node} />
				<div className="mt-auto flex flex-wrap gap-1 pt-1.5">
					{node.character.has_embedding ? (
						<span className="badge badge-primary badge-xs">资产一致性</span>
					) : null}
					{node.character.visual_notes ? (
						<span className="badge badge-ghost badge-xs">视觉笔记</span>
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
			<div className="relative h-[128px] shrink-0 bg-base-300">
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
						className="h-full w-full object-cover"
					/>
				) : (
					<EmptyMedia label="等待分镜图" />
				)}
				{/* 九宫格 cell index */}
				<span className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-sm border-2 border-base-content/20 bg-accent px-1 font-mono text-2xs font-bold text-accent-content shadow-brutal-sm">
					{cell}
				</span>
				<span className="absolute bottom-1.5 left-1.5 badge badge-xs bg-base-100/90 tabular-nums">
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
				<CardHeader node={node} icon="clapperboard" accentClass="bg-accent" compact />
				<p className="m-0 mt-1 font-mono text-2xs uppercase tracking-wide text-bc-muted">
					格 {cell}
				</p>
				<div className="mt-1.5">
					<InlineEditableText
						value={node.shot.description}
						placeholder="添加画面描述"
						ariaLabel={`格 ${cell} 画面描述`}
						rows={3}
						disabled={editLocked}
						displayClassName="line-clamp-3 p-0.5 text-xs leading-relaxed text-bc-muted"
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
						displayClassName="line-clamp-2 p-0.5 text-xs italic text-primary-ink"
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
						<span className="badge badge-secondary badge-xs max-w-full truncate">
							{node.characterNames.join("、")}
						</span>
					) : null}
					{node.shot.camera ? (
						<span className="badge badge-ghost badge-xs">{node.shot.camera}</span>
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
				className="relative mt-3 aspect-video shrink-0 overflow-hidden rounded-xl bg-base-300"
				onPointerDown={stopAll}
			>
				{videoUrl ? (
					<video
						src={videoUrl}
						className="h-full w-full object-cover"
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
							onClick={stopAll}
							className="btn btn-primary btn-xs h-7 min-h-7 flex-1 gap-1 text-xs"
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
							className="btn btn-ghost btn-xs h-7 min-h-7 flex-1 gap-1 border-base-content/20 text-xs"
						>
							<SvgIcon name="refresh-cw" size={11} />
							重新合成
						</button>
					) : null}
				</div>
			) : null}

			{node.blockingClips.length > 0 ? (
				<div className="mt-2 min-h-0 overflow-y-auto rounded-lg border border-warning/25 bg-warning/10 p-2">
					<p className="m-0 font-mono text-2xs uppercase text-warning">
						阻塞项 {node.blockingClips.length}
					</p>
					<ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-xs leading-relaxed text-base-content">
						{node.blockingClips.map((clip) => (
							<li key={clip.shot_id}>
								格 {clip.order} · {clip.reason}
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="m-0 mt-2 text-xs text-bc-muted">{statusText}</p>
			)}

			{node.exports.length > 0 ? (
				<div className="mt-auto pt-2" onPointerDown={stopAll}>
					<p className="m-0 font-mono text-2xs uppercase text-bc-muted">
						导出记录 {node.exports.length}
					</p>
					<div className="mt-1 flex flex-col gap-0.5">
						{node.exports.slice(-3).map((url, index) => (
							<a
								key={`${url}-${index}`}
								href={getStaticUrl(url) ?? url}
								download
								onClick={stopAll}
								className="flex items-center gap-1 truncate text-xs text-bc-muted transition-colors hover:text-base-content"
							>
								<SvgIcon name="arrow-down-to-line" size={11} />
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

function Metric({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-lg border border-base-content/10 bg-base-200/50 p-2">
			<p className="m-0 text-2xs font-mono uppercase text-bc-muted">
				{label}
			</p>
			<p className="m-0 truncate font-heading text-lg font-bold">{value}</p>
		</div>
	);
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
				className={`flex shrink-0 items-center justify-center rounded-md text-primary-content shadow-brutal-sm ${accentClass} ${
					compact ? "h-7 w-7" : "h-8 w-8"
				}`}
			>
				<SvgIcon name={icon} size={compact ? 13 : 15} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<p className="m-0 truncate font-heading text-sm font-bold">
						{node.title}
					</p>
					{statusBadge(node.status)}
				</div>
				<p className="m-0 truncate font-mono text-2xs uppercase text-bc-muted">
					{node.subtitle}
				</p>
			</div>
		</div>
	);
}

export class WorkflowFrameShapeUtil extends ShapeUtil<WorkflowFrameShape> {
	static override type = WORKFLOW_SHAPE_TYPES.FRAME;

	static override props: RecordProps<WorkflowFrameShape> = {
		w: T.number,
		h: T.number,
		section: T.any,
		title: T.string,
		eyebrow: T.string,
		status: T.any,
		countLabel: T.string,
		draggable: T.optional(T.boolean),
	};

	getDefaultProps(): WorkflowFrameShape["props"] {
		return {
			w: 520,
			h: 360,
			section: "brief",
			title: "Brief",
			eyebrow: "01 / STORY",
			status: "draft",
			countLabel: "",
			draggable: true,
		};
	}

	override canEdit() {
		return false;
	}

	override canResize() {
		return false;
	}

	getGeometry(shape: WorkflowFrameShape): Geometry2d {
		return new Rectangle2d({
			width: shape.props.w,
			height: shape.props.h,
			isFilled: true,
		});
	}

	component(shape: WorkflowFrameShape) {
		const { w, h, section, title, eyebrow, countLabel, draggable = true } =
			shape.props;
		const style = SECTION_STYLE[section];
		return (
			<HTMLContainer style={{ width: w, height: h, pointerEvents: "all" }}>
				{/* text-base-content：阻断 tldraw .tl-html-container 的 --tl-color-text 继承，
				    否则暗色主题下未显式着色的文字会停留在 tldraw 的亮色近黑（1.3:1） */}
				<section
					aria-label={title}
					className={`h-full w-full rounded-xl border-3 border-base-content/15 p-3 text-base-content shadow-brutal-sm ${
						draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"
					} ${style.surface}`}
					onPointerDown={draggable ? undefined : stopCanvasPointer}
				>
					<div className="flex items-center gap-2">
						<span className={`h-7 w-1 rounded-full ${style.accent}`} />
						<div className="min-w-0">
							<p className="m-0 font-mono text-2xs uppercase text-bc-muted">
								{eyebrow}
							</p>
							{/* countLabel 并入标题行尾：头部固定两行，layout 侧 frameHeader=56 才装得下 */}
							<div className="flex min-w-0 items-baseline gap-2">
								<p className="m-0 truncate font-heading text-md font-bold leading-tight">
									{title}
								</p>
								{countLabel ? (
									<p className="m-0 shrink-0 font-mono text-2xs uppercase text-bc-muted">
										{countLabel}
									</p>
								) : null}
							</div>
						</div>
					</div>
				</section>
			</HTMLContainer>
		);
	}

	indicator(shape: WorkflowFrameShape) {
		return <rect width={shape.props.w} height={shape.props.h} rx={20} />;
	}

	override canReceiveNewChildrenOfType(
		_shape: WorkflowFrameShape,
		type: string,
	) {
		return type === WORKFLOW_SHAPE_TYPES.CARD;
	}
}

export class WorkflowCardShapeUtil extends ShapeUtil<WorkflowCardShape> {
	static override type = WORKFLOW_SHAPE_TYPES.CARD;

	static override props: RecordProps<WorkflowCardShape> = {
		w: T.number,
		h: T.number,
		node: T.any,
		draggable: T.optional(T.boolean),
	};

	getDefaultProps(): WorkflowCardShape["props"] {
		return {
			w: 300,
			h: 320,
			node: {} as ComicWorkflowNode,
			draggable: false,
		};
	}

	override canEdit() {
		return false;
	}

	override canResize() {
		return false;
	}

	getGeometry(shape: WorkflowCardShape): Geometry2d {
		return new Rectangle2d({
			width: shape.props.w,
			height: shape.props.h,
			isFilled: true,
		});
	}

	component(shape: WorkflowCardShape) {
		const { w, h, node, draggable = false } = shape.props;
		return (
			<HTMLContainer style={{ width: w, height: h, pointerEvents: "all" }}>
				<article
					aria-label={node.title}
					className="card-comic h-full select-none overflow-hidden border-3 border-base-content/25 bg-base-100 text-base-content"
					onPointerDown={draggable ? undefined : stopCanvasPointer}
					onClick={() => selectWorkflowNode(node.id)}
				>
					{node.kind === "brief" ? <BriefCard node={node} /> : null}
					{node.kind === "character" ? <CharacterCard node={node} /> : null}
					{node.kind === "shot" ? <ShotCard node={node} /> : null}
					{node.kind === "output" ? <OutputCard node={node} /> : null}
				</article>
			</HTMLContainer>
		);
	}

	indicator(shape: WorkflowCardShape) {
		return <rect width={shape.props.w} height={shape.props.h} rx={12} />;
	}
}

export const workflowShapeUtils = [
	WorkflowFrameShapeUtil,
	WorkflowCardShapeUtil,
];
