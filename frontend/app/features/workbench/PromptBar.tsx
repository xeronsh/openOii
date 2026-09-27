import { CheckIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/Button";
import { MessageInput } from "~/components/chat/MessageInput";
import { OutlinePreviewCard } from "~/components/chat/OutlinePreviewCard";
import { useEditorStore } from "~/stores/editorStore";
import { AGENT_NAME_MAP, type RunAwaitingConfirmEventData } from "~/types";
import { toast } from "~/utils/toast";

interface PromptBarProps {
	selectionLabel: string | null;
	awaitingConfirm: boolean;
	awaitingAgent: string | null;
	recoveryGate: RunAwaitingConfirmEventData | null;
	isGenerating: boolean;
	onSendFeedback: (content: string) => void;
	onConfirm: (feedback?: string) => void;
}

export function PromptBar({
	selectionLabel,
	awaitingConfirm,
	awaitingAgent,
	recoveryGate,
	isGenerating,
	onSendFeedback,
	onConfirm,
}: PromptBarProps) {
	const [input, setInput] = useState("");
	const wasAwaitingConfirm = useRef(awaitingConfirm);
	const isYolo = useEditorStore((state) => state.runMode === "yolo");
	const showManualApproval = awaitingConfirm && !isYolo;
	const showOutlinePreview =
		showManualApproval && awaitingAgent === "outline" && recoveryGate?.story_outline;

	useEffect(() => {
		if (wasAwaitingConfirm.current && !awaitingConfirm) setInput("");
		wasAwaitingConfirm.current = awaitingConfirm;
	}, [awaitingConfirm]);

	const handleSend = () => {
		if (!input.trim()) return;
		if (awaitingConfirm) {
			onConfirm(input.trim());
			setInput("");
			return;
		}
		if (isGenerating) {
			toast.info({
				title: "请稍候",
				message: "当前阶段进行中；待审阅确认后再反馈，或先停止任务。",
			});
			return;
		}
		onSendFeedback(input);
		setInput("");
	};

	return (
		<footer
			className="z-sticky shrink-0 border-t-2 border-ink/15 bg-paper-100 px-2 py-1.5 sm:px-3"
			data-shell="prompt-bar"
		>
			{showOutlinePreview && recoveryGate?.story_outline ? (
				<div className="mx-auto mb-2 max-h-[min(38vh,20rem)] max-w-5xl overflow-y-auto">
					<OutlinePreviewCard
						outline={recoveryGate.story_outline}
						visualBible={recoveryGate.visual_bible}
						onConfirm={() => {
							onConfirm(undefined);
							setInput("");
						}}
						onRegenerate={(feedback) => {
							onConfirm(feedback);
							setInput("");
						}}
					/>
				</div>
			) : null}

			{showManualApproval && !showOutlinePreview ? (
				<div className="mx-auto mb-1.5 flex max-w-5xl items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1">
					<div className="min-w-0">
						<p className="m-0 text-xs font-bold">
							{(awaitingAgent && AGENT_NAME_MAP[awaitingAgent]) || awaitingAgent || "工作流"} 已完成
						</p>
						<p className="m-0 text-2xs text-ink-muted">确认继续，或输入修改意见</p>
					</div>
					<Button
						variant="primary"
						size="sm"
						onClick={() => {
							onConfirm(input.trim() || undefined);
							setInput("");
						}}
						className="shrink-0"
					>
						<CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
						通过并继续
					</Button>
				</div>
			) : null}

			<div className="mx-auto flex max-w-5xl items-center gap-2">
				{selectionLabel ? (
					<span
						className="max-w-[35vw] shrink-0 truncate rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-2xs font-semibold text-accent"
						aria-label={`当前选择：${selectionLabel}`}
						title={selectionLabel}
					>
						{selectionLabel}
					</span>
				) : null}
				<div className="min-w-0 flex-1">
					<MessageInput
						value={input}
						onChange={setInput}
						onSend={handleSend}
						placeholder={
							awaitingConfirm
								? "输入修改意见…"
								: selectionLabel
									? "描述如何调整所选内容…"
									: "让 openOii 改变故事…"
						}
						sendLabel={awaitingConfirm ? "请求修改" : "发送"}
					/>
				</div>
			</div>
			{isGenerating && !awaitingConfirm ? (
				<p className="m-0 mt-1 text-center text-2xs text-ink-muted" role="status">
					当前阶段进行中，待审批后可提交修改
				</p>
			) : null}
		</footer>
	);
}
