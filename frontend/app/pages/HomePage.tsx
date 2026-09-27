import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, universesApi } from "~/services/api";
import { Button } from "~/components/ui/Button";
import { PaperAirplaneIcon } from "@heroicons/react/24/outline";
import { TopBar } from "~/components/layout/TopBar";
import { PageBody, PageShell } from "~/components/layout/PageShell";
import { PageContent, PageHeader } from "~/components/layout/PageHeader";
import { DeskSection } from "~/components/layout/DeskSection";
import { SvgIcon } from "~/components/ui/SvgIcon";

const AssetDrawer = lazy(() =>
	import("~/components/panels/AssetDrawer").then((module) => ({ default: module.AssetDrawer })),
);
const HistoryDrawer = lazy(() =>
	import("~/components/panels/HistoryDrawer").then((module) => ({ default: module.HistoryDrawer })),
);

const DEFAULT_SKILL_ID = "story-anime";
const DEFAULT_STYLE = "anime";

export function HomePage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const requestedUniverseId = Number(searchParams.get("universeId"));
	const requestedChapterNumber = Number(searchParams.get("chapterNumber"));
	const [story, setStory] = useState("");
	const [creationMode, setCreationMode] = useState<"review" | "quick">("review");
	const [selectedUniverseId, setSelectedUniverseId] = useState<number | null>(
		Number.isFinite(requestedUniverseId) && requestedUniverseId > 0 ? requestedUniverseId : null,
	);
	const [assetsOpen, setAssetsOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);

	useEffect(() => {
		setSelectedUniverseId(
			Number.isFinite(requestedUniverseId) && requestedUniverseId > 0 ? requestedUniverseId : null,
		);
	}, [requestedUniverseId]);

	const { data: universes = [] } = useQuery({
		queryKey: ["universes"],
		queryFn: () => universesApi.list(),
	});
	const selectedUniverse = universes.find((universe) => universe.id === selectedUniverseId);
	const chapterNumber = selectedUniverseId == null
		? null
		: Number.isFinite(requestedChapterNumber) && requestedChapterNumber > 0
			? requestedChapterNumber
			: (selectedUniverse?.projects_count ?? 0) + 1;

	const createMutation = useMutation({
		mutationFn: projectsApi.create,
		onSuccess: (project) => {
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			navigate("/project/" + project.id + "?preflight=true&skill=" + DEFAULT_SKILL_ID);
		},
	});

	const createProject = () => {
		const trimmed = story.trim();
		if (!trimmed || createMutation.isPending) return;
		const title = trimmed.split("\n")[0].slice(0, 50) || "未命名项目";
		createMutation.mutate({
			title,
			story: trimmed,
			style: DEFAULT_STYLE,
			creation_mode: creationMode,
			universe_id: selectedUniverseId,
			chapter_number: chapterNumber,
			chapter_title: selectedUniverseId && chapterNumber ? title : null,
			skill_id: DEFAULT_SKILL_ID,
			text_provider_override: null,
			image_provider_override: null,
			video_provider_override: null,
		});
	};

	const navChip = "touch-target-dense inline-flex items-center gap-1.5 border-b-2 border-transparent px-2 text-xs font-bold transition-colors duration-fast hover:border-primary hover:bg-paper-200";

	return (
		<PageShell data-shell="home">
			<div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
				<TopBar />
				{assetsOpen ? <Suspense fallback={null}><AssetDrawer open onClose={() => setAssetsOpen(false)} /></Suspense> : null}
				{historyOpen ? <Suspense fallback={null}><HistoryDrawer open onClose={() => setHistoryOpen(false)} onNavigate={(id) => navigate("/project/" + id)} /></Suspense> : null}
				<PageBody className="workbench-surface">
					<PageContent className="min-h-full gap-4 sm:py-5">
						<PageHeader
							eyebrow="openoii / create"
							title="把一句想法，变成一部漫剧。"
							description="选择创作模式并写下故事，进入画布后与 AI 逐题梳理，再确认画面设置。"
							actionsAlign="title"
							actions={
							<div className="flex flex-wrap gap-1" aria-label="创作台工具">
								<button type="button" className={navChip + (historyOpen ? " bg-primary text-primary-content" : " text-ink-muted")} onClick={() => setHistoryOpen((open) => !open)} aria-pressed={historyOpen}>
									<SvgIcon name="clock-3" size={14} />历史
								</button>
								<button type="button" className={navChip + (assetsOpen ? " bg-primary text-primary-content" : " text-ink-muted")} onClick={() => setAssetsOpen((open) => !open)} aria-pressed={assetsOpen}>
									<SvgIcon name="archive" size={14} />资产
								</button>
							</div>
							}
						/>

						{/* 列宽由 PageContent 一层决定：这里不再叠第二道宽度约束 */}
						<div className="flex w-full flex-col gap-5" data-shell="create-desk">
							<DeskSection
								icon={<SvgIcon name="pencil" size={16} />}
								title="故事创意"
								meta={story.length + "/5000"}
								className="min-h-[20rem] border-2 border-ink/15 bg-paper-100 p-3 shadow-brutal-sm sm:min-h-[24rem] sm:p-4"
							>
								<div className="flex min-h-0 flex-1 flex-col">
									<textarea
										id="story-input"
										className="input-doodle min-h-32 w-full flex-1 resize-y bg-paper-100/90 p-3 text-base leading-normal sm:min-h-48 sm:p-4"
										placeholder="写下一个故事想法、人物、冲突或你脑海里的画面……"
										value={story}
										onChange={(event) => setStory(event.target.value)}
										disabled={createMutation.isPending}
										aria-label="输入你的故事创意"
										maxLength={5000}
										rows={4}
										name="story"
										autoComplete="off"
										spellCheck
									/>
									{story.length > 4500 ? <p className="m-0 mt-1 text-2xs font-bold text-warning">还可输入 {5000 - story.length} 字</p> : null}
								</div>

								<div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-3">
									<div className="flex min-w-0 flex-1 flex-col gap-1.5" aria-label="创作模式">
										<span className="font-mono text-2xs uppercase text-ink-muted">选择创作模式</span>
										<div className="grid grid-cols-2 gap-2">
											{[
												{ value: "review", label: "交互模式", description: "AI 逐题访谈，分阶段确认", icon: "check" },
												{ value: "quick", label: "YOLO 模式", description: "AI 逐题访谈后自动创作", icon: "zap" },
											].map((mode) => {
												const active = creationMode === mode.value;
												return (
													<button
														key={mode.value}
														type="button"
														className={"touch-target-dense flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 border-2 px-2 text-left text-xs font-bold transition-colors duration-fast sm:px-3 " + (active ? "border-primary bg-primary text-primary-content" : "border-ink/15 bg-paper-100 text-ink-muted hover:border-primary/40")}
														onClick={() => setCreationMode(mode.value as "review" | "quick")}
														aria-pressed={active}
													>
														<span className="inline-flex items-center gap-1.5 font-heading text-sm"><SvgIcon name={mode.icon as "check" | "zap"} size={14} />{mode.label}{active ? <span aria-hidden="true">✓</span> : null}</span>
														<span className="text-left text-2xs font-normal text-ink-muted">{mode.description}</span>
													</button>
												);
											})}
										</div>
									</div>
									<Button
										variant="primary"
										size="md"
										className="min-h-[var(--touch-target-min)] w-full shrink-0 justify-center gap-2 sm:w-auto"
										onClick={createProject}
										disabled={!story.trim() || createMutation.isPending}
										loading={createMutation.isPending}
									>
										{!createMutation.isPending ? <PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" /> : null}
										进入画布，与 AI 开始访谈
									</Button>
								</div>
								{selectedUniverse ? <p className="m-0 text-2xs text-ink-muted">将加入「{selectedUniverse.name}」宇宙 · 第 {chapterNumber} 章</p> : null}
								{createMutation.error ? <p className="m-0 border-l-2 border-error bg-error/10 px-3 py-2 text-xs text-error" role="alert">{createMutation.error.message || "创建项目失败，请重试。"}</p> : null}
							</DeskSection>
						</div>
					</PageContent>
				</PageBody>
			</div>
		</PageShell>
	);
}
