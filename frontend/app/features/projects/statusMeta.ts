/**
 * 项目状态展示元数据的单一来源。
 *
 * 后端 Project.status 的真实取值全集是 draft | planning | ready | superseded | failed
 * （backend/app/models/project.py 与各赋值点）。所有展示层（列表、顶栏下拉、工作台）
 * 从这里取文案；未知值兜底为中文「未知状态」，绝不把英文原始值渲染给用户。
 */
export interface ProjectStatusMeta {
	label: string;
	/** 列表页状态胶囊样式 */
	badgeCls: string;
	/** 顶栏下拉等次级场景的文字样式 */
	textCls: string;
}

const FALLBACK: ProjectStatusMeta = {
	label: "未知状态",
	badgeCls: "border-ink/20 bg-paper-200 text-ink",
	textCls: "text-ink-muted",
};

const META: Record<string, ProjectStatusMeta> = {
	draft: {
		label: "草稿",
		badgeCls: "border-ink/20 bg-paper-200 text-ink",
		textCls: "text-ink-muted",
	},
	planning: {
		label: "规划中",
		badgeCls: "border-warning/35 bg-warning/10 text-ink",
		textCls: "text-ink",
	},
	ready: {
		label: "成片可用",
		badgeCls: "border-success/35 bg-success/10 text-ink",
		textCls: "text-ink",
	},
	superseded: {
		label: "需重合成",
		badgeCls: "border-warning/35 bg-warning/10 text-ink",
		textCls: "text-ink-muted",
	},
	failed: {
		label: "生成失败",
		badgeCls: "border-error/35 bg-error/10 text-ink",
		textCls: "text-error",
	},
};

export function getProjectStatusMeta(
	status: string | null | undefined,
): ProjectStatusMeta {
	const key = status?.trim().toLowerCase() ?? "";
	return META[key] ?? FALLBACK;
}
