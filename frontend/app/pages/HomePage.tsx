import { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, universesApi } from "~/services/api";
import { Button } from "~/components/ui/Button";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	PaperAirplaneIcon,
} from "@heroicons/react/24/outline";
import { TopBar } from "~/components/layout/TopBar";
import { PageBody, PageShell } from "~/components/layout/PageShell";
import { PageContent, PageHeader } from "~/components/layout/PageHeader";
import { DeskSection } from "~/components/layout/DeskSection";
import { SkillWall } from "~/components/home/SkillWall";
import { SvgIcon } from "~/components/ui/SvgIcon";
import {
	getSkillById,
	type SkillPreset,
} from "~/features/skills/skillCatalog";

const AssetDrawer = lazy(() =>
	import("~/components/panels/AssetDrawer").then((m) => ({
		default: m.AssetDrawer,
	})),
);
const HistoryDrawer = lazy(() =>
	import("~/components/panels/HistoryDrawer").then((m) => ({
		default: m.HistoryDrawer,
	})),
);

const STYLE_CATEGORIES = [
	{
		group: "2D 动画",
		styles: [
			{ value: "anime", label: "日漫" },
			{ value: "shonen", label: "少年热血" },
			{ value: "slice-of-life", label: "日常治愈" },
			{ value: "manga", label: "黑白漫画" },
			{ value: "donghua", label: "国风动画" },
		],
	},
	{
		group: "3D 风格",
		styles: [
			{ value: "cinematic", label: "电影质感" },
			{ value: "pixar", label: "3D 卡通" },
			{ value: "lowpoly", label: "低多边形" },
		],
	},
	{
		group: "艺术风格",
		styles: [
			{ value: "watercolor", label: "水彩" },
			{ value: "sketch", label: "素描" },
			{ value: "realistic", label: "写实" },
		],
	},
];

const STYLE_OPTIONS = STYLE_CATEGORIES.flatMap((category) => category.styles);
const PRIMARY_STYLE_VALUES = new Set([
	"anime",
	"cinematic",
	"donghua",
	"sketch",
]);
const PRIMARY_STYLE_OPTIONS = STYLE_OPTIONS.filter((option) =>
	PRIMARY_STYLE_VALUES.has(option.value),
);
const DEFAULT_STYLE = "anime";

export function HomePage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const requestedUniverseId = Number(searchParams.get("universeId"));
	const requestedChapterNumber = Number(searchParams.get("chapterNumber"));
	const [story, setStory] = useState("");
	const [style, setStyle] = useState(DEFAULT_STYLE);
	const [creationMode, setCreationMode] = useState<"review" | "quick">("review");
	const [selectedUniverseId, setSelectedUniverseId] = useState<number | null>(
		Number.isFinite(requestedUniverseId) && requestedUniverseId > 0
			? requestedUniverseId
			: null,
	);
	const [shotCount, setShotCount] = useState<number | undefined>(undefined);
	const [characterHints, setCharacterHints] = useState<string[]>([""]);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [isComposing, setIsComposing] = useState(false);
	const [referenceImages, setReferenceImages] = useState<string[]>([]);
	const [pendingFiles, setPendingFiles] = useState<File[]>([]);
	const [assetsOpen, setAssetsOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	// 记住上次使用的工作流：回访用户不必每次重新决策
	const [lastUsedSkillId] = useState<string | null>(() => {
		try {
			return localStorage.getItem("openoii-last-skill");
		} catch {
			return null;
		}
	});
	const [activeSkillId, setActiveSkillId] = useState<string | null>(
		lastUsedSkillId || "story-anime",
	);

	// 记忆恢复必须连同预填一起生效，否则「已预填」徽章与实际参数不一致
	const lastUsedAppliedRef = useRef(false);
	useEffect(() => {
		if (lastUsedAppliedRef.current) return;
		lastUsedAppliedRef.current = true;
		if (!lastUsedSkillId || lastUsedSkillId === "story-anime") return;
		const skill = getSkillById(lastUsedSkillId);
		if (!skill) return;
		if (skill.prefill.style) setStyle(skill.prefill.style);
		if (skill.prefill.creationMode) setCreationMode(skill.prefill.creationMode);
		if (skill.prefill.placeholder) setStoryPlaceholder(skill.prefill.placeholder);
		if (skill.prefill.targetShotCount != null) {
			setShotCount(skill.prefill.targetShotCount);
		}
	}, [lastUsedSkillId]);
	const [storyPlaceholder, setStoryPlaceholder] = useState(
		"主角、冲突、关键画面、情绪基调。",
	);
	const storyInputRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		setSelectedUniverseId(
			Number.isFinite(requestedUniverseId) && requestedUniverseId > 0
				? requestedUniverseId
				: null,
		);
	}, [requestedUniverseId]);

	const { data: universes = [], isLoading: universesLoading } = useQuery({
		queryKey: ["universes"],
		queryFn: () => universesApi.list(),
	});
	const selectedUniverse =
		selectedUniverseId != null
			? universes.find((universe) => universe.id === selectedUniverseId)
			: undefined;
	const nextChapterNumber =
		selectedUniverseId != null
			? Number.isFinite(requestedChapterNumber) && requestedChapterNumber > 0
				? requestedChapterNumber
				: (selectedUniverse?.projects_count ?? 0) + 1
			: null;
	const selectedStyleLabel =
		STYLE_OPTIONS.find((option) => option.value === style)?.label ?? style;
	const creationModeLabel =
		creationMode === "review" ? "精细审阅" : "快速生成";
	const activeCharacterHints = characterHints.filter((hint) => hint.trim());

	const createMutation = useMutation({
		mutationFn: projectsApi.create,
		onSuccess: async (project) => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			if (pendingFiles.length > 0 && project.id) {
				for (const file of pendingFiles) {
					try {
						await projectsApi.uploadReference(project.id, file);
					} catch (e) {
						if (import.meta.env.DEV) console.error("[ref upload]", e);
					}
				}
				setPendingFiles([]);
			}
			const skillQ = activeSkillId ? `&skill=${encodeURIComponent(activeSkillId)}` : "";
			navigate(`/project/${project.id}?autoStart=true${skillQ}`);
		},
	});

	const handleSubmit = () => {
		const trimmed = story.trim();
		if (!trimmed || createMutation.isPending) return;

		const MAX_STORY_LENGTH = 5000;
		if (trimmed.length > MAX_STORY_LENGTH) {
			alert(
				`故事太长了！请控制在 ${MAX_STORY_LENGTH} 字以内（当前 ${trimmed.length} 字）`,
			);
			return;
		}

		const firstLine = trimmed.split("\n")[0] || "";
		const MAX_TITLE_LENGTH = 50;
		const title =
			firstLine.length > MAX_TITLE_LENGTH
				? `${firstLine.slice(0, MAX_TITLE_LENGTH)}...`
				: firstLine;

		const hints = characterHints.filter((h) => h.trim());
		const chapterNumber = selectedUniverseId ? nextChapterNumber : null;
		const chapterTitle =
			selectedUniverseId && chapterNumber
				? title || `第 ${chapterNumber} 章`
				: null;

		createMutation.mutate({
			title: title || "未命名项目",
			story: trimmed,
			style,
			target_shot_count: shotCount,
			character_hints: hints.length > 0 ? hints : undefined,
			creation_mode: creationMode,
			universe_id: selectedUniverseId,
			chapter_number: chapterNumber,
			chapter_title: chapterTitle,
			skill_id: activeSkillId,
			text_provider_override: null,
			image_provider_override: null,
			video_provider_override: null,
		});
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !isComposing) {
			e.preventDefault();
			handleSubmit();
		}
	};

	const addCharacterHint = () => {
		setCharacterHints([...characterHints, ""]);
	};

	const updateCharacterHint = (index: number, value: string) => {
		const updated = [...characterHints];
		updated[index] = value;
		setCharacterHints(updated);
	};

	const removeCharacterHint = (index: number) => {
		setCharacterHints(characterHints.filter((_, i) => i !== index));
	};

	const handleImageUpload = useCallback(
		(files: FileList | null) => {
			if (!files) return;
			const newFiles = Array.from(files);
			const total = pendingFiles.length + newFiles.length;
			if (total > 7) {
				newFiles.splice(7 - pendingFiles.length);
			}
			setPendingFiles((prev) => [...prev, ...newFiles]);
			newFiles.forEach((file) => {
				const reader = new FileReader();
				reader.onload = (e) => {
					const dataUrl = e.target?.result as string;
					setReferenceImages((prev) => [...prev, dataUrl]);
				};
				reader.readAsDataURL(file);
			});
		},
		[pendingFiles.length],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			handleImageUpload(e.dataTransfer.files);
		},
		[handleImageUpload],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const items = e.clipboardData.items;
			const imageItems = Array.from(items).filter((item) =>
				item.type.startsWith("image/"),
			);
			if (imageItems.length === 0) return;
			e.preventDefault();
			imageItems.forEach((item) => {
				const file = item.getAsFile();
				if (file) {
					const dt = new DataTransfer();
					dt.items.add(file);
					handleImageUpload(dt.files);
				}
			});
		},
		[handleImageUpload],
	);

	const removeReferenceImage = (index: number) => {
		setReferenceImages(referenceImages.filter((_, i) => i !== index));
		setPendingFiles(pendingFiles.filter((_, i) => i !== index));
	};

	const handleSkillSelect = useCallback((skill: SkillPreset) => {
		setActiveSkillId(skill.id);
		try {
			localStorage.setItem("openoii-last-skill", skill.id);
		} catch {
			// 隐私模式等场景下静默降级
		}
		if (skill.prefill.style) setStyle(skill.prefill.style);
		if (skill.prefill.creationMode) setCreationMode(skill.prefill.creationMode);
		if (skill.prefill.placeholder) setStoryPlaceholder(skill.prefill.placeholder);
		if (skill.prefill.targetShotCount != null) {
			setShotCount(skill.prefill.targetShotCount);
		}
		// Fill starter scaffold only when story is empty / only old skill prefix
		const template = skill.prefill.storyTemplate?.trim();
		const hint = skill.prefill.storyHint ?? "";
		if (!story.trim()) {
			setStory(template ? `${template}\n` : hint);
		} else if (template && story.trim().length < 40) {
			// short leftover prefixes from previous skill → replace
			setStory(`${template}\n`);
		}
		requestAnimationFrame(() => {
			storyInputRef.current?.focus();
			storyInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
	}, [story]);


	const navChip =
		"touch-target-dense inline-flex items-center gap-1.5 rounded-md px-2 text-xs font-bold transition-colors duration-fast hover:bg-base-200";
	const settingChip = (active: boolean) =>
		`touch-target-dense rounded-md border-2 px-2 py-1.5 text-xs font-bold transition-colors duration-fast ${
			active
				? "border-primary bg-primary text-primary-content"
				: "border-base-content/15 bg-base-100 text-bc-muted hover:border-primary/40"
		}`;
	const metaChip =
		"rounded-full border border-base-content/10 bg-base-200 px-2 py-0.5 text-2xs font-semibold text-base-content/75";
	const sectionLabel =
		"m-0 font-heading text-sm font-bold leading-tight";

	return (
		<PageShell data-shell="home">
			<div
				className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
				onDrop={handleDrop}
				onDragOver={(e) => e.preventDefault()}
			>
			<TopBar />
			{assetsOpen && (
				<Suspense fallback={null}>
					<AssetDrawer open onClose={() => setAssetsOpen(false)} />
				</Suspense>
			)}
			{historyOpen && (
				<Suspense fallback={null}>
					<HistoryDrawer
						open
						onClose={() => setHistoryOpen(false)}
						onNavigate={(id) => navigate(`/project/${id}`)}
					/>
				</Suspense>
			)}
			<PageBody className="workbench-surface">
				<PageContent className="min-h-full sm:py-4">
					<PageHeader
						eyebrow="create desk"
						title="创作台"
						description="选工作流，写一句话开工"
						actionsAlign="title"
						actions={
							<div className="flex flex-wrap gap-1" aria-label="创作台工具">
								<button
									type="button"
									className={`${navChip} ${
										historyOpen ? "bg-primary text-primary-content" : "text-bc-muted"
									}`}
									onClick={() => setHistoryOpen((v) => !v)}
									aria-pressed={historyOpen}
								>
									<SvgIcon name="clock-3" size={14} />
									历史
								</button>
								<button
									type="button"
									className={`${navChip} ${
										assetsOpen ? "bg-primary text-primary-content" : "text-bc-muted"
									}`}
									onClick={() => setAssetsOpen((v) => !v)}
									aria-pressed={assetsOpen}
								>
									<SvgIcon name="archive" size={14} />
									资产
								</button>
							</div>
						}
					/>

					{/* 桌面双栏：左侧纸面（工作流 + 故事创意），右侧 linen 面板。flex-1 让内容吃满视口，不留半屏空白 */}
					<div
						className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_14rem]"
						data-shell="create-desk"
					>
						<div className="flex min-w-0 flex-col gap-5">
							<DeskSection
								icon={<SvgIcon name="zap" size={16} />}
								title="工作流"
								actions={
									activeSkillId ? (
										// 预填透明化：选工作流会静默改右侧参数，这里让改动可见
										<span className="rounded border border-primary/25 bg-primary/10 px-1.5 py-px text-2xs font-bold text-primary-ink">
											已预填 {creationModeLabel} · {selectedStyleLabel} ·{" "}
											{shotCount ?? "自动"}镜
										</span>
									) : null
								}
							>
								<SkillWall
									activeSkillId={activeSkillId}
									onSelect={handleSkillSelect}
									lastUsedId={lastUsedSkillId}
								/>
							</DeskSection>

							<DeskSection
								icon={<SvgIcon name="pencil" size={16} />}
								title="故事创意"
								meta={`${story.length}/5000`}
								className="min-h-0 flex-1"
							>
								{/* flex-1 min-h-0：textarea 吃掉剩余视口高度（textarea 是「你写字的纸」，保留 doodle 边框） */}
								<div className="flex min-h-0 flex-1 flex-col" onPaste={handlePaste}>
									<textarea
										id="story-input"
										ref={storyInputRef}
										className="input-doodle min-h-24 w-full flex-1 resize-y bg-base-100/90 p-2.5 text-sm leading-normal sm:min-h-32"
										placeholder={storyPlaceholder}
										value={story}
										onChange={(e) => setStory(e.target.value)}
										onKeyDown={handleKeyDown}
										onCompositionStart={() => setIsComposing(true)}
										onCompositionEnd={() => setIsComposing(false)}
										disabled={createMutation.isPending}
										aria-label="输入你的故事创意"
										maxLength={5000}
										rows={4}
										name="story"
										autoComplete="off"
										spellCheck
									/>
									{story.length > 4500 && (
										<p className="m-0 mt-1 text-2xs font-bold text-warning">
											还可输入 {5000 - story.length} 字
										</p>
									)}
								</div>

								<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex min-w-0 flex-wrap gap-1.5">
										<span className={metaChip}>{selectedStyleLabel}</span>
										<span className={metaChip}>{creationModeLabel}</span>
										{referenceImages.length > 0 && (
											<span className={metaChip}>
												参考图 {referenceImages.length}
											</span>
										)}
										{activeCharacterHints.length > 0 && (
											<span className={metaChip}>
												角色 {activeCharacterHints.length}
											</span>
										)}
										{selectedUniverse && (
											<span className={`${metaChip} border-primary/30 bg-primary/10 text-primary-ink`}>
												{selectedUniverse.name} · 第 {nextChapterNumber} 章
											</span>
										)}
									</div>
									<Button
										variant="primary"
										size="md"
										className="w-full min-h-[var(--touch-target-min)] justify-center gap-2 sm:w-auto"
										onClick={handleSubmit}
										disabled={!story.trim() || createMutation.isPending}
										loading={createMutation.isPending}
									>
										{!createMutation.isPending && (
											<PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />
										)}
										生成并进入画布
									</Button>
								</div>
							</DeskSection>
						</div>

						{/* linen 面板：无 brutal 阴影，靠材质（底色）与左侧纸面区分，不做双卡并置 */}
						<aside
							className="min-w-0 self-start rounded-lg bg-base-200 p-3"
							aria-label="创作设置"
						>
							<div className="flex flex-col gap-3">
								<section aria-labelledby="universe-heading">
									<div className="mb-1 flex items-center justify-between gap-2">
										<h2 id="universe-heading" className={sectionLabel}>
											IP 宇宙
										</h2>
										<Link
											to="/universes"
											className="text-2xs font-bold text-bc-muted transition-colors hover:text-primary-ink"
										>
											管理
										</Link>
									</div>
									<select
										id="home-universe-select"
										name="universe_id"
										className="select select-bordered h-9 min-h-9 w-full bg-base-100 text-sm font-semibold"
										value={selectedUniverseId ?? ""}
										onChange={(event) => {
											const value = event.target.value;
											setSelectedUniverseId(value ? Number(value) : null);
										}}
										disabled={universesLoading}
										aria-label="选择 IP 宇宙"
									>
										<option value="">
											{universesLoading ? "加载宇宙…" : "独立项目"}
										</option>
										{universes.map((universe) => (
											<option key={universe.id} value={universe.id}>
												{universe.name}
											</option>
										))}
									</select>
									<p className="m-0 mt-1 text-2xs leading-snug text-bc-muted">
										{selectedUniverse
											? `第 ${nextChapterNumber} 章 · 沿用世界观与共享角色`
											: "不选则独立项目"}
									</p>
								</section>

								<section aria-labelledby="mode-heading">
									<h2 id="mode-heading" className={`${sectionLabel} mb-1`}>
										生成方式
									</h2>
									<div className="grid grid-cols-2 gap-2">
										{[
											{ value: "review", label: "审阅", icon: "check" },
											{ value: "quick", label: "快速", icon: "zap" },
										].map((mode) => (
											<button
												key={mode.value}
												type="button"
												className={settingChip(creationMode === mode.value)}
												onClick={() =>
													setCreationMode(mode.value as "review" | "quick")
												}
												aria-pressed={creationMode === mode.value}
											>
												<span className="inline-flex items-center justify-center gap-1">
													<SvgIcon name={mode.icon as "check" | "zap"} size={14} />
													{mode.label}
												</span>
											</button>
										))}
									</div>
								</section>

								<section aria-labelledby="style-heading">
									<h2 id="style-heading" className={`${sectionLabel} mb-1`}>
										常用风格
									</h2>
									<div className="grid grid-cols-2 gap-2">
										{PRIMARY_STYLE_OPTIONS.map((opt) => (
											<button
												key={opt.value}
												type="button"
												className={settingChip(style === opt.value)}
												onClick={() => setStyle(opt.value)}
												aria-pressed={style === opt.value}
											>
												{opt.label}
											</button>
										))}
									</div>
								</section>

								<section aria-labelledby="reference-heading">
									<div className="mb-1 flex items-center justify-between gap-2">
										<h2 id="reference-heading" className={sectionLabel}>
											参考图
										</h2>
										<span className="font-mono text-2xs tabular-nums text-bc-muted">
											{referenceImages.length}/7
										</span>
									</div>
									{referenceImages.length > 0 ? (
										<div className="flex flex-wrap gap-1.5">
											{referenceImages.map((img, i) => (
												<div
													key={i}
													className="group relative h-11 w-11 overflow-hidden rounded-md border-2 border-base-content/10"
												>
													<img
														src={img}
														alt={`参考图 ${i + 1}`}
														className="h-full w-full object-cover"
														width={44}
														height={44}
													/>
													<button
														type="button"
														className="absolute inset-0 flex items-center justify-center bg-error/60 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus:opacity-100"
														onClick={() => removeReferenceImage(i)}
														aria-label={`删除参考图 ${i + 1}`}
													>
														<SvgIcon
															name="x"
															size={16}
															className="text-error-content"
														/>
													</button>
												</div>
											))}
											{referenceImages.length < 7 && (
												<button
													type="button"
													className="flex h-11 w-11 items-center justify-center rounded-md border-2 border-dashed border-base-content/20 text-bc-muted transition-colors hover:border-primary/50 hover:text-primary-ink"
													onClick={() => fileInputRef.current?.click()}
													aria-label="添加参考图"
												>
													<SvgIcon name="plus" size={16} />
												</button>
											)}
										</div>
									) : (
										<button
											type="button"
											className="touch-target-dense inline-flex w-full items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-base-content/20 bg-base-100/70 px-2 py-1.5 text-xs font-semibold text-bc-muted transition-colors hover:border-primary/50 hover:text-primary-ink"
											onClick={() => fileInputRef.current?.click()}
										>
											<SvgIcon name="image" size={14} />
											添加参考图
										</button>
									)}
									<input
										ref={fileInputRef}
										id="reference-images"
										name="reference_images"
										type="file"
										accept="image/*"
										multiple
										className="hidden"
										onChange={(e) => {
											handleImageUpload(e.target.files);
											e.target.value = "";
										}}
									/>
								</section>

								<button
									type="button"
									className="touch-target-dense flex w-full items-center justify-between rounded-md border border-base-content/10 bg-base-100 px-2 text-xs font-bold text-bc-muted transition-colors hover:border-primary/40 hover:text-primary-ink"
									onClick={() => setShowAdvanced(!showAdvanced)}
									aria-expanded={showAdvanced}
								>
									<span>更多设置</span>
									{showAdvanced ? (
										<ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
									) : (
										<ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
									)}
								</button>

								{showAdvanced && (
									<div className="flex flex-col gap-2 border-t border-base-content/10 pt-2">
										<label className="form-control">
											<span className="label px-0 py-0 pb-0.5">
												<span className="label-text font-mono text-2xs uppercase text-bc-muted">
													完整风格
												</span>
											</span>
											<select
												className="select select-bordered h-9 min-h-9 bg-base-100 text-sm font-semibold"
												value={style}
												onChange={(event) => setStyle(event.target.value)}
												aria-label="完整风格"
											>
												{STYLE_CATEGORIES.map((category) => (
													<optgroup key={category.group} label={category.group}>
														{category.styles.map((opt) => (
															<option key={opt.value} value={opt.value}>
																{opt.label}
															</option>
														))}
													</optgroup>
												))}
											</select>
										</label>

										<label className="form-control">
											<span className="label px-0 py-0 pb-0.5">
												<span className="label-text font-mono text-2xs uppercase text-bc-muted">
													镜头数
												</span>
											</span>
											<div className="flex items-center gap-1.5">
												<input
													id="shot-count"
													type="number"
													min={1}
													max={20}
													value={shotCount ?? ""}
													placeholder="自动"
													onChange={(e) =>
														setShotCount(
															e.target.value ? Number(e.target.value) : undefined,
														)
													}
													className="input input-bordered h-9 min-h-9 flex-1 bg-base-100 text-sm font-semibold"
													aria-label="镜头数"
													autoComplete="off"
												/>
												<button
													type="button"
													className="btn btn-ghost h-9 min-h-9 px-2 text-2xs"
													onClick={() => setShotCount(undefined)}
												>
													自动
												</button>
											</div>
										</label>

										<div>
											<div className="mb-1 flex items-center justify-between gap-2">
												<p className="m-0 font-mono text-2xs uppercase text-bc-muted">
													角色提示
												</p>
												{characterHints.length < 6 ? (
													<button
														type="button"
														className="btn btn-ghost btn-sm h-8 min-h-8 px-2 text-2xs text-bc-muted hover:text-primary-ink"
														onClick={addCharacterHint}
													>
														添加
													</button>
												) : null}
											</div>
											<div className="flex flex-col gap-2">
												{characterHints.map((hint, i) => (
													<div key={i} className="flex gap-1.5">
														<input
															type="text"
															className="input input-bordered input-sm h-8 min-h-8 min-w-0 flex-1 bg-base-100 text-sm"
															placeholder={`角色 ${i + 1}`}
															value={hint}
															onChange={(e) =>
																updateCharacterHint(i, e.target.value)
															}
															autoComplete="off"
														/>
														{characterHints.length > 1 ? (
															<button
																type="button"
																className="btn btn-ghost btn-sm btn-square h-8 min-h-8 text-error"
																onClick={() => removeCharacterHint(i)}
																aria-label={`删除角色 ${i + 1}`}
															>
																<SvgIcon name="x" size={14} />
															</button>
														) : null}
													</div>
												))}
											</div>
										</div>
									</div>
								)}
							</div>
						</aside>
					</div>
				</PageContent>
			</PageBody>
			</div>
		</PageShell>
	);
}
