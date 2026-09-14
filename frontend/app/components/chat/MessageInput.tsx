import { Button } from "~/components/ui/Button";

interface MessageInputProps {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	disabled?: boolean;
	placeholder?: string;
}

export function MessageInput({
	value,
	onChange,
	onSend,
	disabled,
	placeholder,
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
				className="input input-bordered h-9 min-h-9 flex-1 bg-base-200 text-sm"
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
				发送
			</Button>
		</div>
	);
}
