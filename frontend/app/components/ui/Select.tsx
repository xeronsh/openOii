import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { clsx } from "clsx";
import type { SelectHTMLAttributes } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
	density?: "compact" | "normal";
	containerClassName?: string;
}

export function Select({
	className,
	containerClassName,
	density = "normal",
	...props
}: SelectProps) {
	const compact = density === "compact";

	return (
		<div className={clsx("relative w-full", containerClassName)}>
			<select
				{...props}
				className={clsx(
					"input-doodle w-full appearance-none bg-paper-100 pr-8 text-ink",
					compact ? "h-8 min-h-8 px-2 py-1 text-xs" : "h-9 min-h-9 px-2.5 py-1.5 text-base",
					className,
				)}
			/>
			<ChevronDownIcon
				className={clsx(
					"pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted",
					compact ? "h-3.5 w-3.5" : "h-4 w-4",
				)}
				aria-hidden="true"
			/>
		</div>
	);
}
