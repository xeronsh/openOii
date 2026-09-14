import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "~/services/api";
import { Button } from "~/components/ui/Button";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { ConfirmModal } from "~/components/ui/ConfirmModal";
import { toast } from "~/utils/toast";
import { ApiError } from "~/types/errors";
import { cleanupDeletedProjectCaches } from "~/features/projects/deleteProject";

interface HistoryDrawerProps {
	open: boolean;
	onClose: () => void;
	onNavigate?: (projectId: number) => void;
}

function statusLabel(status: string) {
	const map: Record<string, string> = {
		draft: "草稿",
		processing: "生成中",
		completed: "已完成",
		error: "出错",
		ready: "就绪",
	};
	return map[status] || status;
}

function statusCls(status: string) {
	const map: Record<string, string> = {
		draft: "badge-ghost",
		processing: "badge-warning",
		completed: "badge-success",
		error: "badge-error",
		ready: "badge-ghost",
	};
	return map[status] || "badge-ghost";
}

function ProjectRow({
	project,
	isSelected,
	onToggle,
	onNavigate,
	renamingId,
	renameValue,
	onStartRename,
	onConfirmRename,
	onCancelRename,
	onRenameChange,
}: {
	project: { id: number; revision?: number; title: string | null; status: string; updated_at: string; style: string | null; target_shot_count: number | null };
	isSelected: boolean;
	onToggle: (checked: boolean) => void;
	onNavigate: () => void;
	renamingId: number | null;
	renameValue: string;
	onStartRename: () => void;
	onConfirmRename: () => void;
	onCancelRename: () => void;
	onRenameChange: (v: string) => void;
}) {
	const isRenaming = renamingId === project.id;

	return (
		<div
			className={`flex items-start gap-2 py-2 px-2 rounded transition-colors mb-0.5 ${
				isSelected ? "bg-primary/10" : "hover:bg-base-200/50"
			}`}
		>
			<label className="cursor-pointer pt-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
				<input
					type="checkbox"
					checked={isSelected}
					onChange={(e) => onToggle(e.target.checked)}
					className="checkbox checkbox-xs"
				/>
			</label>
			<div className="flex-1 min-w-0">
				{isRenaming ? (
					<div className="flex items-center gap-1">
						<input
							type="text"
							className="input input-bordered input-xs bg-base-100/80 flex-1 min-w-0 text-xs"
							value={renameValue}
							onChange={(e) => onRenameChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") onConfirmRename();
								if (e.key === "Escape") onCancelRename();
							}}
							autoFocus
						/>
						<button type="button" className="btn btn-xs btn-primary btn-sm" onClick={onConfirmRename}>
							<SvgIcon name="check" size={12} />
						</button>
						<button type="button" className="btn btn-xs btn-ghost btn-sm" onClick={onCancelRename}>
							<SvgIcon name="x" size={12} />
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={onNavigate}
						className="w-full text-left"
					>
						<div className="flex items-center gap-1.5 mb-0.5">
							<span className="text-sm font-bold truncate flex-1">{project.title || "未命名项目"}</span>
							<span className={`badge badge-xs ${statusCls(project.status)}`}>
								{statusLabel(project.status)}
							</span>
						</div>
						<div className="flex items-center gap-2 text-xs text-bc-muted">
							<span>{new Date(project.updated_at).toLocaleDateString("zh-CN")}</span>
							{project.style && <span>{project.style}</span>}
							{project.target_shot_count && <span>{project.target_shot_count} 镜头</span>}
						</div>
					</button>
				)}
			</div>
			{!isRenaming && (
				<button
					type="button"
					className="btn btn-xs btn-ghost btn-sm flex-shrink-0 mt-0.5"
					title="重命名"
					onClick={onStartRename}
				>
					<SvgIcon name="pencil" size={12} />
				</button>
			)}
		</div>
	);
}

export function HistoryDrawer({ open, onClose, onNavigate }: HistoryDrawerProps) {
	const queryClient = useQueryClient();
	const [selectedIds, setSelectedIds] = useState<number[]>([]);
	const [deleteTarget, setDeleteTarget] = useState<number[] | null>(null);
	const [renamingId, setRenamingId] = useState<number | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const { data: projects } = useQuery({
		queryKey: ["projects"],
		queryFn: () => projectsApi.list(),
		enabled: open,
	});

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
			const apiError = error instanceof ApiError ? error : null;
			toast.error({
				title: "删除失败",
				message: apiError?.message || error.message || "未知错误",
			});
		},
	});

	const renameMutation = useMutation({
		mutationFn: ({ id, revision, title }: { id: number; revision?: number; title: string }) =>
			projectsApi.update(id, { expected_revision: revision, title }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			setRenamingId(null);
			setRenameValue("");
		},
		onError: (error: Error | ApiError) => {
			const apiError = error instanceof ApiError ? error : null;
			toast.error({
				title: "重命名失败",
				message: apiError?.message || error.message || "未知错误",
			});
		},
	});

	const handleClick = useCallback((id: number) => {
		onNavigate?.(id);
		onClose();
	}, [onNavigate, onClose]);

	const handleToggleSelect = (id: number, checked: boolean) => {
		setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((i) => i !== id)));
	};

	const handleToggleSelectAll = (checked: boolean) => {
		if (!projects) return;
		setSelectedIds(checked ? projects.map((p) => p.id) : []);
	};

	const handleBatchDelete = () => {
		if (selectedIds.length === 0) return;
		setDeleteTarget([...selectedIds]);
	};

	const handleStartRename = (project: { id: number; title: string | null }) => {
		setRenamingId(project.id);
		setRenameValue(project.title || "");
	};

	const handleConfirmRename = () => {
		if (renamingId !== null && renameValue.trim()) {
			const row = projects?.find((item) => item.id === renamingId);
			renameMutation.mutate({ id: renamingId, revision: row?.revision, title: renameValue.trim() });
		}
	};

	const allSelected = Boolean(projects && projects.length > 0 && selectedIds.length === projects.length);
	const hasSelection = selectedIds.length > 0;

	return (
		<>
			{open && (
				<div
					className="fixed inset-0 z-modal-backdrop bg-neutral/40"
					onClick={onClose}
				/>
			)}
			<div
				className={`fixed right-0 top-0 z-modal h-full w-72 transform border-l-2 border-base-content/15 bg-base-100 shadow-brutal-sm transition-transform duration-normal ${open ? "translate-x-0" : "translate-x-full"}`}
			>
				<div className="flex items-center justify-between border-b-2 border-base-content/10 px-2.5 py-2">
					<div className="flex items-center gap-1.5">
						<SvgIcon name="clock-3" size={14} className="text-primary" />
						<h3 className="m-0 font-heading text-sm font-bold">
							项目历史
						</h3>
						<span className="badge badge-xs badge-ghost tabular-nums">
							{projects?.length ?? 0}
						</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="!h-7 !min-h-7 !px-1"
						onClick={onClose}
						aria-label="关闭项目历史"
					>
						<SvgIcon name="x" size={14} />
					</Button>
				</div>

				{projects && projects.length > 0 && (
					<div className="flex items-center gap-2 border-b border-base-content/10 px-2.5 py-1.5 text-2xs">
						<label className="flex cursor-pointer select-none items-center gap-1">
							<input
								type="checkbox"
								checked={allSelected}
								onChange={(e) => handleToggleSelectAll(e.target.checked)}
								className="checkbox checkbox-xs"
							/>
							<span className="text-bc-muted">全选</span>
						</label>
						{hasSelection && (
							<Button
								variant="ghost"
								size="sm"
								className="flex !h-6 !min-h-6 items-center gap-1 whitespace-nowrap !px-1.5 text-2xs text-error"
								onClick={handleBatchDelete}
							>
								<SvgIcon name="trash-2" size={12} />
								<span>删除 ({selectedIds.length})</span>
							</Button>
						)}
					</div>
				)}

				<div
					className="overflow-y-auto px-1.5 py-1"
					style={{
						height: `calc(100dvh - ${hasSelection || (projects && projects.length > 0) ? 88 : 48}px)`,
					}}
				>
					{!projects || projects.length === 0 ? (
						<div className="py-8 text-center text-xs text-bc-muted">
							<SvgIcon
								name="clapperboard"
								size={22}
								className="mx-auto mb-2 text-base-content/15"
							/>
							<p className="m-0">还没有项目</p>
							<p className="m-0 mt-1 text-bc-muted">
								创建新项目后会出现在这里
							</p>
						</div>
					) : (
						projects.map((p) => (
							<ProjectRow
								key={p.id}
								project={p}
								isSelected={selectedIds.includes(p.id)}
								onToggle={(checked) => handleToggleSelect(p.id, checked)}
								onNavigate={() => handleClick(p.id)}
								renamingId={renamingId}
								renameValue={renameValue}
								onStartRename={() => handleStartRename(p)}
								onConfirmRename={handleConfirmRename}
								onCancelRename={() => { setRenamingId(null); setRenameValue(""); }}
								onRenameChange={setRenameValue}
							/>
						))
					)}
				</div>
			</div>

			<ConfirmModal
				isOpen={deleteTarget !== null}
				onClose={() => setDeleteTarget(null)}
				onConfirm={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); }}
				title="删除项目"
				message={`确定要删除选中的${deleteTarget?.length ?? 0}个项目吗？删除后将无法恢复。`}
				confirmText="删除"
				cancelText="取消"
				variant="danger"
				isLoading={deleteMutation.isPending}
			/>
		</>
	);
}
