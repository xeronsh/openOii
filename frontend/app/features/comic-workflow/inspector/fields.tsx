/** 检查器各分区共用的小部件。 */
import type { ReactNode } from "react";
import { Button } from "~/components/ui/Button";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { ApiError } from "~/types/errors";

export function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return fallback;
}

export function FieldList({ items }: { items: Array<[string, string | number]> }) {
	return (
		<div className="space-y-1">
			{items.map(([label, value]) => (
				<div
					key={label}
					className="flex items-start justify-between gap-3 border-b border-line pb-1.5 text-sm"
				>
					<span className="font-mono text-xs uppercase text-ink-muted">
						{label}
					</span>
					<span className="min-w-0 text-right text-ink-muted">{value}</span>
				</div>
			))}
		</div>
	);
}

export function ActionStack({ children }: { children: ReactNode }) {
	return <div className="space-y-1.5">{children}</div>;
}

export function ActionButton({
	icon,
	label,
	disabled,
	loading,
	danger,
	primary,
	onClick,
}: {
	icon: Parameters<typeof SvgIcon>[0]["name"];
	label: string;
	disabled?: boolean;
	loading?: boolean;
	danger?: boolean;
	primary?: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			// 危险操作用红字的安静按钮（填充红底时红字会看不见）
			variant={primary && !danger ? "primary" : "ghost"}
			size="sm"
			className={`w-full justify-start gap-1.5 !h-8 !min-h-8 text-xs ${danger ? "text-error-fg hover:bg-error/10" : ""}`}
			disabled={disabled}
			loading={loading}
			onClick={onClick}
		>
			<SvgIcon name={icon} size={12} />
			{label}
		</Button>
	);
}

export function FormShell({
	disabled,
	children,
}: {
	disabled: boolean;
	children: ReactNode;
}) {
	return (
		<fieldset className="space-y-3" disabled={disabled}>
			{disabled ? (
				<div className="rounded-md border border-warning/25 bg-warning/10 px-2 py-1.5 text-xs text-warning-fg">
					生成运行中，保存操作已锁定。
				</div>
			) : null}
			{children}
		</fieldset>
	);
}

export function TextInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-ink-muted">
				{label}
			</span>
			<input
				className="input-doodle w-full px-2 py-1 text-sm"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

export function NumberInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number | null;
	onChange: (value: number | null) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-ink-muted">
				{label}
			</span>
			<input
				type="number"
				min="0"
				step="1"
				className="input-doodle w-full px-2 py-1 text-sm"
				value={value ?? ""}
				onChange={(event) =>
					onChange(event.target.value ? Number(event.target.value) : null)
				}
			/>
		</label>
	);
}

export function TextArea({
	label,
	value,
	rows,
	onChange,
}: {
	label: string;
	value: string;
	rows: number;
	onChange: (value: string) => void;
}) {
	return (
		<label className="block">
			<span className="mb-1 block text-xs font-mono uppercase text-ink-muted">
				{label}
			</span>
			<textarea
				className="input-doodle w-full resize-none px-2 py-1 text-sm"
				rows={rows}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}

export function SaveButton({
	disabled,
	loading,
	onClick,
}: {
	disabled: boolean;
	loading: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			variant="primary"
			size="sm"
			className="w-full"
			disabled={disabled}
			loading={loading}
			onClick={onClick}
		>
			保存
		</Button>
	);
}

export function textOrNull(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

const REVIEW_LABEL: Record<string, string> = { draft: "未确认", approved: "已确认", superseded: "已被新版本替换" };

/** 审阅状态的中文名（draft / approved / superseded）。 */
export function reviewLabel(state: string | null | undefined): string {
	return (state && REVIEW_LABEL[state]) || state || "未确认";
}
