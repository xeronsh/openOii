import { Button } from "~/components/ui/Button";

interface MessageInputProps {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	disabled?: boolean;
	placeholder?: string;
	sendLabel?: string;
}

export function MessageInput({
	value,
	onChange,
	onSend,
	disabled,
	placeholder,
	sendLabel = "发送",
}: MessageInputProps) {
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSend();
		}
	};

	return (
		<div className="flex gap-1.5">
			<input
				id="chat-message-input"
				name="message"
				type="text"
				className="input-doodle h-9 min-h-9 flex-1 px-3 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
				disabled={disabled}
				placeholder={placeholder}
				aria-label={placeholder ?? "消息内容"}
				autoComplete="off"
			/>
			<Button
				onClick={onSend}
				disabled={disabled || !value.trim()}
				size="sm"
				className="h-9 min-h-9 shrink-0 px-3"
			>
				{sendLabel}
			</Button>
		</div>
	);
}
