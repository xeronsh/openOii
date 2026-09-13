import type { ReactNode } from "react";
import { clsx } from "clsx";

/**
 * 桌面区块：全站统一的区块语法。
 *
 * 标题行（图标 + 标题 + 计数 + 动作）下压一条 2px 注册线，内容直接
 * 坐在纸面上——不再默认包一层 Card。Card 只留给真正独立、可操作的
 * 对象（宇宙卡、分镜卡、画布节点）；把列表和空状态关进全宽大卡片
 * 只会造出空奶油色死区。
 */
export function DeskSection({
	icon,
	title,
	meta,
	actions,
	children,
	className,
}: {
	icon?: ReactNode;
	title: string;
	meta?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={clsx(
				"flex min-w-0 flex-col gap-3",
				className,
			)}
			data-shell="desk-section"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-base-content/10 pb-1.5">
				<div className="flex min-w-0 items-center gap-1.5">
					{icon ? (
						<span className="shrink-0 text-bc-muted" aria-hidden="true">
							{icon}
						</span>
					) : null}
					<h2 className="m-0 font-heading text-md font-bold leading-tight">
						{title}
					</h2>
					{meta ? (
						<span className="font-mono text-2xs tabular-nums text-bc-muted">
							{meta}
						</span>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 flex-wrap items-center gap-1.5">
						{actions}
					</div>
				) : null}
			</div>
			{children}
		</section>
	);
}
