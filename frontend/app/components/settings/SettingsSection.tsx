import { useState } from "react";
import type { ConfigItem, ConfigValue } from "~/types";
import { ConfigField, type ConfigChangeHandler } from "./ConfigField";
import { PROVIDER_TABS, TAB_CONFIG, itemsFor, type ProviderTab } from "./settingsTabs";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { PlainButton } from "~/components/ui/PlainButton";
import { ProviderPresetPanel } from "./ProviderPresetPanel";
import { isPresetService } from "./providerPresets";
import "~/components/ui/icons/settingsIcons";

interface SectionProps {
	tab: string;
	items: ConfigItem[];
	formState: Record<string, ConfigValue>;
	onChange: ConfigChangeHandler;
}

/** 一个设置页签的内容：provider 页签先选服务商再显示分组，其它页签直接列出配置项 */
export function SettingsSection({ tab, items, formState, onChange }: SectionProps) {
	const provider = PROVIDER_TABS[tab];
	const field = (item: ConfigItem, hint?: string) => (
		<ConfigField key={item.key} item={item} value={formState[item.key]} onChange={onChange} hint={hint} />
	);
	return (
		<div className="space-y-3">
			<div className="flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs text-ink">
				<SvgIcon name="info" size={14} className="mt-0.5 shrink-0 text-primary" />
				<span>{TAB_CONFIG[tab]?.desc}</span>
			</div>
			{provider && isPresetService(tab) ? (
				<ProviderPresetPanel
					key={tab}
					service={tab}
					items={items}
					formState={formState}
					onChange={onChange}
					onApply={(values) => applyValues(items, values, onChange)}
					renderAdvanced={(shownKeys, defaultOpen) => (
						<AdvancedSettings defaultOpen={defaultOpen}>
							<ProviderBody
								tab={provider}
								items={items.filter((i) => !shownKeys.includes(i.key))}
								formState={formState}
								onChange={onChange}
								field={field}
								hasProviderItem={items.some((i) => i.key.toLowerCase() === provider.providerKey)}
							/>
						</AdvancedSettings>
					)}
				/>
			) : provider ? (
				<ProviderBody tab={provider} items={items} formState={formState} onChange={onChange} field={field} />
			) : (
				<>
					<div className="space-y-2">{items.map((item) => field(item))}</div>
					{items.length === 0 && (
						<div className="py-8 text-center text-xs text-ink-muted">
							<SvgIcon name="info" size={32} className="mx-auto mb-1.5 opacity-50" />
							<p className="m-0">此分类暂无配置项</p>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** 预设一次写多个值：按已有配置项的真实键名（可能是小写回退键）发出 change 事件 */
function applyValues(items: ConfigItem[], values: Record<string, string>, onChange: ConfigChangeHandler) {
	for (const [key, value] of Object.entries(values)) {
		const name = items.find((i) => i.key.toUpperCase() === key)?.key ?? key;
		onChange({ target: { name, value } } as React.ChangeEvent<HTMLInputElement>);
	}
}

function AdvancedSettings({ defaultOpen, children }: { defaultOpen: boolean; children: React.ReactNode }) {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div className="border-t border-line pt-1" data-testid="advanced-settings">
			<PlainButton
				aria-expanded={open}
				aria-controls="settings-advanced"
				onClick={() => setOpen((v) => !v)}
				className="touch-target-dense flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-sm font-semibold hover:bg-paper-300"
			>
				<SvgIcon name="sliders" size={14} className="text-ink-muted" />
				高级设置
				<span className="text-xs font-normal text-ink-muted">全部字段，可逐项手动填写</span>
				<SvgIcon name={open ? "chevron-up" : "chevron-down"} size={14} className="ml-auto text-ink-muted" />
			</PlainButton>
			{open ? (
				<div id="settings-advanced" className="space-y-3 pt-2">
					{children}
				</div>
			) : null}
		</div>
	);
}

export function currentProvider(tab: ProviderTab, formState: Record<string, ConfigValue>) {
	const key = tab.providerKey;
	if (!key) return tab.defaultProvider;
	return (formState[key.toUpperCase()] || formState[key] || tab.defaultProvider) as string;
}

function ProviderBody({
	tab,
	items,
	formState,
	onChange,
	field,
	hasProviderItem: hasProviderItemProp,
}: {
	tab: ProviderTab;
	items: ConfigItem[];
	formState: Record<string, ConfigValue>;
	onChange: ConfigChangeHandler;
	field: (item: ConfigItem, hint?: string) => React.ReactNode;
	hasProviderItem?: boolean;
}) {
	const provider = currentProvider(tab, formState);
	const name = tab.providerKey?.toUpperCase();
	const hasProviderItem = hasProviderItemProp ?? items.some((i) => i.key.toLowerCase() === tab.providerKey);
	return (
		<>
			{hasProviderItem && (
				<div className="rounded-md border border-line bg-paper-200/70 p-2.5">
					<div className="mb-2 flex items-center gap-1.5">
						<span className="text-sm font-semibold">接口协议</span>
						<span className="badge-doodle bg-primary text-primary-content border-primary/30 text-xs px-1.5 py-0.5">必选</span>
						<span className="ml-auto font-mono text-xs text-ink-muted" title="对应的环境变量">{name}</span>
					</div>
					<div className={tab.layout === "grid" ? "grid grid-cols-1 gap-2 lg:grid-cols-3" : "flex flex-col gap-2 lg:flex-row"}>
						{tab.options.filter((o) => !o.native || o.value === provider).map((option) => (
							<label
								key={option.value}
								className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border p-2.5 transition-colors duration-fast ${
									provider === option.value ? "border-primary bg-primary/10" : "border-line-strong hover:bg-paper-300"
								}`}
							>
								<input
									type="radio"
									name={name}
									value={option.value}
									checked={provider === option.value}
									onChange={onChange}
									className="h-4 w-4 accent-primary"
								/>
								<div className="min-w-0">
									<div className="text-sm font-bold">{option.title}</div>
									<div className="text-xs text-ink-muted">{option.desc}</div>
								</div>
							</label>
						))}
					</div>
				</div>
			)}
			{tab.groups.map((group, index) => {
				if (group.providers && !group.providers.includes(provider)) return null;
				const groupItems = itemsFor(items, group.match);
				if (groupItems.length === 0 && !group.note) return null;
				const common = !group.providers;
				const groupIcon = common ? "tools" : tab.icon;
				return (
					<div key={index} className="space-y-2">
						<h4 className={`m-0 flex items-center gap-1.5 text-xs font-bold ${common ? "text-ink-muted" : "text-primary"}`}>
							<SvgIcon name={groupIcon} size={14} />
							{typeof group.title === "function" ? group.title(provider) : group.title}
						</h4>
						<div className={`space-y-2 border-l-2 pl-2.5 ${common ? "border-line" : "border-primary/30"}`}>
							{groupItems.map((item) => field(item, group.hint?.(item.key.toLowerCase(), provider)))}
							{group.note ? <p className="m-0 px-1 text-xs text-ink-muted">{group.note}</p> : null}
						</div>
					</div>
				);
			})}
		</>
	);
}
