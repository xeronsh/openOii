import { canvasEvents } from "~/components/canvas/canvasEvents";
import type { ComicWorkflowNode } from "../graph/types";
import { ActionButton, ActionStack, FieldList, reviewLabel } from "./fields";

function formatTime(value: string | null): string {
	if (!value) return "未批准";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

/** 历史：当前版本与审批记录，"对比版本"打开版本对比抽屉。 */
export function HistorySection({ node }: { node: ComicWorkflowNode }) {
	if (node.kind === "character" || node.kind === "shot") {
		const entity = node.kind === "character" ? node.character : node.shot;
		return (
			<ActionStack>
				<FieldList
					items={[
						["版本", `v${entity.approval_version}`],
						["审阅状态", reviewLabel(entity.approval_state)],
						["批准时间", formatTime(entity.approved_at)],
					]}
				/>
				<ActionButton
					icon="clock-3"
					label="对比版本"
					onClick={() =>
						canvasEvents.emit("version-history", { entityType: node.kind, entityId: node.entityId })
					}
				/>
			</ActionStack>
		);
	}

	return (
		<ActionStack>
			<p className="m-0 text-xs text-ink-muted">项目级的角色与分镜版本都在版本对比里。</p>
			<ActionButton icon="clock-3" label="打开版本对比" onClick={() => canvasEvents.emit("version-history", {})} />
		</ActionStack>
	);
}
