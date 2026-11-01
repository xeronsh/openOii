import { useEffect, useRef, useState } from "react";
import { MessageInput } from "~/components/chat/MessageInput";
import { PlainButton } from "~/components/ui/PlainButton";
import { useEditorStore } from "~/stores/editorStore";
import { SvgIcon } from "~/components/ui/SvgIcon";

export interface PromptChip {
	id: string;
	label: string;
}

interface PromptBarProps {
	/** 画布选区；空数组时显示 [整个项目]。 */
	selection: PromptChip[];
	onRemoveSelection?: (id: string) => void;
	/** 审批门名称（如“规划”）；处于审批门时出现 [规划 · 待确认] chip，发送即提修改意见。 */
	gateLabel: string | null;
	awaitingConfirm: boolean;
	/** 发给项目助手（ADR 0011）；返回 false 表示没发出去，草稿会放回输入框 */
	onSend: (content: string) => Promise<boolean> | void;
	/** 审批门：无参数 = 批准；带意见 = 要求修改。返回 false 表示没提交成功。 */
	onConfirm: (feedback?: string) => Promise<boolean> | void;
	/** 桌面：浮在画布底部居中；手机：留在页面底部。 */
	floating?: boolean;
}

const chipClass =
	"inline-flex max-w-48 shrink-0 items-center gap-0.5 truncate rounded-full border px-2 py-0.5 text-xs font-semibold";

export function PromptBar({
	selection,
	onRemoveSelection,
	gateLabel,
	awaitingConfirm,
	onSend,
	onConfirm,
	floating = false,
}: PromptBarProps) {
	const [input, setInput] = useState("");
	const wasAwaitingConfirm = useRef(awaitingConfirm);
	const runMode = useEditorStore((s) => s.runMode);
	const setRunMode = useEditorStore((s) => s.setRunMode);
	const isAuto = runMode === "yolo";

	useEffect(() => {
		if (wasAwaitingConfirm.current && !awaitingConfirm) setInput("");
		wasAwaitingConfirm.current = awaitingConfirm;
	}, [awaitingConfirm]);

	const toggleRunMode = () => {
		const next = isAuto ? "manual" : "yolo";
		setRunMode(next);
		// 运行中切到自动确认会通过当前审批门
		if (next === "yolo" && awaitingConfirm) onConfirm(undefined);
	};

	const handleSend = () => {
		if (!input.trim()) return;
		if (awaitingConfirm) {
			const draft = input;
			setInput("");
			void Promise.resolve(onConfirm(draft.trim())).then((sent) => {
				if (sent === false) setInput((current) => current || draft);
			});
			return;
		}
		const draft = input;
		setInput("");
		void Promise.resolve(onSend(draft)).then((sent) => {
			if (sent === false) setInput((current) => current || draft);
		});
	};

	const placeholder = awaitingConfirm
		? "说明需要修改的地方…"
		: selection.length > 0
			? "让助手调整所选内容…"
			: "问助手，或让它重画、修改…";

	return (
		<footer
			className={
				floating
					? "absolute bottom-3 left-1/2 z-panel w-[min(720px,calc(100%-1.5rem))] -translate-x-1/2 rounded-lg border border-line bg-surface p-1.5 shadow-panel"
					: "z-panel shrink-0 border-t border-line bg-surface px-2 py-1.5"
			}
			data-shell="prompt-bar"
		>
			<div className="mb-1 flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="上下文">
				<PlainButton
					className="inline-flex touch-target-dense shrink-0 items-center gap-1 rounded-full px-2 text-xs font-semibold text-ink-muted transition-colors duration-fast hover:bg-paper-200 hover:text-ink"
					onClick={toggleRunMode}
					aria-label={isAuto ? "切换逐步确认" : "切换自动确认"}
					title={isAuto ? "自动确认：阶段自动通过" : "逐步确认：每个阶段由你确认"}
				>
					{isAuto ? (
						<SvgIcon name="zap" size={14} className="text-primary" />
					) : (
						<SvgIcon name="sliders" size={14} />
					)}
					{isAuto ? "自动确认" : "逐步确认"}
				</PlainButton>
				<span className="h-4 w-px shrink-0 bg-ink/15" aria-hidden="true" />
				{awaitingConfirm && gateLabel ? (
					<span className={`${chipClass} border-primary/40 bg-primary/10 text-primary`}>
						{gateLabel} · 待确认
					</span>
				) : null}
				{selection.length > 0 ? (
					selection.map((chip) => (
						<span key={chip.id} className={`${chipClass} border-primary/30 bg-primary/10 text-primary`} title={chip.label}>
							<span className="truncate">{chip.label}</span>
							{onRemoveSelection ? (
								<PlainButton
									className="-my-1 -mr-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-primary/15"
									onClick={() => onRemoveSelection(chip.id)}
									aria-label={`移除 ${chip.label}`}
								>
									<SvgIcon name="x" size={12} />
								</PlainButton>
							) : null}
						</span>
					))
				) : awaitingConfirm && gateLabel ? null : (
					<span className={`${chipClass} border-line text-ink-muted`}>整个项目</span>
				)}
			</div>
			<MessageInput
				value={input}
				onChange={setInput}
				onSend={handleSend}
				placeholder={placeholder}
				sendLabel={awaitingConfirm ? "发送意见" : "发送"}
			/>
		</footer>
	);
}
