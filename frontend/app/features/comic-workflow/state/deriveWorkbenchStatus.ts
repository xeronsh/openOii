import type { BlockingClip, RecoveryControlRead } from "~/types";

export type WorkbenchStatusState =
	| "idle"
	| "generating"
	| "awaitingConfirm"
	| "recoverable"
	| "cancelled"
	| "ready"
	| "superseded"
	| "failed"
	| "blocked";

export type LastRunTerminalStatus = "cancelled" | null;

export interface WorkbenchStatus {
	state: WorkbenchStatusState;
	label: string;
	description: string;
}

export interface DeriveWorkbenchStatusInput {
	isGenerating: boolean;
	currentRunId: number | null;
	awaitingConfirm: boolean;
	recoveryControl: RecoveryControlRead | null;
	projectStatus?: string | null;
	projectVideoUrl?: string | null;
	blockingClips?: BlockingClip[] | null;
	lastRunStatus?: LastRunTerminalStatus;
}

const WORKBENCH_STATUS_COPY: Record<
	WorkbenchStatusState,
	Omit<WorkbenchStatus, "state">
> = {
	idle: {
		label: "待启动",
		description: "项目画布已准备好，可以开始生成",
	},
	generating: {
		label: "生成中",
		description: "AI 正在推进当前生成运行",
	},
	awaitingConfirm: {
		label: "待确认",
		description: "正在等待创作者确认后继续",
	},
	recoverable: {
		label: "可恢复",
		description: "存在可恢复的运行，可以继续或取消",
	},
	cancelled: {
		label: "已取消",
		description: "最近一次运行已取消",
	},
	ready: {
		label: "成片可用",
		description: "最终成片已生成，可以预览或导出",
	},
	superseded: {
		label: "需重合成",
		description: "画布内容已更新，当前成片需要重新合成",
	},
	failed: {
		label: "生成失败",
		description: "最近一次生成失败，可从失败阶段重试",
	},
	blocked: {
		label: "阻塞",
		description: "当前内容存在阻塞项，需要处理后继续",
	},
};

export function getWorkbenchStatusMeta(
	state: WorkbenchStatusState,
): WorkbenchStatus {
	return {
		state,
		...WORKBENCH_STATUS_COPY[state],
	};
}

export function deriveWorkbenchStatus(
	input: DeriveWorkbenchStatusInput,
): WorkbenchStatus {
	const projectStatus = input.projectStatus?.trim().toLowerCase() ?? null;
	const hasBlockingClips = Boolean(input.blockingClips?.length);

	if (input.awaitingConfirm) {
		return getWorkbenchStatusMeta("awaitingConfirm");
	}

	if (input.recoveryControl?.state === "recoverable") {
		return getWorkbenchStatusMeta("recoverable");
	}

	if (
		input.recoveryControl?.state === "active" ||
		input.isGenerating ||
		Boolean(input.currentRunId)
	) {
		return getWorkbenchStatusMeta("generating");
	}

	if (input.lastRunStatus === "cancelled" || projectStatus === "cancelled") {
		return getWorkbenchStatusMeta("cancelled");
	}

	// failed 是独立终态：列表页显示「生成失败」，工作台不能把它降级成「阻塞」
	if (projectStatus === "failed" || projectStatus === "error") {
		return getWorkbenchStatusMeta("failed");
	}

	if (hasBlockingClips || projectStatus === "blocked") {
		return getWorkbenchStatusMeta("blocked");
	}

	if (projectStatus === "superseded") {
		return getWorkbenchStatusMeta("superseded");
	}

	if (
		Boolean(input.projectVideoUrl) ||
		projectStatus === "ready" ||
		projectStatus === "completed"
	) {
		return getWorkbenchStatusMeta("ready");
	}

	return getWorkbenchStatusMeta("idle");
}
