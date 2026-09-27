import type { HTMLAttributes, ReactNode } from "react";
import { clsx } from "clsx";

/**
 * Viewport-locked shell: no document/page scroll.
 * Put TopBar (or other chrome) as non-scrolling siblings; put scrollable content in PageBody.
 */
export function PageShell({
	children,
	className,
	...rest
}: {
	children: ReactNode;
	className?: string;
} & HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={clsx("page-shell bg-paper-100 font-sans", className)}
			{...rest}
		>
			{children}
		</div>
	);
}

/** Scroll region inside PageShell — only this area may scroll. */
export function PageBody({
	children,
	className,
	as: Tag = "main",
}: {
	children: ReactNode;
	className?: string;
	as?: "main" | "div" | "section";
}) {
	return (
		<Tag className={clsx("page-body", className)}>
			{children}
		</Tag>
	);
}
