import { MEDIA, imageReady, videoReady } from "~/components/ui/media";
import { useMemo, type ReactNode } from "react";
import { getStaticUrl } from "~/services/api";
import type { Character, Shot } from "~/types";
import { type StudioStatus, studioStatusDotClass, studioStatusText } from "../state/deriveStudioStatus";
import { WORKFLOW_STEPS } from "~/utils/workflowSteps";
import "~/components/ui/icons/workbenchIcons";

/** 六步进度：做完的实心，当前一步品牌色，后面的留空（移动端也看得到走到哪了） */
function StepMeter({ current }: { current: number }) {
	return (
		<ol className="m-0 mt-2 flex list-none gap-1 p-0" aria-label={`第 ${current + 1} 步，共 ${WORKFLOW_STEPS.length} 步`}>
			{WORKFLOW_STEPS.map((step, index) => (
				<li
					key={step.key}
					title={step.label}
					className={`h-1 flex-1 rounded-full ${index < current ? "bg-ink/35" : index === current ? "bg-primary" : "bg-paper-300"}`}
				/>
			))}
		</ol>
	);
}
import { SvgIcon } from "~/components/ui/SvgIcon";

interface MobileWorkbenchPreviewProps {
	projectId: number;
	studioStatus: StudioStatus;
	/** 后端原始 video_url（未拼 base） */
	videoUrl: string | null;
	shots: Shot[];
	characters: Character[];
	/** 待处理卡片（确认 / 继续 / 重试都在这里，紧跟状态头）。 */
	inbox?: ReactNode;
	/** 最近动态（页面最底部）。 */
	activity?: ReactNode;
	/** 项目助手对话；没有对话时组件自己不渲染 */
	chat?: ReactNode;
	/** 状态卡唯一的操作（生成中是「停止」）；闸门、恢复的按钮在待处理卡里 */
	primaryAction?: ReactNode;
	/** 运行中的计时条（本步 / 共 / 剩余约 · 完成后通知我） */
	timing?: ReactNode;
}

export function MobileWorkbenchPreview({
	projectId,
	studioStatus,
	videoUrl,
	shots,
	characters,
	inbox,
	activity,
	chat,
	primaryAction,
	timing,
}: MobileWorkbenchPreviewProps) {
	const videoSrc = getStaticUrl(videoUrl);
	// 与桌面成片下载同源：后端 final-video 端点
	const downloadUrl =
		getStaticUrl(`/api/v1/projects/${projectId}/final-video`) ?? videoSrc;
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
			<div className="rounded-lg border border-line bg-paper-100 p-3">
				<div className="flex items-center gap-2">
					<span
						className={`h-2.5 w-2.5 shrink-0 rounded-full ${studioStatusDotClass(studioStatus)}`}
						aria-hidden="true"
					/>
					<h2 className="m-0 min-w-0 flex-1 text-sm font-bold">
						{studioStatusText(studioStatus)}
					</h2>
					{primaryAction ? <div className="shrink-0">{primaryAction}</div> : null}
				</div>
				<p className="m-0 mt-1 text-xs text-ink-muted">
					{studioStatus.description}
				</p>
				{studioStatus.step ? <StepMeter current={studioStatus.step.index} /> : null}
				{timing ?? null}
			</div>

			{inbox ? (
				// InboxPanel 自带 p-3 与卡片边框：抵消外边距，与其它区块对齐
				<div className="-mx-3 -my-3">{inbox}</div>
			) : null}

			{videoSrc ? (
				<div className="overflow-hidden rounded-lg border border-line bg-paper-100">
					{/* eslint-disable-next-line jsx-a11y/media-has-caption -- 成片无字幕轨 */}
					<video
						controls
						playsInline
						preload="metadata"
						src={videoSrc}
						className={`${MEDIA} aspect-video w-full object-contain`}
						{...videoReady}
						data-testid="mobile-final-video"
					/>
					<div className="flex items-center justify-between gap-2 p-2">
						<span className="text-xs font-semibold text-ink-muted">成片</span>
						<a
							href={downloadUrl ?? undefined}
							download
							target="_blank"
							rel="noopener"
							className="btn-doodle inline-flex items-center justify-center gap-1 bg-primary px-2.5 py-1 text-sm text-primary-content hover:bg-primary-hover active:bg-primary-pressed"
						>
							<SvgIcon name="download" size={14} />
							下载成片
						</a>
					</div>
				</div>
			) : null}

			<div>
				<h2 className="m-0 mb-1.5 text-sm font-bold">
					分镜
					<span className="ml-1 font-mono text-xs font-normal tabular-nums text-ink-muted">
						{orderedShots.length}
					</span>
				</h2>
				{orderedShots.length === 0 ? (
					<p className="m-0 text-xs text-ink-muted">
						还没有分镜，开始生成后会出现在这里
					</p>
				) : (
					<ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
						{orderedShots.map((shot) => {
							const imageUrl = getStaticUrl(shot.image_url);
							return (
								<li
									key={shot.id}
									className="relative aspect-square overflow-hidden rounded-sm border border-line-strong bg-paper-200"
								>
									{imageUrl ? (
										<img
											src={imageUrl}
											alt={`分镜 ${shot.order}`}
											className={`${MEDIA} h-full w-full object-cover`}
											loading="lazy"
											{...imageReady}
										/>
									) : (
										<span className="media-blank flex h-full items-center justify-center text-xs text-ink-muted">
											待生成
										</span>
									)}
									<span
										className="absolute left-0 top-0 rounded-br-sm bg-ink px-1.5 font-mono text-xs font-bold text-paper-100"
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
					<h2 className="m-0 mb-1.5 text-sm font-bold">
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
									<span className="h-12 w-12 overflow-hidden rounded-full border border-line bg-paper-200">
										{avatarUrl ? (
											<img
												src={avatarUrl}
												alt=""
												className={`${MEDIA} h-full w-full object-cover`}
												loading="lazy"
												{...imageReady}
											/>
										) : (
											<span
												className="flex h-full items-center justify-center text-sm font-bold text-ink-muted"
												aria-hidden="true"
											>
												{character.name?.slice(0, 1) || "?"}
											</span>
										)}
									</span>
									<span className="max-w-full truncate text-xs font-semibold">
										{character.name}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}

			{chat ? <div className="flex max-h-96 flex-col overflow-hidden rounded-lg border border-line empty:hidden">{chat}</div> : null}

			{activity ? (
				<div>
					<h2 className="m-0 mb-1.5 text-sm font-bold">最近动态</h2>
					<div className="overflow-hidden rounded-lg border border-line">
						{activity}
					</div>
				</div>
			) : null}

			<p className="m-0 text-xs text-ink-muted">
				完整画布编辑请用桌面端打开
			</p>
		</section>
	);
}
