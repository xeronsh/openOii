import { ArrowDownTrayIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { Button } from "~/components/ui/Button";
import { getStaticUrl } from "~/services/api";
import type { Character, Shot } from "~/types";
import type { WorkbenchStatus } from "../state/deriveWorkbenchStatus";

interface MobileWorkbenchPreviewProps {
	projectId: number;
	workbenchStatus: WorkbenchStatus;
	/** 后端原始 video_url（未拼 base） */
	videoUrl: string | null;
	shots: Shot[];
	characters: Character[];
	/** failed/recoverable 时的重试通路（复用 onGenerate/onResume） */
	onRetry?: () => void;
	retryDisabled?: boolean;
}

const STATUS_DOT: Record<WorkbenchStatus["state"], string> = {
	idle: "bg-base-content/35",
	generating: "bg-warning animate-pulse",
	awaitingConfirm: "bg-info",
	recoverable: "bg-warning",
	cancelled: "bg-base-content/35",
	ready: "bg-success",
	superseded: "bg-warning",
	failed: "bg-error",
	blocked: "bg-error",
};

export function MobileWorkbenchPreview({
	projectId,
	workbenchStatus,
	videoUrl,
	shots,
	characters,
	onRetry,
	retryDisabled = false,
}: MobileWorkbenchPreviewProps) {
	const videoSrc = getStaticUrl(videoUrl);
	// 与桌面成片下载同源：后端 final-video 端点
	const downloadUrl =
		getStaticUrl(`/api/v1/projects/${projectId}/final-video`) ?? videoSrc;
	const canRetry =
		Boolean(onRetry) &&
		(workbenchStatus.state === "failed" ||
			workbenchStatus.state === "recoverable");
	const orderedShots = useMemo(
		() => [...shots].sort((a, b) => a.order - b.order),
		[shots],
	);

	return (
		<section
			className="flex shrink-0 flex-col gap-3 p-3"
			aria-label="项目预览"
			data-shell="mobile-workbench-preview"
		>
			<p className="m-0 text-2xs text-bc-muted">
				完整画布编辑请用桌面端打开
			</p>

			<div className="rounded-lg border-2 border-base-content/10 bg-base-100 p-3 shadow-brutal-sm">
				<div className="flex items-center gap-2">
					<span
						className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[workbenchStatus.state]}`}
						aria-hidden="true"
					/>
					<h2 className="m-0 font-heading text-sm font-bold">
						{workbenchStatus.label}
					</h2>
				</div>
				<p className="m-0 mt-1 text-xs text-bc-muted">
					{workbenchStatus.description}
				</p>
				{canRetry ? (
					<Button
						variant="primary"
						size="sm"
						className="mt-2 gap-1"
						onClick={onRetry}
						disabled={retryDisabled}
					>
						<ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
						重试失败阶段
					</Button>
				) : null}
			</div>

			{videoSrc ? (
				<div className="overflow-hidden rounded-lg border-2 border-base-content/10 bg-base-100 shadow-brutal-sm">
					{/* eslint-disable-next-line jsx-a11y/media-has-caption -- 成片无字幕轨 */}
					<video
						controls
						playsInline
						preload="metadata"
						src={videoSrc}
						className="aspect-video w-full bg-neutral object-contain"
						data-testid="mobile-final-video"
					/>
					<div className="flex items-center justify-between gap-2 p-2">
						<span className="font-mono text-2xs uppercase tracking-wide text-bc-muted">
							final cut
						</span>
						<a
							href={downloadUrl ?? undefined}
							download
							className="btn btn-sm btn-primary gap-1"
						>
							<ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
							下载成片
						</a>
					</div>
				</div>
			) : null}

			<div>
				<h2 className="m-0 mb-1.5 font-heading text-sm font-bold">
					分镜
					<span className="ml-1 font-mono text-2xs font-normal tabular-nums text-bc-muted">
						{orderedShots.length}
					</span>
				</h2>
				{orderedShots.length === 0 ? (
					<p className="m-0 text-xs text-bc-muted">
						还没有分镜，开始生成后会出现在这里
					</p>
				) : (
					<ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
						{orderedShots.map((shot) => {
							const imageUrl = getStaticUrl(shot.image_url);
							return (
								<li
									key={shot.id}
									className="relative aspect-square overflow-hidden rounded-md border-2 border-base-content/10 bg-base-200"
								>
									{imageUrl ? (
										<img
											src={imageUrl}
											alt={`分镜 ${shot.order}`}
											className="h-full w-full object-cover"
											loading="lazy"
										/>
									) : (
										<span className="flex h-full items-center justify-center text-2xs text-bc-muted">
											待生成
										</span>
									)}
									<span
										className="absolute left-1 top-1 rounded-full bg-neutral/80 px-1.5 font-mono text-2xs font-bold tabular-nums text-neutral-content"
										aria-hidden="true"
									>
										{shot.order}
									</span>
								</li>
							);
						})}
					</ul>
				)}
			</div>

			{characters.length > 0 ? (
				<div>
					<h2 className="m-0 mb-1.5 font-heading text-sm font-bold">
						角色
					</h2>
					<ul className="m-0 flex list-none gap-2 overflow-x-auto p-0 pb-1">
						{characters.map((character) => {
							const avatarUrl = getStaticUrl(
								character.approved_image_url ?? character.image_url,
							);
							return (
								<li
									key={character.id}
									className="flex w-14 shrink-0 flex-col items-center gap-1"
								>
									<span className="h-12 w-12 overflow-hidden rounded-full border-2 border-base-content/10 bg-base-200">
										{avatarUrl ? (
											<img
												src={avatarUrl}
												alt=""
												className="h-full w-full object-cover"
												loading="lazy"
											/>
										) : (
											<span
												className="flex h-full items-center justify-center font-heading text-sm font-bold text-bc-muted"
												aria-hidden="true"
											>
												{character.name?.slice(0, 1) || "?"}
											</span>
										)}
									</span>
									<span className="max-w-full truncate text-2xs font-semibold">
										{character.name}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
		</section>
	);
}
