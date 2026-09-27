import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon } from "@heroicons/react/24/outline";
import { SvgIcon } from "~/components/ui/SvgIcon";
import type { ComicWorkflowNode } from "../graph/types";
import { WorkflowInspector } from "../inspector/WorkflowInspector";

interface InspectorColumnProps {
	projectId: number;
	selectedNode: ComicWorkflowNode | null;
	selectedNodeIds?: string[];
	structureLocked: boolean;
	universeId?: number | null;
	/** 画布不再承载 Brief，未选中时由这里常驻显示项目级上下文。 */
	briefNode?: ComicWorkflowNode | null;
}

/**
 * 右栏 = 选中项检查器（Figma 模式：选中即展开、取消即收回）。
 *
 * 它是属性面的唯一归宿：角色、分镜、成片、以及不在画布上的 Brief
 * 都由这里承载。抓不到选中时回落到 Brief——项目级上下文永远可达，
 * 不必先点一张卡片；用户手动收起后同一次选中不再强行弹开。
 */
export function InspectorColumn({
	projectId,
	selectedNode,
	selectedNodeIds = [],
	structureLocked,
	universeId = null,
	briefNode = null,
}: InspectorColumnProps) {
	const hasSelection = Boolean(selectedNode) || selectedNodeIds.length > 0;
	const activeNode = selectedNode ?? briefNode;
	const canRender = Boolean(activeNode) || selectedNodeIds.length > 0;
	const [open, setOpen] = useState(true);
	// 用户手动收起后，同一次选中不强行再弹开；换了选中目标才重新展开。
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const selectionKey = selectedNode?.id ?? selectedNodeIds.join(",") ?? "";

	useEffect(() => {
		if (dismissedFor === selectionKey) return;
		if (hasSelection) setOpen(true);
	}, [dismissedFor, hasSelection, selectionKey]);

	if (!canRender) {
		return (
			<aside
				className="z-corner hidden shrink-0 flex-col items-center gap-2 border-l-2 border-ink/10 bg-paper-100 py-2 lg:flex lg:w-inspector-collapsed"
				aria-label="检查器"
				data-shell="inspector-column"
			>
				<span className="text-ink/25">
					<SvgIcon name="layers" size={16} />
				</span>
				<span className="font-mono text-2xs uppercase text-ink-muted [writing-mode:vertical-rl]">
					无内容
				</span>
			</aside>
		);
	}

	return (
		<aside
			className={clsx(
				"z-corner hidden shrink-0 flex-col border-l-2 border-ink/10 bg-paper-100 transition-[width] duration-normal lg:flex",
				open ? "lg:w-inspector" : "lg:w-inspector-collapsed",
			)}
			aria-label="检查器"
			data-shell="inspector-column"
			data-inspector-open={open ? "true" : "false"}
		>
			<div className="flex items-center justify-between gap-1 border-b border-ink/10 px-1.5 py-1">
				<span className="min-w-0 truncate font-mono text-2xs uppercase text-ink-muted">
					{open ? (selectedNode ? "inspector" : "project brief") : ""}
				</span>
				<button
					type="button"
					className="touch-target-dense flex shrink-0 items-center justify-center text-ink-muted transition-colors duration-fast hover:bg-paper-200"
					onClick={() => {
						const next = !open;
						setOpen(next);
						setDismissedFor(next ? null : selectionKey);
					}}
					aria-label={open ? "收起检查器" : "展开检查器"}
					aria-expanded={open}
					title={open ? "收起检查器" : "展开检查器"}
				>
					{open ? (
						<ChevronDoubleRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
					) : (
						<ChevronDoubleLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
					)}
				</button>
			</div>

			<div className={clsx("min-h-0 flex-1 overflow-hidden", !open && "hidden")}>
				<WorkflowInspector
					projectId={projectId}
					selectedNode={activeNode}
					selectedNodeIds={selectedNodeIds}
					structureLocked={structureLocked}
					universeId={universeId}
				/>
			</div>
		</aside>
	);
}
