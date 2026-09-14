import type { ReactNode } from "react";
import { clsx } from "clsx";

/**
 * Shared dense page header for list/detail desks (projects, universes, home sections).
 * Keep eyebrow/title/description + actions density consistent across routes.
 */
export function PageHeader({
	eyebrow,
	title,
	description,
	meta,
	actions,
	actionsAlign = "below",
	divider = true,
	className,
}: {
	eyebrow?: string;
	title: string;
	description?: string;
	meta?: ReactNode;
	actions?: ReactNode;
	/** "below"：移动端 actions 换行到标题块下、lg 起同行（列表/详情页默认）；"title"：actions 全断点钉在标题行（首页 chip 行，避免挤占垂直空间） */
	actionsAlign?: "title" | "below";
	/** 底部分隔线；默认开，与列表/详情页一致 */
	divider?: boolean;
	className?: string;
}) {
	return (
		<header
			className={clsx(
				"flex gap-2",
				divider && "border-b border-base-content/10 pb-3",
				actionsAlign === "title"
					? "flex-row flex-wrap items-center justify-between"
					: "flex-col lg:flex-row lg:items-end lg:justify-between",
				className,
			)}
			data-shell="page-header"
		>
			<div className="min-w-0">
				{eyebrow ? (
					<p className="m-0 font-mono text-2xs uppercase tracking-wide text-bc-muted">
						{eyebrow}
					</p>
				) : null}
				<div className="mt-0.5 flex flex-wrap items-end gap-2">
					<h1 className="m-0 font-heading text-xl font-bold leading-tight text-pretty">
						{title}
					</h1>
					{meta ? (
						<div className="pb-0.5 font-mono text-2xs tabular-nums text-bc-muted">
							{meta}
						</div>
					) : null}
				</div>
				{description ? (
					<p className="m-0 mt-1 max-w-2xl text-sm text-bc-muted text-pretty">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
			) : null}
		</header>
	);
}

/** Content column used by list/detail pages. */
export function PageContent({
	children,
	className,
	width = "default",
}: {
	children: ReactNode;
	className?: string;
	/**
	 * 宽度约定：普通页一律 "default"（max-w-6xl）。
	 * "wide"（max-w-7xl）仅限重表格页（目前只有 ProjectsPage）——跨页导航时内容左边缘会平移，这是刻意取舍，勿为对齐改掉。
	 * "narrow" 留给纯文本/表单页。
	 */
	width?: "default" | "wide" | "narrow";
}) {
	const max =
		width === "wide"
			? "max-w-7xl"
			: width === "narrow"
				? "max-w-3xl"
				: "max-w-6xl";
	return (
		<div
			className={clsx(
				// gap-5 = --rhythm-zone（比块内 gap-3/--rhythm-block 宽一档），页面才有节奏
				"mx-auto flex w-full flex-col gap-5 px-3 py-3 sm:px-4",
				max,
				className,
			)}
			data-shell="page-content"
		>
			{children}
		</div>
	);
}
