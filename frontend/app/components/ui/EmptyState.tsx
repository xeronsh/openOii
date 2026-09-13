import type { ReactNode } from "react";
import { clsx } from "clsx";

/** Dense empty / soft-empty block used across desks and side panels. */
export function EmptyState({
	icon,
	title,
	description,
	action,
	className,
	compact = false,
}: {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
	className?: string;
	compact?: boolean;
}) {
	return (
		<div
			className={clsx(
				"flex flex-col items-center justify-center text-center",
				compact ? "px-3 py-8" : "px-4 py-10",
				className,
			)}
			data-shell="empty-state"
		>
			{icon ? (
				<div className="mb-2 text-bc-subtle opacity-80" aria-hidden="true">
					{icon}
				</div>
			) : null}
			<p className="m-0 font-heading text-sm font-bold text-bc-muted">
				{title}
			</p>
			{description ? (
				<p className="m-0 mt-1 max-w-sm text-xs text-bc-muted text-pretty">
					{description}
				</p>
			) : null}
			{action ? <div className="mt-3">{action}</div> : null}
		</div>
	);
}
