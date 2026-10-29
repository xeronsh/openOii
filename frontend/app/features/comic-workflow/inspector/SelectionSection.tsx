import type { ComicWorkflowNode } from "../graph/types";
import { styleLabel } from "~/features/projects/styleCategories";
import { FieldList, reviewLabel } from "./fields";

/** 选区：类型、名称、状态与关键字段。 */
export function SelectionSection({ node }: { node: ComicWorkflowNode }) {
	if (node.kind === "brief") {
		return (
			<FieldList
				items={[
					["标题", node.project.title],
					["风格", styleLabel(node.project.style) || "未设置"],
					["目标镜头", node.project.target_shot_count ?? "未设置"],
					["角色", node.metrics.characterCount],
					["镜头", node.metrics.shotCount],
					["总时长", node.metrics.totalDuration ? `${node.metrics.totalDuration}s` : "未定"],
				]}
			/>
		);
	}

	if (node.kind === "character") {
		return (
			<FieldList
				items={[
					["名称", node.character.name],
					["审阅状态", reviewLabel(node.character.approval_state)],
					["一致性特征", node.character.has_embedding ? "已计算" : "未计算"],
				]}
			/>
		);
	}

	if (node.kind === "shot") {
		return (
			<FieldList
				items={[
					["宫格", `格 ${node.gridCell ?? node.shot.order}`],
					["顺序", node.shot.order],
					["场景", node.shot.scene || "未设置"],
					["机位", node.shot.camera || "未设置"],
					["时长", node.shot.duration ? `${node.shot.duration}s` : "未设置"],
					["角色", node.characterNames.join("、") || "未绑定"],
					["审阅状态", reviewLabel(node.shot.approval_state)],
				]}
			/>
		);
	}

	return (
		<FieldList
			items={[
				["状态", node.subtitle],
				["视频", node.videoUrl ? "已生成" : "未生成"],
				["阻塞镜头", node.blockingClips.length],
			]}
		/>
	);
}
