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
				divider && "border-b border-ink/10 pb-3",
				actionsAlign === "title"
					? "flex-row flex-wrap items-center justify-between"
					: "flex-col lg:flex-row lg:items-end lg:justify-between",
				className,
			)}
			data-shell="page-header"
		>
			<div className="min-w-0">
				{eyebrow ? (
					<p className="m-0 font-mono text-2xs uppercase tracking-wide text-ink-muted">
						{eyebrow}
					</p>
				) : null}
				<div className="mt-0.5 flex flex-wrap items-end gap-2">
					<h1 className="m-0 font-heading text-2xl font-bold leading-tight text-pretty sm:text-3xl">
						{title}
					</h1>
					{meta ? (
						<div className="pb-0.5 font-mono text-2xs tabular-nums text-ink-muted">
							{meta}
						</div>
					) : null}
				</div>
				{description ? (
					<p className="m-0 mt-1 max-w-2xl text-sm text-ink-muted text-pretty">
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
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={clsx(
				// gap-5 = --rhythm-zone（比块内 gap-3/--rhythm-block 宽一档），页面才有节奏
				"mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-3 sm:px-4",
				className,
			)}
			data-shell="page-content"
		>
			{children}
		</div>
	);
}
