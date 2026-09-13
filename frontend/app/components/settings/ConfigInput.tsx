import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { configApi } from "~/services/api";
import type { ConfigItem } from "~/types";
import { SvgIcon } from "~/components/ui/SvgIcon";

interface ConfigInputProps {
	item: ConfigItem;
	value: string;
	onChange: (
		e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
	) => void;
}

export function ConfigInput({ item, value, onChange }: ConfigInputProps) {
	const [isRevealed, setIsRevealed] = useState(false);
	const [isRevealing, setIsRevealing] = useState(false);

	const isSensitive = item.is_sensitive;
	const isMasked = item.is_masked;

	const handleToggleReveal = async () => {
		if (isRevealed) {
			setIsRevealed(false);
		} else {
			setIsRevealing(true);
			try {
				const result = await configApi.revealValue(item.key);
				setIsRevealed(true);
				if (result.value !== null) {
					onChange({
						target: { name: item.key, value: result.value },
					} as React.ChangeEvent<HTMLInputElement>);
				}
			} catch (error) {
				console.error("Failed to reveal value:", error);
				alert("获取真实值失败，请检查网络连接");
			} finally {
				setIsRevealing(false);
			}
		}
	};

	const fieldClass =
		"input input-bordered h-9 min-h-9 w-full border-2 border-base-content/25 bg-base-100 px-2.5 font-mono text-xs";

	if (isSensitive) {
		const displayValue = isRevealed ? value : isMasked ? value : "••••••••";

		return (
			<div className="space-y-1.5">
				<div className="relative">
					<input
						id={item.key}
						name={item.key}
						type="text"
						value={displayValue}
						onChange={onChange}
						className={`${fieldClass} pr-10`}
						autoComplete="off"
						placeholder={isRevealed ? "输入新值..." : ""}
					/>
					<button
						type="button"
						onClick={handleToggleReveal}
						disabled={isRevealing}
						className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-bc-muted transition-colors hover:text-accent"
						title={isRevealed ? "隐藏真实值" : "显示真实值"}
					>
						{isRevealing ? (
							<span className="loading loading-spinner loading-xs" />
						) : isRevealed ? (
							<EyeSlashIcon className="h-4 w-4" />
						) : (
							<EyeIcon className="h-4 w-4" />
						)}
					</button>
				</div>
				{!isRevealed && isMasked && (
					<p className="m-0 text-2xs text-bc-muted">
						已配置（显示脱敏值），点击眼睛图标可查看真实值
					</p>
				)}
				{isRevealed && (
					<p className="m-0 inline-flex items-center gap-1 text-2xs text-warning">
						<SvgIcon name="triangle-alert" size={12} />
						真实值已显示，请注意保护隐私
					</p>
				)}
			</div>
		);
	}

	return (
		<input
			id={item.key}
			name={item.key}
			type="text"
			value={value}
			onChange={onChange}
			className={fieldClass}
			autoComplete="off"
		/>
	);
}
