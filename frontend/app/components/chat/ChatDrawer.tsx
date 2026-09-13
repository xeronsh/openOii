import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { useEditorStore, useShallow } from "~/stores/editorStore";
import { useChatPanelStore } from "~/stores/chatPanelStore";
import { ChatPanel } from "~/components/chat/ChatPanel";

interface ChatDrawerProps {
	onSendFeedback: (content: string) => void;
	onConfirm: (feedback?: string) => void;
	onCancel: () => void;
	isGenerating: boolean;
}

export function ChatDrawer({
	onSendFeedback,
	onConfirm,
	onCancel,
	isGenerating,
}: ChatDrawerProps) {
	const { isOpen, close } = useChatPanelStore();
	const { awaitingConfirm, runMode } = useEditorStore(useShallow((s) => ({ awaitingConfirm: s.awaitingConfirm, runMode: s.runMode })));

	useEffect(() => {
		if (awaitingConfirm && runMode === "manual") {
			useChatPanelStore.getState().open();
		}
	}, [awaitingConfirm, runMode]);

	if (!isOpen) return null;

	return (
		<div className="flex h-full w-sidebar shrink-0 flex-col border-l border-base-content/10 bg-base-100">
			<div className="flex items-center justify-end border-b border-base-content/10 px-1.5 py-1">
				<button
					type="button"
					className="btn btn-ghost btn-circle touch-target-dense h-7 min-h-7 w-7"
					onClick={close}
					aria-label="关闭对话面板"
				>
					<XMarkIcon className="h-3.5 w-3.5" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				<ChatPanel
					onSendFeedback={onSendFeedback}
					onConfirm={onConfirm}
					onCancel={onCancel}
					isGenerating={isGenerating}
				/>
			</div>
		</div>
	);
}
