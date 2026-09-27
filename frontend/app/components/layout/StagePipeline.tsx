import {
	CheckIcon,
	ExclamationTriangleIcon,
	ArrowPathIcon,
	StopIcon,
	SparklesIcon,
	ChatBubbleLeftRightIcon,
	ClockIcon,
	ShieldCheckIcon,
	ArrowDownTrayIcon,
	EllipsisHorizontalIcon,
} from "@heroicons/react/24/outline";
import type { WorkflowStage } from "~/types";
import { STAGE_PIPELINE, getPipelineStageIndex } from "~/utils/pipeline";
import { Button } from "~/components/ui/Button";
import type { WorkbenchStatus } from "~/features/comic-workflow/state/deriveWorkbenchStatus";
import { useEffect, useRef, useState } from "react";

interface StagePipelineProps {
	currentStage: WorkflowStage;
	isGenerating: boolean;
	progress?: number;
	workbenchStatus: WorkbenchStatus;
	awaitingConfirm: boolean;
	hasRecovery: boolean;
	onGenerate?: () => void;
	onResume: () => void;
	onCancel: () => void;
	onToggleChat?: () => void;
	generateDisabled?: boolean;
	/** Open version history / compare drawer. */
	onOpenVersions?: () => void;
	/** Open consistency report panel. */
	onOpenConsistency?: () => void;
	/** Trigger export (e.g. webtoon). */
	onExport?: () => void;
	exportBusy?: boolean;
}

const STATUS_DOT: Record<WorkbenchStatus["state"], string> = {
	idle: "bg-ink/35",
	generating: "bg-warning animate-pulse",
	awaitingConfirm: "bg-info",
	recoverable: "bg-warning",
	cancelled: "bg-ink/35",
	ready: "bg-success",
	superseded: "bg-warning",
	failed: "bg-error",
	blocked: "bg-error",
};

const chromeBtn =
	"touch-target-dense !h-8 !min-h-8 gap-1 !px-2 text-xs transition-colors duration-fast";

// 执行动作后收起 focus 展开的菜单。
function runMenuAction(action: () => void) {
	if (document.activeElement instanceof HTMLElement) {
		document.activeElement.blur();
	}
	action();
}

export function StagePipeline({
	currentStage,
	isGenerating,
	progress = 0,
	workbenchStatus,
	awaitingConfirm,
	hasRecovery,
	onGenerate,
	onResume,
	onCancel,
	onToggleChat,
	generateDisabled,
	onOpenVersions,
	onOpenConsistency,
	onExport,
	exportBusy = false,
}: StagePipelineProps) {
	const [toolsOpen, setToolsOpen] = useState(false);
	const toolsRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!toolsOpen) return;
		const closeOnOutsideClick = (event: PointerEvent) => {
			if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsideClick);
		return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
	}, [toolsOpen]);
	const currentIndex = getPipelineStageIndex(currentStage);
	const progressPercent = Math.max(0, Math.min(100, Math.round(progress * 100)));
	const generateLabel =
		workbenchStatus.state === "idle"
			? "开始生成"
			: workbenchStatus.state === "failed" ||
					workbenchStatus.state === "recoverable"
				? "重试失败阶段"
				: "重新生成";
	const hasTools = Boolean(onOpenVersions || onOpenConsistency || onExport);

	return (
		<div
			className="chrome-toolbar z-sticky gap-2 border-b border-ink/10 bg-paper-200/80 px-2 sm:gap-3 sm:px-3"
			data-shell="stage-pipeline"
		>
			<span className="sr-only" aria-live="polite">
				工作台状态：{workbenchStatus.label}
			</span>

			<div
				className="flex min-w-0 items-center gap-2"
				title={workbenchStatus.description}
			>
				<span
					className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[workbenchStatus.state]}`}
					aria-hidden="true"
				/>
				{/* 状态文案在所有视口可见：<sm 只剩色点时色盲无法区分状态 */}
				<span className="inline-block max-w-[4.5rem] truncate font-mono text-2xs font-semibold tabular-nums text-ink-muted sm:max-w-[5.5rem]">
					{workbenchStatus.label}
				</span>
				<div
					className="h-1 w-14 overflow-hidden rounded-full bg-ink/10 sm:w-20"
					role="progressbar"
					aria-label="生成进度"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={progressPercent}
				>
					<div
						className="h-full rounded-full bg-primary transition-[width] duration-normal"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
				<span className="w-8 font-mono text-2xs tabular-nums text-ink-muted">
					{progressPercent}%
				</span>
			</div>

			<nav
				className="flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto"
				aria-label="生成阶段"
			>
				{STAGE_PIPELINE.map((stage, index) => {
					const past = currentIndex >= 0 && index < currentIndex;
					const current = currentIndex === index;

					return (
						<div key={stage.key} className="flex shrink-0 items-center">
							<span
								className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-2xs font-bold uppercase tracking-wide ${
									current
										? "bg-primary text-primary-content"
										: past
											? "text-ink-muted"
											: "text-ink-muted"
								}`}
								aria-current={current ? "step" : undefined}
							>
								{past ? (
									<CheckIcon className="h-3 w-3" aria-hidden="true" />
								) : null}
								{stage.label}
								{current && hasRecovery && !isGenerating ? (
									<ExclamationTriangleIcon
										className="h-3 w-3 text-warning-content"
										aria-hidden="true"
									/>
								) : null}
							</span>
							{index < STAGE_PIPELINE.length - 1 ? (
								<span
									className={`mx-0.5 h-px w-3 ${past ? "bg-success/60" : "bg-ink/15"}`}
									aria-hidden="true"
								/>
							) : null}
						</div>
					);
				})}
			</nav>

			<div className="flex shrink-0 items-center gap-1">
				{hasTools ? (
					// 版本/一致性/导出收进溢出菜单：所有视口可达（<sm 原先整组消失，导出无入口）
					<div ref={toolsRef} className="relative mr-0.5 border-r border-ink/10 pr-1" onKeyDown={(event) => event.key === "Escape" && setToolsOpen(false)}>
						<button
							type="button"
							className={`btn-doodle bg-transparent border-transparent shadow-none hover:bg-paper-200 hover:shadow-brutal-sm h-8 min-h-8 gap-1.5 px-2.5 text-sm ${chromeBtn}`}
							aria-label="工作台工具"
							aria-haspopup="menu"
							aria-expanded={toolsOpen}
							title="版本 / 一致性 / 导出"
							onClick={() => setToolsOpen((open) => !open)}
						>
							<EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
							<span className="hidden lg:inline">工具</span>
						</button>
						{toolsOpen ? <ul
							tabIndex={0}
							role="menu"
							aria-label="工作台工具菜单"
							className="absolute right-0 top-full z-dropdown mt-1 w-44 list-none border-2 border-ink/10 bg-paper-100 p-1 shadow-brutal-sm"
						>
							{onOpenVersions ? (
								<li role="none">
									<button
										type="button"
										role="menuitem"
										className="gap-2 text-xs"
										onClick={() => { setToolsOpen(false); runMenuAction(onOpenVersions); }}
										aria-label="打开版本对比"
									>
										<ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
										版本对比
									</button>
								</li>
							) : null}
							{onOpenConsistency ? (
								<li role="none">
									<button
										type="button"
										role="menuitem"
										className="gap-2 text-xs"
										onClick={() => { setToolsOpen(false); runMenuAction(onOpenConsistency); }}
										aria-label="打开一致性报告"
									>
										<ShieldCheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
										一致性报告
									</button>
								</li>
							) : null}
							{onExport ? (
								<li role="none">
									<button
										type="button"
										role="menuitem"
										className="gap-2 text-xs"
										onClick={() => { setToolsOpen(false); runMenuAction(onExport); }}
										disabled={exportBusy || isGenerating}
										aria-label="导出 Webtoon 长图"
									>
										<ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />
										{exportBusy ? "导出中…" : "导出 Webtoon"}
									</button>
								</li>
							) : null}
						</ul> : null}
					</div>
				) : null}

				{hasRecovery && !isGenerating ? (
					<>
						<Button
							variant="primary"
							size="sm"
							className={chromeBtn}
							onClick={onResume}
						>
							<ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
							恢复
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className={chromeBtn}
							onClick={onCancel}
							aria-label="停止当前任务"
						>
							<StopIcon className="h-3.5 w-3.5" aria-hidden="true" />
						</Button>
					</>
				) : null}
				{isGenerating ? (
					<Button
						variant="ghost"
						size="sm"
						className={`${chromeBtn} text-error`}
						onClick={onCancel}
					>
						<StopIcon className="h-3.5 w-3.5" aria-hidden="true" />
						停止
					</Button>
				) : null}
				{awaitingConfirm && onToggleChat ? (
					<Button
						variant="primary"
						size="sm"
						className={chromeBtn}
						onClick={onToggleChat}
						aria-label="打开对话面板"
					>
						<ChatBubbleLeftRightIcon
							className="h-3.5 w-3.5"
							aria-hidden="true"
						/>
						确认
					</Button>
				) : null}
				{!isGenerating && !hasRecovery && !awaitingConfirm && onGenerate ? (
					<Button
						variant="primary"
						size="sm"
						className={chromeBtn}
						onClick={onGenerate}
						disabled={generateDisabled}
					>
						<SparklesIcon className="h-3.5 w-3.5" aria-hidden="true" />
						{generateLabel}
					</Button>
				) : null}
			</div>
		</div>
	);
}
