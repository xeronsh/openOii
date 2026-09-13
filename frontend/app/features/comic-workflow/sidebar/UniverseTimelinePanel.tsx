import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { universesApi } from "~/services/api";
import { EmptyState } from "~/components/ui/EmptyState";
import { toast } from "~/utils/toast";

interface UniverseTimelinePanelProps {
	universeId: number;
	currentProjectId: number;
}

export function UniverseTimelinePanel({
	universeId,
	currentProjectId,
}: UniverseTimelinePanelProps) {
	const queryClient = useQueryClient();
	const { data, isLoading, isError } = useQuery({
		queryKey: ["universe-timeline", universeId, currentProjectId],
		queryFn: () => universesApi.timeline(universeId, currentProjectId),
		staleTime: 15_000,
	});

	const importCastMutation = useMutation({
		mutationFn: () => universesApi.importSharedCast(currentProjectId),
		onSuccess: (result) => {
			queryClient.invalidateQueries({
				queryKey: ["characters", currentProjectId],
			});
			queryClient.invalidateQueries({
				queryKey: ["universe-timeline", universeId, currentProjectId],
			});
			if (result.imported_count === 0) {
				toast.info({
					title: "卡司已齐全",
					message:
						result.skipped_existing > 0
							? `本项目已有 ${result.skipped_existing} 个共享角色，无需再导入`
							: "宇宙暂无共享角色可导入",
				});
				return;
			}
			toast.success({
				title: "已导入共享卡司",
				message: `新增 ${result.imported_count} 人${
					result.skipped_existing
						? `，跳过已存在 ${result.skipped_existing}`
						: ""
				}`,
			});
		},
		onError: (error: Error) => {
			toast.error({
				title: "导入失败",
				message: error.message || "请稍后重试",
			});
		},
	});

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center p-3">
				<span className="loading loading-spinner loading-sm text-primary" />
			</div>
		);
	}

	if (isError || !data) {
		return (
			<EmptyState
				compact
				title="无法加载时间线"
				description="稍后重试，或检查宇宙是否仍可用"
				className="h-full"
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col" data-shell="universe-timeline">
			<div className="shrink-0 border-b border-base-content/10 px-2 py-1.5">
				<p className="m-0 font-mono text-2xs uppercase tracking-wide text-bc-muted">
					universe
				</p>
				<div className="mt-0.5 flex items-center gap-1.5">
					<GlobeAltIcon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
					<h3 className="m-0 truncate font-heading text-sm font-bold">
						{data.universe_name}
					</h3>
				</div>
				<p className="m-0 mt-0.5 text-2xs text-bc-muted">
					跨章节时间线 · {data.shared_character_count} 共享角色
				</p>
				{data.world_setting ? (
					<p className="m-0 mt-1 line-clamp-2 text-2xs text-bc-muted">
						{data.world_setting}
					</p>
				) : null}
				<button
					type="button"
					className="btn btn-primary btn-xs mt-2 h-7 min-h-7 w-full"
					disabled={
						importCastMutation.isPending || data.shared_character_count === 0
					}
					onClick={() => importCastMutation.mutate()}
				>
					{importCastMutation.isPending
						? "导入中…"
						: `沿用共享卡司到本章（${data.shared_character_count}）`}
				</button>
			</div>

			<ul className="m-0 min-h-0 flex-1 list-none space-y-1 overflow-y-auto overscroll-contain p-2">
				{data.chapters.map((ch) => (
					<li key={ch.project_id}>
						<Link
							to={`/project/${ch.project_id}`}
							className={`block rounded-md border px-2 py-1.5 transition-colors ${
								ch.is_current
									? "border-primary/40 bg-primary/10"
									: "border-base-content/10 bg-base-200/40 hover:border-primary/30"
							}`}
						>
							<div className="flex items-center justify-between gap-1">
								<span className="inline-flex items-center gap-1 font-mono text-2xs font-bold text-primary-ink">
									{ch.chapter_number != null ? (
										`第${ch.chapter_number}章`
									) : (
										<span className="badge badge-ghost badge-xs font-normal">
											未编号
										</span>
									)}
									{ch.is_current ? " · 当前" : ""}
								</span>
								<span className="font-mono text-2xs text-bc-muted">
									{ch.shot_count}格 · {ch.character_count}角
									{ch.has_video ? " · 成片" : ""}
								</span>
							</div>
							<p className="m-0 mt-0.5 truncate font-heading text-xs font-bold">
								{ch.chapter_title || ch.title}
							</p>
							{ch.summary ? (
								<p className="m-0 mt-0.5 line-clamp-2 text-2xs text-bc-muted">
									{ch.summary}
								</p>
							) : (
								<p className="m-0 mt-0.5 text-2xs text-bc-muted">
									{ch.status}
								</p>
							)}
						</Link>
					</li>
				))}
			</ul>

			<div className="shrink-0 border-t border-base-content/10 p-2">
				<Link
					to={`/universes/${universeId}`}
					className="btn btn-ghost btn-xs h-7 min-h-7 w-full"
				>
					打开宇宙管理
				</Link>
			</div>
		</div>
	);
}
