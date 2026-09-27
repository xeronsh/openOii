import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowPathIcon,
	DocumentTextIcon,
	FaceFrownIcon,
	FolderOpenIcon,
	PlusIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { TopBar } from "~/components/layout/TopBar";
import { Button } from "~/components/ui/Button";
import { EmptyState as SharedEmptyState } from "~/components/ui/EmptyState";
import { PageBody, PageShell } from "~/components/layout/PageShell";
import { PageContent, PageHeader } from "~/components/layout/PageHeader";
import { ConfirmModal } from "~/components/ui/ConfirmModal";
import { projectsApi } from "~/services/api";
import { cleanupDeletedProjectCaches } from "~/features/projects/deleteProject";
import { toast } from "~/utils/toast";
import { ApiError } from "~/types/errors";
import type { Project } from "~/types";
import { getProjectStatusMeta } from "~/features/projects/statusMeta";


function formatDate(value: string | null | undefined) {
	if (!value) return "未知";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "未知";
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function errorMessage(error: unknown, fallback: string) {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

export function ProjectsPage() {
	const queryClient = useQueryClient();
	const [deleteTarget, setDeleteTarget] = useState<number[] | null>(null);
	const [selectedIds, setSelectedIds] = useState<number[]>([]);

	const {
		data: projects,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["projects"],
		queryFn: projectsApi.list,
		retry: 1,
	});

	const visibleProjects = projects ?? [];
	const completedCount = useMemo(
		() => visibleProjects.filter((project) => project.status === "ready").length,
		[visibleProjects],
	);
	const selectedCount = selectedIds.length;
	const allSelected =
		visibleProjects.length > 0 && selectedCount === visibleProjects.length;

	useEffect(() => {
		if (!error) return;
		toast.error({
			title: "加载项目列表失败",
			message: errorMessage(error, "无法获取项目列表"),
			actions: [
				{
					label: "重试",
					onClick: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
				},
			],
		});
	}, [error, queryClient]);

	useEffect(() => {
		if (!projects) return;
		const ids = new Set(projects.map((project) => project.id));
		setSelectedIds((current) => current.filter((id) => ids.has(id)));
	}, [projects]);

	const deleteMutation = useMutation({
		mutationFn: (ids: number[]) => projectsApi.deleteMany(ids),
		onSuccess: (_, deletedIds) => {
			cleanupDeletedProjectCaches(queryClient, deletedIds);
			setSelectedIds((prev) => prev.filter((id) => !deletedIds.includes(id)));
			setDeleteTarget(null);
			toast.success({
				title: "删除成功",
				message: deletedIds.length > 1 ? "项目已批量删除" : "项目已删除",
			});
		},
		onError: (error: Error | ApiError) => {
			toast.error({
				title: "删除失败",
				message: errorMessage(error, "未知错误"),
			});
		},
	});

	const handleDeleteClick = (id: number) => {
		if (deleteMutation.isPending) return;
		setDeleteTarget([id]);
	};

	const handleBatchDeleteClick = () => {
		if (deleteMutation.isPending || selectedCount === 0) return;
		setDeleteTarget([...selectedIds]);
	};

	const handleToggleSelect = (projectId: number, checked: boolean) => {
		setSelectedIds((prev) =>
			checked
				? Array.from(new Set([...prev, projectId]))
				: prev.filter((id) => id !== projectId),
		);
	};

	const handleToggleSelectAll = (checked: boolean) => {
		setSelectedIds(checked ? visibleProjects.map((project) => project.id) : []);
	};

	const handleConfirmDelete = () => {
		if (deleteTarget && deleteTarget.length > 0) {
			deleteMutation.mutate(deleteTarget);
		}
	};

	return (
		<PageShell className="text-ink" data-shell="projects-list">
			<TopBar />

			<PageBody className="workbench-surface">
				<PageContent className="gap-4 sm:gap-5 sm:py-5">
				<PageHeader
					eyebrow="openoii / library / projects"
					title="项目库"
					description="继续制作中的故事，或从新想法开始一部漫剧。"
					actions={
						<>
							<div className="grid grid-cols-3 gap-1.5">
								<Metric label="全部" value={visibleProjects.length} />
								<Metric label="成片" value={completedCount} />
								<Metric label="已选" value={selectedCount} />
							</div>
							<Link to="/">
								<Button size="sm">
									<PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
									新建
								</Button>
							</Link>
						</>
					}
				/>

				<section
					className="border-y-2 border-ink/15 bg-paper-100/85 shadow-brutal-sm"
					aria-label="项目批量操作"
				>
					<div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:justify-between">
						<label className="touch-target-dense flex cursor-pointer select-none items-center gap-2 px-1.5 text-xs font-semibold text-ink-muted">
							<input
								type="checkbox"
								checked={allSelected}
								onChange={(event) => handleToggleSelectAll(event.target.checked)}
								disabled={visibleProjects.length === 0}
								className="checkbox checkbox-sm"
							/>
							<span>全选</span>
						</label>
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="border border-ink/15 bg-paper-100 px-2 py-0.5 text-2xs font-semibold tabular-nums text-ink-muted">
								{selectedCount > 0
									? `已选 ${selectedCount}`
									: "未选择"}
							</span>
							<button
								type="button"
								className="btn-doodle bg-error text-error-content touch-target-dense h-8 gap-1 px-2 text-sm"
								onClick={handleBatchDeleteClick}
								disabled={selectedCount === 0 || deleteMutation.isPending}
							>
								<TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
								批量删除（{selectedCount}）
							</button>
						</div>
					</div>
				</section>

				<section className="min-h-0 flex-1" aria-label="项目列表">
					{isLoading ? (
						<LoadingState />
					) : error ? (
						<ErrorState />
					) : visibleProjects.length === 0 ? (
						<EmptyState />
					) : (
						<div className="overflow-hidden border-y-2 border-ink/15 bg-paper-100 shadow-brutal-sm">
							{/* 表头只服务 sm+ 的表格网格；<sm 是卡片式行，表头隐藏 */}
							<div className="hidden border-b border-ink/10 bg-paper-200/70 py-1.5 font-mono text-2xs uppercase text-ink-muted sm:grid sm:grid-cols-[2.75rem_minmax(0,1fr)_7rem_7rem_2.75rem] sm:gap-3 sm:px-3">
								<span />
								<span>项目</span>
								<span>状态</span>
								<span>更新</span>
								<span className="text-right">操作</span>
							</div>
							<div className="divide-y divide-ink/10">
								{visibleProjects.map((project) => (
									<ProjectRow
										key={project.id}
										project={project}
										selected={selectedIds.includes(project.id)}
										onSelectedChange={(checked) =>
											handleToggleSelect(project.id, checked)
										}
										onDelete={() => handleDeleteClick(project.id)}
									/>
								))}
							</div>
						</div>
					)}
				</section>
				</PageContent>
			</PageBody>

			<ConfirmModal
				isOpen={deleteTarget !== null}
				onClose={() => setDeleteTarget(null)}
				onConfirm={handleConfirmDelete}
				title="删除项目"
				message={`确定要删除选中的${deleteTarget ? deleteTarget.length : 0}个项目吗？删除后将无法恢复。`}
				confirmText="删除"
				cancelText="取消"
				variant="danger"
				isLoading={deleteMutation.isPending}
			/>
		</PageShell>
	);
}

function Metric({ label, value }: { label: string; value: number }) {
	return (
		<div className="border-l-2 border-primary bg-paper-200 px-2 py-1.5">
			<p className="m-0 font-mono text-2xs uppercase text-ink-muted">
				{label}
			</p>
			<p className="m-0 font-heading text-md font-bold leading-none tabular-nums">
				{value}
			</p>
		</div>
	);
}

function ProjectRow({
	project,
	selected,
	onSelectedChange,
	onDelete,
}: {
	project: Project;
	selected: boolean;
	onSelectedChange: (checked: boolean) => void;
	onDelete: () => void;
}) {
	const status = getProjectStatusMeta(project.status);
	const story = project.story?.trim();

	return (
		// <sm 卡片式三列（勾选｜内容｜删除，状态行落到第二行）；sm+ 维持五列表格网格
		<article className="grid min-h-20 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-2 py-3 transition-colors duration-fast hover:bg-paper-200/55 sm:grid-cols-[2.75rem_minmax(0,1fr)_7rem_7rem_2.75rem] sm:items-center sm:gap-3 sm:px-3 sm:py-4">
			<label className="touch-target-dense flex cursor-pointer items-center justify-center rounded-md hover:bg-paper-200">
				<input
					type="checkbox"
					aria-label={`选择项目 ${project.title}`}
					checked={selected}
					onChange={(event) => onSelectedChange(event.target.checked)}
					className="checkbox checkbox-sm"
				/>
			</label>

			<Link
				to={`/project/${project.id}`}
				className="min-w-0 py-0.5 pr-2"
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<FolderOpenIcon
						className="h-3.5 w-3.5 shrink-0 text-primary"
						aria-hidden="true"
					/>
					{/* <sm 标题完整换行展示，sm+ 才单行截断 */}
					<h2 className="m-0 break-words font-heading text-sm font-bold sm:truncate">
						{project.title}
					</h2>
				</div>
				<p className="m-0 mt-0.5 truncate text-xs text-ink-muted">
					{story || "尚未填写故事内容"}
				</p>
				<div className="mt-1 flex flex-wrap gap-1.5 text-2xs font-semibold text-ink-muted">
					<span>{project.style || "未设风格"}</span>
					<span className="tabular-nums">
						{project.target_shot_count ?? "自动"} 镜头
					</span>
					{project.creation_mode ? (
						<span>{project.creation_mode === "quick" ? "YOLO 模式" : project.creation_mode === "review" ? "交互模式" : project.creation_mode}</span>
					) : null}
				</div>
			</Link>

			{/* <sm 状态胶囊+时间戳合并为一行小字；sm+ 用 contents 还原为两个独立网格单元 */}
			<div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:contents">
				<span
					className={`inline-flex min-h-7 items-center justify-center rounded-full border px-2 text-2xs font-bold ${status.badgeCls}`}
				>
					{status.label}
				</span>

				<span className="font-mono text-2xs tabular-nums text-ink-muted">
					{formatDate(project.updated_at)}
				</span>
			</div>

			<button
				type="button"
				className="btn-doodle bg-transparent border-transparent shadow-none hover:bg-paper-200 hover:shadow-brutal-sm touch-target-dense col-start-3 row-start-1 h-8 min-h-8 w-8 justify-self-end p-0 text-error hover:bg-error/10 sm:col-auto sm:row-auto"
				onClick={onDelete}
				aria-label={`删除项目 ${project.title}`}
				title="删除"
			>
				<TrashIcon className="h-4 w-4" aria-hidden="true" />
			</button>
		</article>
	);
}

function LoadingState() {
	return (
		<div className="flex min-h-[10rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-ink/15 bg-paper-200/35">
			<ArrowPathIcon
				className="h-5 w-5 animate-spin text-primary"
				aria-hidden="true"
			/>
			<p className="m-0 text-sm font-semibold text-ink-muted">
				正在加载项目…
			</p>
		</div>
	);
}

function ErrorState() {
	return (
		<div className="flex min-h-[10rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-error/25 bg-error/5 px-3 text-center">
			<FaceFrownIcon className="h-6 w-6 text-error" aria-hidden="true" />
			<div>
				<p className="m-0 font-heading text-md font-bold text-error">
					加载失败，请重试
				</p>
				<p className="m-0 mt-0.5 text-xs text-ink-muted">
					刷新页面或检查后端是否可用
				</p>
			</div>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="min-h-[10rem] rounded-lg border-2 border-dashed border-ink/15 bg-paper-200/35">
			<SharedEmptyState
				icon={<DocumentTextIcon className="h-5 w-5" aria-hidden="true" />}
				title="暂无项目"
				description="开始创作你的第一个故事"
				action={
					<Link to="/">
						<Button size="sm">
							<PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
							新建项目
						</Button>
					</Link>
				}
			/>
		</div>
	);
}
