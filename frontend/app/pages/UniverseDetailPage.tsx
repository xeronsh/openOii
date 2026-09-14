import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { universesApi } from "~/services/api";
import { SharedCharacterCard } from "~/components/universe/SharedCharacterCard";
import { EmptyState } from "~/components/ui/EmptyState";
import { DeskSection } from "~/components/layout/DeskSection";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Modal } from "~/components/ui/Modal";
import {
	PlusIcon,
	BookOpenIcon,
	TrashIcon,
	GlobeAltIcon,
	PaintBrushIcon,
	UserGroupIcon,
	PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { toast } from "~/utils/toast";
import { ApiError } from "~/types/errors";
import type { SharedCharacterRead, UniverseDetail } from "~/types";
import { PageBody, PageShell } from "~/components/layout/PageShell";
import { PageContent, PageHeader } from "~/components/layout/PageHeader";
import { TopBar } from "~/components/layout/TopBar";

export function UniverseDetailPage() {
	const { universeId } = useParams<{ universeId: string }>();
	const queryClient = useQueryClient();
	const id = Number(universeId);
	const [editOpen, setEditOpen] = useState(false);
	const [createCharOpen, setCreateCharOpen] = useState(false);
	const [importProjectId, setImportProjectId] = useState("");
	const [editForm, setEditForm] = useState({
		name: "",
		description: "",
		world_setting: "",
		style_rules: "",
	});
	const [charForm, setCharForm] = useState({
		name: "",
		description: "",
		visual_notes: "",
		character_tags: "",
	});

	const { data: universe, isLoading, isError, error } = useQuery({
		queryKey: ["universe", id],
		queryFn: () => universesApi.get(id),
		enabled: !isNaN(id),
	});

	const removeProjectMutation = useMutation({
		mutationFn: (projectId: number) =>
			universesApi.removeProject(id, projectId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["universe", id] });
			queryClient.invalidateQueries({ queryKey: ["universes"] });
			toast.success({ title: "已移除", message: "项目已从宇宙移除" });
		},
	});

	const updateMutation = useMutation({
		mutationFn: () =>
			universesApi.update(id, {
				name: editForm.name.trim() || null,
				description: editForm.description || null,
				world_setting: editForm.world_setting || null,
				style_rules: editForm.style_rules || null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["universe", id] });
			queryClient.invalidateQueries({ queryKey: ["universes"] });
			setEditOpen(false);
			toast.success({ title: "已保存", message: "宇宙设定已更新" });
		},
		onError: (error: Error) => {
			toast.error({ title: "保存失败", message: error.message });
		},
	});

	const createCharMutation = useMutation({
		mutationFn: () =>
			universesApi.createSharedCharacter(id, {
				name: charForm.name.trim(),
				description: charForm.description || null,
				visual_notes: charForm.visual_notes || null,
				character_tags: charForm.character_tags || null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["universe", id] });
			setCreateCharOpen(false);
			setCharForm({
				name: "",
				description: "",
				visual_notes: "",
				character_tags: "",
			});
			toast.success({ title: "已创建", message: "共享角色已加入宇宙库" });
		},
		onError: (error: Error) => {
			toast.error({ title: "创建失败", message: error.message });
		},
	});

	const importMutation = useMutation({
		mutationFn: ({
			projectId,
			sharedId,
		}: {
			projectId: number;
			sharedId: number;
		}) => universesApi.importCharacter(projectId, sharedId),
		onSuccess: (char) => {
			toast.success({
				title: "已导入角色",
				message: `角色「${char.name}」已写入目标章节`,
			});
			queryClient.invalidateQueries({
				queryKey: ["characters", char.project_id],
			});
		},
		onError: (error: Error) => {
			toast.error({ title: "导入失败", message: error.message });
		},
	});

	if (isLoading) {
		return (
			<PageShell data-shell="universe-detail-loading">
				<TopBar />
				<div className="flex flex-1 items-center justify-center">
					<span className="loading loading-spinner loading-md text-primary" aria-label="加载中" />
				</div>
			</PageShell>
		);
	}

	// 「宇宙不存在」只对应 404；其余失败是服务故障，给重试入口
	const isNotFound =
		isNaN(id) || (isError && error instanceof ApiError && error.status === 404);

	if (isNotFound) {
		return (
			<PageShell data-shell="universe-detail-missing">
				<TopBar />
				<div className="flex flex-1 flex-col items-center justify-center gap-3">
					<p className="m-0 text-sm text-bc-muted">宇宙不存在</p>
					<Link to="/universes">
						<Button size="sm" variant="secondary">返回宇宙列表</Button>
					</Link>
				</div>
			</PageShell>
		);
	}

	if (isError || !universe) {
		return (
			<PageShell data-shell="universe-detail-error">
				<TopBar />
				<div className="flex flex-1 items-center justify-center p-4">
					<div className="flex min-h-[10rem] w-full max-w-md flex-col items-center justify-center gap-3 rounded-lg border-2 border-error/25 bg-error/5 px-4 text-center">
						<div>
							<p className="m-0 font-heading text-md font-bold text-error">
								宇宙加载失败
							</p>
							<p className="m-0 mt-0.5 text-xs text-bc-muted">
								服务暂时不可用，数据还在，稍后重试
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								size="sm"
								onClick={() =>
									queryClient.invalidateQueries({ queryKey: ["universe", id] })
								}
							>
								重试
							</Button>
							<Link to="/universes">
								<Button size="sm" variant="ghost">返回宇宙列表</Button>
							</Link>
						</div>
					</div>
				</div>
			</PageShell>
		);
	}

	const u = universe as UniverseDetail;
	const nextChapterNumber =
		u.chapters.length > 0
			? Math.max(...u.chapters.map((chapter) => chapter.chapter_number ?? 0)) + 1
			: 1;
	const createChapterHref = `/?universeId=${u.id}&chapterNumber=${nextChapterNumber}`;
	const defaultImportProjectId =
		u.chapters[0]?.project_id != null ? String(u.chapters[0].project_id) : "";

	const openEdit = () => {
		setEditForm({
			name: u.name,
			description: u.description || "",
			world_setting: u.world_setting || "",
			style_rules: u.style_rules || "",
		});
		setEditOpen(true);
	};

	const handleImport = (character: SharedCharacterRead) => {
		const projectId = Number(importProjectId || defaultImportProjectId);
		if (!Number.isFinite(projectId) || projectId <= 0) {
			toast.error({
				title: "请选择章节",
				message: "先在「导入到」下拉框选择目标章节",
			});
			return;
		}
		importMutation.mutate({ projectId, sharedId: character.id });
	};

	const chapterOptionLabel = (ch: (typeof u.chapters)[number]) =>
		`${ch.chapter_number != null ? `第${ch.chapter_number}章` : "未编号"} · ${
			ch.chapter_title || ch.project_title || "未命名"
		}`;

	return (
		<PageShell data-shell="universe-detail">
			<TopBar />

			<PageBody>
				<PageContent>
				<PageHeader
					eyebrow="universe detail"
					title={u.name}
					description={
						u.description ||
						"尚未填写简介 · 可在右侧编辑设定"
					}
					meta={`${u.chapters.length} 章节 · ${u.shared_characters.length} 角色`}
					actions={
						<>
							<Link
								to="/universes"
								className="btn btn-ghost btn-sm touch-target-dense h-8 min-h-8"
							>
								← 列表
							</Link>
							<Button size="sm" variant="ghost" onClick={openEdit}>
								<PencilSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
								编辑
							</Button>
							<Link to={createChapterHref}>
								<Button size="sm">
									<PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
									新建章节
								</Button>
							</Link>
						</>
					}
				/>


				{u.world_setting || u.style_rules ? (
					<div
						className={clsx(
							"grid gap-5",
							// 两段设定并存时桌面端并排，避免全宽长行难读
							u.world_setting && u.style_rules && "lg:grid-cols-2",
						)}
					>
						{u.world_setting ? (
							<DeskSection
								title="世界观设定"
								icon={<GlobeAltIcon className="h-4 w-4" aria-hidden="true" />}
							>
								<p className="m-0 whitespace-pre-wrap text-sm text-bc-muted">
									{u.world_setting}
								</p>
							</DeskSection>
						) : null}

						{u.style_rules ? (
							<DeskSection
								title="统一风格规则"
								icon={<PaintBrushIcon className="h-4 w-4" aria-hidden="true" />}
							>
								<p className="m-0 whitespace-pre-wrap text-sm text-bc-muted">
									{u.style_rules}
								</p>
							</DeskSection>
						) : null}
					</div>
				) : null}

				{/* 桌面端双栏：章节列表 7fr | 共享角色库 5fr；<lg 回落单列堆叠 */}
				<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
					<DeskSection
						title="章节列表"
						icon={<BookOpenIcon className="h-4 w-4" aria-hidden="true" />}
						meta={`${u.chapters.length} 章节`}
					>
						{u.chapters.length === 0 ? (
							<EmptyState
								compact
								title="还没有章节"
								description="章节是宇宙里的一部作品，创建后进入画布开始生成"
								action={
									<Link to={createChapterHref}>
										<Button size="sm">新建章节</Button>
									</Link>
								}
							/>
						) : (
							<div className="flex flex-col gap-2">
								{[...u.chapters]
									.sort(
										(a, b) =>
											(a.chapter_number ?? 999) - (b.chapter_number ?? 999),
									)
									.map((ch) => (
										<div
											key={ch.id}
											className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-base-content/10 bg-base-200/50 px-2 py-1.5 transition-colors duration-fast hover:bg-base-200"
										>
											<div className="flex min-w-0 items-center gap-2">
												{ch.chapter_number != null ? (
													<span className="badge badge-primary badge-sm shrink-0 font-bold tabular-nums">
														第{ch.chapter_number}章
													</span>
												) : (
													<span className="badge badge-ghost badge-sm shrink-0">
														未编号
													</span>
												)}
												<Link
													to={`/project/${ch.project_id}`}
													className="truncate font-heading text-sm font-bold transition-colors hover:text-primary-ink"
												>
													{ch.chapter_title || ch.project_title || "未命名"}
												</Link>
												<span className="font-mono text-2xs text-bc-muted">
													#{ch.project_id}
												</span>
												{!ch.is_main_story ? (
													<span className="badge badge-ghost badge-xs shrink-0">
														外传
													</span>
												) : null}
											</div>
											<button
												type="button"
												className="btn btn-ghost btn-xs h-7 min-h-7 text-error/50 hover:text-error"
												aria-label={`从宇宙移除${ch.chapter_title || ch.project_title || "未命名项目"}`}
												title="从宇宙移除"
												onClick={() =>
													removeProjectMutation.mutate(ch.project_id)
												}
											>
												<TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
											</button>
										</div>
									))}
							</div>
						)}
					</DeskSection>

					<DeskSection
						title="共享角色库"
						icon={<UserGroupIcon className="h-4 w-4" aria-hidden="true" />}
						meta={`${u.shared_characters.length} 个`}
						actions={
							<>
								<label className="flex items-center gap-1 text-2xs text-bc-muted">
									导入到
									<select
										className="select select-bordered select-xs h-7 max-w-40 bg-base-200"
										value={importProjectId || defaultImportProjectId}
										onChange={(e) => setImportProjectId(e.target.value)}
										disabled={u.chapters.length === 0}
										aria-label="导入到章节"
										title={
											u.chapters.length === 0
												? "先创建章节，才能把共享角色导入进去"
												: undefined
										}
									>
										{u.chapters.length === 0 ? (
											<option value="">暂无章节可导入</option>
										) : (
											u.chapters.map((ch) => (
												<option key={ch.project_id} value={String(ch.project_id)}>
													{chapterOptionLabel(ch)}
												</option>
											))
										)}
									</select>
								</label>
								<Button size="sm" onClick={() => setCreateCharOpen(true)}>
									+ 手动创建
								</Button>
							</>
						}
					>
						{u.shared_characters.length === 0 ? (
							<EmptyState
								compact
								title="还没有共享角色"
								description="可在章节工作台把角色「提升到宇宙」，或在此手动创建"
								action={
									<Button size="sm" onClick={() => setCreateCharOpen(true)}>
										手动创建
									</Button>
								}
							/>
						) : (
							// lg 下坐在 5fr 窄栏里，收窄为两列
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
								{u.shared_characters.map((sc) => (
									<SharedCharacterCard
										key={sc.id}
										character={sc}
										showImport={u.chapters.length > 0}
										onImport={handleImport}
									/>
								))}
							</div>
						)}
					</DeskSection>
				</div>
				</PageContent>
			</PageBody>

			<Modal
				isOpen={editOpen}
				onClose={() => setEditOpen(false)}
				title="编辑宇宙设定"
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setEditOpen(false)}
						>
							取消
						</Button>
						<Button
							size="sm"
							loading={updateMutation.isPending}
							onClick={() => updateMutation.mutate()}
							disabled={!editForm.name.trim()}
						>
							保存
						</Button>
					</>
				}
			>
				<div className="space-y-3">
					<Input
						label="名称"
						value={editForm.name}
						onChange={(e) =>
							setEditForm((s) => ({ ...s, name: e.target.value }))
						}
					/>
					<label className="form-control">
						<span className="label-text text-xs font-medium">简介</span>
						<textarea
							className="textarea textarea-bordered textarea-sm min-h-16"
							value={editForm.description}
							onChange={(e) =>
								setEditForm((s) => ({ ...s, description: e.target.value }))
							}
						/>
					</label>
					<label className="form-control">
						<span className="label-text text-xs font-medium">世界观</span>
						<textarea
							className="textarea textarea-bordered textarea-sm min-h-20"
							value={editForm.world_setting}
							onChange={(e) =>
								setEditForm((s) => ({ ...s, world_setting: e.target.value }))
							}
						/>
					</label>
					<label className="form-control">
						<span className="label-text text-xs font-medium">风格规则</span>
						<textarea
							className="textarea textarea-bordered textarea-sm min-h-16"
							value={editForm.style_rules}
							onChange={(e) =>
								setEditForm((s) => ({ ...s, style_rules: e.target.value }))
							}
						/>
					</label>
				</div>
			</Modal>

			<Modal
				isOpen={createCharOpen}
				onClose={() => setCreateCharOpen(false)}
				title="手动创建共享角色"
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCreateCharOpen(false)}
						>
							取消
						</Button>
						<Button
							size="sm"
							loading={createCharMutation.isPending}
							disabled={!charForm.name.trim()}
							onClick={() => createCharMutation.mutate()}
						>
							创建
						</Button>
					</>
				}
			>
				<div className="space-y-3">
					<Input
						label="名称"
						value={charForm.name}
						onChange={(e) =>
							setCharForm((s) => ({ ...s, name: e.target.value }))
						}
					/>
					<label className="form-control">
						<span className="label-text text-xs font-medium">描述</span>
						<textarea
							className="textarea textarea-bordered textarea-sm min-h-16"
							value={charForm.description}
							onChange={(e) =>
								setCharForm((s) => ({ ...s, description: e.target.value }))
							}
						/>
					</label>
					<label className="form-control">
						<span className="label-text text-xs font-medium">视觉笔记</span>
						<textarea
							className="textarea textarea-bordered textarea-sm min-h-16"
							value={charForm.visual_notes}
							onChange={(e) =>
								setCharForm((s) => ({ ...s, visual_notes: e.target.value }))
							}
						/>
					</label>
					<Input
						label="标签（逗号分隔）"
						value={charForm.character_tags}
						onChange={(e) =>
							setCharForm((s) => ({ ...s, character_tags: e.target.value }))
						}
					/>
				</div>
			</Modal>
		</PageShell>
	);
}
