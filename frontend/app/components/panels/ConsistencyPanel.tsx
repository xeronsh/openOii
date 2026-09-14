import { useCallback, useEffect, useRef, useState } from "react";
import {
	Radar,
	RadarChart,
	PolarGrid,
	PolarAngleAxis,
	PolarRadiusAxis,
	ResponsiveContainer,
	LineChart,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
} from "recharts";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { consistencyApi } from "~/services/api";
import { toast } from "~/utils/toast";
import { ApiError } from "~/types/errors";
import type {
	CharacterConsistencyRead,
	ConsistencyReportRead,
	ProjectConsistencyRead,
} from "~/types";

/**
 * Recharts 只接受具体颜色字符串，无法用 Tailwind class。
 * 走 daisyUI 主题变量，使图表随 doodle / doodle-dark 主题一起切换。
 */
const CHART_ACCENT = "oklch(var(--p))";

interface ConsistencyPanelProps {
	projectId: number;
	onClose: () => void;
}

const GRADE_COLORS: Record<string, string> = {
	A: "text-success",
	B: "text-info",
	C: "text-warning",
	D: "text-error",
	F: "text-error",
};

const GRADE_BG: Record<string, string> = {
	A: "bg-success/20",
	B: "bg-info/20",
	C: "bg-warning/20",
	D: "bg-error/20",
	F: "bg-error/20",
};

const CONSISTENCY_POLL_INTERVAL_MS = 2000;
const CONSISTENCY_MAX_POLLS = 6;

function isMissingReportError(error: unknown) {
	return error instanceof ApiError && error.status === 404;
}

function warnInDev(message: string, error: unknown) {
	if (import.meta.env.DEV) {
		console.warn(message, error);
	}
}

function GradeBadge({ grade }: { grade: string }) {
	return (
		<span
			className={`badge badge-lg font-bold ${GRADE_BG[grade] || ""} ${GRADE_COLORS[grade] || ""}`}
		>
			{grade}
		</span>
	);
}

function CharacterCard({
	report,
	expanded,
	onToggle,
}: {
	report: CharacterConsistencyRead;
	expanded: boolean;
	onToggle: () => void;
}) {
	const radarData = [
		{ dimension: "人脸相似度", value: report.face_similarity_mean * 100 },
		{ dimension: "一致性", value: Math.max(0, 100 - report.face_similarity_std * 500) },
		{ dimension: "检出率", value: report.presence_rate * 100 },
		{ dimension: "综合评分", value: report.overall_score },
	];

	return (
		<div className="card bg-base-200 shadow-md">
			<div
				className="card-body p-4 cursor-pointer"
				onClick={onToggle}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					onToggle();
				}}
			>
				<div className="flex items-center justify-between">
					<h3 className="card-title text-base">{report.character_name}</h3>
					<GradeBadge grade={report.grade} />
				</div>
				<div className="flex gap-4 text-sm mt-1">
					<span>相似度: {(report.face_similarity_mean * 100).toFixed(1)}%</span>
					<span>稳定性: {report.face_similarity_std.toFixed(3)}</span>
					<span>检出率: {(report.presence_rate * 100).toFixed(1)}%</span>
				</div>

				{expanded && (
					<div className="mt-4 space-y-4">
						{/* 雷达图 */}
						<div className="w-full h-64">
							<ResponsiveContainer width="100%" height="100%">
								<RadarChart data={radarData}>
									<PolarGrid />
									<PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12 }} />
									<PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 10 }} />
									<Radar
										name={report.character_name}
										dataKey="value"
										stroke={CHART_ACCENT}
										fill={CHART_ACCENT}
										fillOpacity={0.3}
									/>
								</RadarChart>
							</ResponsiveContainer>
						</div>

						{/* 分镜匹配详情 */}
						{report.face_matches.length > 0 && (
							<div className="overflow-x-auto">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>分镜序号</th>
											<th>检测</th>
											<th>相似度</th>
										</tr>
									</thead>
									<tbody>
										{report.face_matches.map((m) => (
											<tr key={m.shot_id}>
												<td>#{m.shot_order}</td>
												<td>
													{m.detected ? (
														<CheckIcon className="w-4 h-4 text-success" aria-label="已检测" />
													) : (
														<XMarkIcon className="w-4 h-4 text-error" aria-label="未检测" />
													)}
												</td>
												<td>
													<progress
														className="progress progress-primary w-20"
														value={m.similarity * 100}
														max={100}
													/>
													<span className="ml-2 text-xs">
														{(m.similarity * 100).toFixed(1)}%
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export function ConsistencyPanel({ projectId, onClose }: ConsistencyPanelProps) {
	const [report, setReport] = useState<ProjectConsistencyRead | null>(null);
	const [history, setHistory] = useState<ConsistencyReportRead[]>([]);
	const [loading, setLoading] = useState(false);
	const [evaluating, setEvaluating] = useState(false);
	const [expandedChar, setExpandedChar] = useState<number | null>(null);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	const clearEvalPoll = useCallback(() => {
		if (pollTimerRef.current !== null) {
			clearTimeout(pollTimerRef.current);
			pollTimerRef.current = null;
		}
	}, []);

	const fetchReport = useCallback(async (options?: { showLoading?: boolean }) => {
		const showLoading = options?.showLoading ?? true;
		if (showLoading) {
			setLoading(true);
		}
		try {
			const resp = await consistencyApi.getReport(projectId);
			if (resp.report_data && mountedRef.current) {
				setReport(resp.report_data);
			}
			return resp;
		} catch (error) {
			if (!isMissingReportError(error)) {
				warnInDev("Failed to load consistency report", error);
			}
			return null;
		} finally {
			if (showLoading && mountedRef.current) {
				setLoading(false);
			}
		}
	}, [projectId]);

	const fetchHistory = useCallback(async () => {
		try {
			const hist = await consistencyApi.getHistory(projectId, 20);
			if (mountedRef.current) {
				setHistory(hist);
			}
			return hist;
		} catch (error) {
			warnInDev("Failed to load consistency report history", error);
			return [];
		}
	}, [projectId]);

	useEffect(() => {
		fetchReport();
		fetchHistory();
	}, [fetchReport, fetchHistory]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearEvalPoll();
		};
	}, [clearEvalPoll]);

	const pollForFreshReport = useCallback(
		(triggeredAt: number, attempt = 1) => {
			pollTimerRef.current = setTimeout(() => {
				void (async () => {
					const latest = await fetchReport({ showLoading: false });
					await fetchHistory();
					if (!mountedRef.current) return;

					const latestCreatedAt = latest ? Date.parse(latest.created_at) : Number.NaN;
					const hasFreshReport = Boolean(
						latest?.report_data &&
							Number.isFinite(latestCreatedAt) &&
							latestCreatedAt >= triggeredAt - 1000,
					);

					if (hasFreshReport) {
						pollTimerRef.current = null;
						setEvaluating(false);
						return;
					}

					if (attempt >= CONSISTENCY_MAX_POLLS) {
						pollTimerRef.current = null;
						setEvaluating(false);
						toast.info({
							title: "评估仍在进行",
							message: "后台任务尚未返回新报告，可稍后重新打开面板查看",
							duration: 5000,
						});
						return;
					}

					pollForFreshReport(triggeredAt, attempt + 1);
				})();
			}, CONSISTENCY_POLL_INTERVAL_MS);
		},
		[fetchHistory, fetchReport],
	);

	const handleEval = async () => {
		clearEvalPoll();
		setEvaluating(true);
		const triggeredAt = Date.now();
		try {
			await consistencyApi.triggerEval(projectId);
			toast.info({
				title: "评估已触发",
				message: "正在后台计算角色一致性，完成后将自动刷新",
				duration: 3000,
			});
			pollForFreshReport(triggeredAt);
		} catch (e) {
			toast.error({
				title: "评估触发失败",
				message: e instanceof Error ? e.message : "未知错误",
				duration: 5000,
			});
			if (mountedRef.current) {
				setEvaluating(false);
			}
		}
	};

	// Trend chart data
	const trendData = history
		.slice()
		.reverse()
		.map((r) => ({
			date: new Date(r.created_at).toLocaleDateString("zh-CN", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}),
			score: r.overall_score,
		}));

	return (
		<div className="fixed inset-0 z-modal flex items-center justify-center bg-neutral/70">
			<div className="bg-base-100 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
				{/* Header */}
				<div className="sticky top-0 z-sticky flex items-center justify-between border-b border-base-content/10 bg-base-100 p-6">
					<div>
						<h2 className="text-xl font-bold">角色一致性评估</h2>
						<p className="text-sm text-bc-muted mt-1">
							基于 InsightFace 人脸特征自动计算跨分镜一致性
						</p>
					</div>
					<div className="flex gap-2">
						<button
							className={`btn btn-primary btn-sm ${evaluating ? "loading" : ""}`}
							onClick={handleEval}
							disabled={evaluating}
						>
							{evaluating ? "评估中..." : "开始评估"}
						</button>
						<button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭">
							<XMarkIcon className="w-4 h-4" aria-hidden="true" />
						</button>
					</div>
				</div>

				<div className="p-6 space-y-6">
					{loading && !report && (
						<div className="flex justify-center py-12">
							<span className="loading loading-spinner loading-lg" />
						</div>
					)}

					{!loading && !report && (
						<div className="text-center py-12 text-bc-muted">
							<p className="text-lg">尚未进行一致性评估</p>
							<p className="text-sm mt-2">点击"开始评估"按钮来评估角色在分镜中的一致性</p>
						</div>
					)}

					{report && (
						<>
							{/* 项目级评分概览 */}
							<div className="stats stats-vertical lg:stats-horizontal shadow w-full">
								<div className="stat">
									<div className="stat-title">综合评分</div>
									<div className="stat-value text-2xl">{report.overall_score.toFixed(1)}</div>
									<div className="stat-desc">/ 100</div>
								</div>
								<div className="stat">
									<div className="stat-title">角色数量</div>
									<div className="stat-value text-2xl">
										{report.character_reports.length}
									</div>
								</div>
								<div className="stat">
									<div className="stat-title">评估时间</div>
									<div className="stat-value text-base">
										{new Date(report.evaluated_at).toLocaleString("zh-CN")}
									</div>
								</div>
							</div>

							{/* 趋势图 */}
							{trendData.length > 1 && (
								<div className="card bg-base-200 shadow-md">
									<div className="card-body p-4">
										<h3 className="card-title text-base">评分趋势</h3>
										<div className="w-full h-48">
											<ResponsiveContainer width="100%" height="100%">
												<LineChart data={trendData}>
													<CartesianGrid strokeDasharray="3 3" />
													<XAxis dataKey="date" tick={{ fontSize: 11 }} />
													<YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
													<Tooltip />
													<Legend />
													<Line
														type="monotone"
														dataKey="score"
														name="综合评分"
														stroke={CHART_ACCENT}
														strokeWidth={2}
														dot={{ r: 4 }}
													/>
												</LineChart>
											</ResponsiveContainer>
										</div>
									</div>
								</div>
							)}

							{/* 角色卡片列表 */}
							<div className="space-y-3">
								<h3 className="text-lg font-bold">角色一致性详情</h3>
								{report.character_reports.map((cr) => (
									<CharacterCard
										key={cr.character_id}
										report={cr}
										expanded={expandedChar === cr.character_id}
										onToggle={() =>
											setExpandedChar(
												expandedChar === cr.character_id ? null : cr.character_id,
											)
										}
									/>
								))}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
