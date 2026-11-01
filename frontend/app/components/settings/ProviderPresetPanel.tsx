import { useMemo, useRef, useState } from "react";
import type { ConfigItem, ConfigValue } from "~/types";
import { SvgIcon } from "~/components/ui/SvgIcon";
import { PlainButton } from "~/components/ui/PlainButton";
import { ConfigField, type ConfigChangeHandler } from "./ConfigField";
import {
	PRESET_GROUP_LABEL,
	PRESETS_VERIFIED_AT,
	PROVIDER_PRESETS,
	detectPreset,
	effectiveKeys,
	fillBaseUrl,
	formProvider,
	isTestMode,
	presetById,
	presetConfigValues,
	presetKeys,
	regionNeeds,
	type PresetGroup,
	type PresetService,
	type ProviderPreset,
} from "./providerPresets";
import "~/components/ui/icons/settingsIcons";

interface Props {
	service: PresetService;
	items: ConfigItem[];
	formState: Record<string, ConfigValue>;
	onChange: ConfigChangeHandler;
	/** 一次写入多个配置值（选预设、切地域） */
	onApply: (values: Record<string, string>) => void;
	/** 高级设置：传入已在上方显示、需要从高级设置里隐去的配置键，以及是否默认展开 */
	renderAdvanced: (shownKeys: string[], defaultOpen: boolean) => React.ReactNode;
}

const GROUPS: PresetGroup[] = ["domestic", "global", "local"];

function readForm(form: Record<string, ConfigValue>, key: string) {
	return String(form[key] ?? form[key.toLowerCase()] ?? "");
}

/**
 * 刚点的预设在配置里可能还反推不出来（例如 Azure 还没填资源名），这时仍显示它；
 * 一旦高级设置里手动改了服务类型或地址，就回到按配置识别的结果。
 */
function pendingStillApplies(
	pending: ProviderPreset,
	form: Record<string, ConfigValue>,
	regionId: string | undefined,
	fields: Record<string, string>,
): boolean {
	const keys = presetKeys(pending);
	if (keys.provider && readForm(form, keys.provider).toLowerCase() !== pending.provider) return false;
	if (pending.custom || !keys.baseUrl) return true;
	const region = pending.regions.find((r) => r.id === regionId) ?? pending.regions[0];
	const expected = region ? fillBaseUrl(region, fields) : null;
	if (expected === null) return true;
	return readForm(form, keys.baseUrl).replace(/\/+$/, "") === expected.replace(/\/+$/, "");
}

/** 只有单色标的品牌：logo 文件自带整块品牌底色（见 scripts/build-provider-logos.py） */
const BAKED_TILE = new Set(["openai", "xai", "groq", "ollama", "lmstudio", "elevenlabs", "suno"]);

/** 服务商标记：品牌彩色 logo 放在固定的浅色方块里（深浅色主题都清楚）；没有 logo 用文字标记 */
export function ProviderMark({ preset, selected }: { preset: ProviderPreset; selected: boolean }) {
	if (preset.logo) {
		return (
			<span aria-hidden data-logo={preset.logo} data-baked={BAKED_TILE.has(preset.logo) || undefined} className="provider-tile">
				<img src={`/provider-logos/${preset.logo}.svg`} alt="" width={20} height={20} loading="lazy" decoding="async" draggable={false} />
			</span>
		);
	}
	return (
		<span
			aria-hidden
			className={`inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1 text-xs font-bold ${
				selected ? "bg-primary text-primary-content" : "bg-paper-300 text-ink"
			}`}
		>
			{preset.mark}
		</span>
	);
}

const PROTOCOL_LABEL: Record<string, string> = {
	anthropic: "Anthropic 原生（Messages）",
	modelscope: "ModelScope 异步任务",
	doubao: "豆包视频",
};

/** 选服务商 → 自动填好地址、接口路径和推荐模型；地域和专属字段单独给输入。 */
export function ProviderPresetPanel({ service, items, formState, onChange, onApply, renderAdvanced }: Props) {
	const detected = useMemo(() => detectPreset(service, formState), [service, formState]);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [regionId, setRegionId] = useState<string | undefined>(detected.regionId);
	const [fields, setFields] = useState<Record<string, string>>(detected.fields);
	const detailRef = useRef<HTMLElement>(null);

	const pending = pendingId ? presetById(service, pendingId) : undefined;
	const preset = pending && pendingStillApplies(pending, formState, regionId, fields) ? pending : detected.preset;
	// 刚点过的预设 / 地域以本地选择为准，否则按配置反推
	const activeRegionId = pending && preset === pending ? regionId : detected.regionId ?? regionId;
	const region = preset.regions.find((r) => r.id === activeRegionId) ?? preset.regions[0];
	const keys = effectiveKeys(preset, formState);
	const protocol = formProvider(service, formState);
	const keyItem = keys.apiKey ? items.find((i) => i.key.toUpperCase() === keys.apiKey) : undefined;
	const model = keys.model ? readForm(formState, keys.model) : "";
	const voice = keys.voice ? readForm(formState, keys.voice) : "";
	const voices = preset.voices ?? [];
	const needs = regionNeeds(region);
	const missing = needs.filter((id) => !(fields[id] ?? "").trim());

	const choose = (next: ProviderPreset) => {
		// 再点一次已选中的自定义不改接口协议（老配置可能是 Anthropic 原生 / 中转）
		if (next.custom && next.id === preset.id) return;
		const nextRegion = next.regions[0];
		setPendingId(next.id);
		setRegionId(nextRegion?.id);
		const nextFields = next.id === detected.preset.id ? detected.fields : {};
		setFields(nextFields);
		onApply(presetConfigValues(next, { regionId: nextRegion?.id, fields: nextFields }));
		// 窄屏上卡片列表很长：选完把详情带进视野
		requestAnimationFrame(() => detailRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }));
	};

	const chooseRegion = (id: string) => {
		setPendingId(preset.id);
		setRegionId(id);
		const next = preset.regions.find((r) => r.id === id);
		const url = next ? fillBaseUrl(next, fields) : null;
		if (keys.baseUrl && url) onApply({ [keys.baseUrl]: url });
	};

	const setField = (id: string, value: string) => {
		const nextFields = { ...fields, [id]: value };
		setFields(nextFields);
		setPendingId(preset.id);
		const url = region ? fillBaseUrl(region, nextFields) : null;
		if (keys.baseUrl && url) onApply({ [keys.baseUrl]: url });
	};

	const testMode = PROVIDER_PRESETS[service].find(isTestMode);
	const baseUrl = keys.baseUrl ? readForm(formState, keys.baseUrl) : "";
	const baseUrlItem = preset.custom && keys.baseUrl ? items.find((i) => i.key.toUpperCase() === keys.baseUrl) : undefined;
	const showsModel = Boolean(keys.model) && preset.provider !== "fake";
	const showsKey = Boolean(keyItem) && preset.provider !== "fake";
	// 上方已经显示的字段不在高级设置里重复出现
	const shownKeys = items
		.filter((i) => {
			const k = i.key.toUpperCase();
			return (
				(showsKey && k === keys.apiKey) ||
				(showsModel && k === keys.model) ||
				(Boolean(keys.voice) && k === keys.voice) ||
				(Boolean(baseUrlItem) && k === keys.baseUrl)
			);
		})
		.map((i) => i.key);

	return (
		<div className="space-y-3" data-testid="provider-presets">
			<div role="radiogroup" aria-label="选择服务商" className="space-y-2">
				{GROUPS.map((group) => {
					const presets = PROVIDER_PRESETS[service].filter((p) => p.group === group && !isTestMode(p));
					if (presets.length === 0) return null;
					return (
						<div key={group} className="space-y-1.5">
							<p className="label m-0 text-xs text-ink-muted">{PRESET_GROUP_LABEL[group]}</p>
							<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
								{presets.map((p) => {
									const selected = p.id === preset.id;
									return (
										<PlainButton
											key={p.id}
											role="radio"
											aria-checked={selected}
											data-preset={p.id}
											onClick={() => choose(p)}
											className={`touch-target-dense flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-fast ${
												selected ? "border-primary bg-primary/10" : "border-line-strong bg-paper-100 hover:bg-paper-300"
											}`}
										>
											<ProviderMark preset={p} selected={selected} />
											<span className="min-w-0">
												<span className="block text-sm font-semibold leading-snug">{p.name}</span>
												<span className="hidden truncate text-xs text-ink-muted sm:block">{p.tagline}</span>
											</span>
										</PlainButton>
									);
								})}
							</div>
						</div>
					);
				})}
				{testMode ? (
					<PlainButton
						role="radio"
						aria-checked={testMode.id === preset.id}
						data-preset={testMode.id}
						onClick={() => choose(testMode)}
						className={`touch-target-dense inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors duration-fast ${
							testMode.id === preset.id
								? "border-primary bg-primary/10 text-ink"
								: "border-dashed border-line-strong text-ink-muted hover:bg-paper-300"
						}`}
					>
						<SvgIcon name="tools" size={12} />
						{testMode.name}
						<span className="text-ink-muted">· {testMode.tagline}</span>
					</PlainButton>
				) : null}
			</div>

			<section
				ref={detailRef}
				aria-label={`${preset.name} 配置`}
				className="scroll-mt-4 space-y-2.5 border-t border-line pt-3"
				data-testid="preset-detail"
			>
				<div className="flex flex-wrap items-center gap-1.5">
					<h4 className="m-0 text-sm font-bold">{preset.name}</h4>
					{preset.experimental ? (
						<span className="badge-doodle bg-warning/15 text-warning-fg border-warning/30 text-xs px-1.5 py-0.5">实验性</span>
					) : null}
					<span className="flex-1" />
					{preset.docsUrl ? (
						<a href={preset.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
							<SvgIcon name="book-open" size={12} />
							官方文档
						</a>
					) : null}
					{preset.keyUrl ? (
						<a href={preset.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
							<SvgIcon name="globe" size={12} />
							获取 API Key
						</a>
					) : null}
				</div>

				{preset.custom ? (
					<p className="m-0 text-xs text-ink-muted" data-testid="custom-protocol">
						{PROTOCOL_LABEL[protocol]
							? `当前接口协议：${PROTOCOL_LABEL[protocol]}，沿用原有配置；要换协议或改接口路径请到「高级设置」。`
							: service === "tts"
								? "任意兼容 OpenAI /audio/speech 的服务：填好地址、密钥、模型和音色即可。"
								: service === "bgm"
									? "填好 suno-api 网关地址即可。"
								: "任意 OpenAI 兼容的网关、中转或自建服务：填好地址、密钥和模型即可；接口路径在「高级设置」里。"}
					</p>
				) : null}
				{baseUrlItem ? (
					<ConfigField
						item={baseUrlItem}
						value={formState[baseUrlItem.key]}
						onChange={onChange}
						hint={protocol === "openai" ? "服务的基础地址，如 https://example.com/v1" : undefined}
					/>
				) : null}
				{preset.provider === "fake" ? (
					<p className="m-0 text-xs text-ink-muted">不调用任何外部服务，适合本地联调和演示，不产生费用。</p>
				) : null}

				{preset.regions.length > 1 ? (
					<div className="space-y-1">
						<p className="m-0 text-xs font-semibold">地域</p>
						<div role="radiogroup" aria-label="地域" className="flex flex-wrap gap-1">
							{preset.regions.map((r) => {
								const on = r.id === region?.id;
								return (
									<PlainButton
										key={r.id}
										role="radio"
										aria-checked={on}
										onClick={() => chooseRegion(r.id)}
										className={`touch-target-dense rounded-md border px-2 py-1 text-xs font-semibold transition-colors duration-fast ${
											on ? "border-primary bg-primary text-primary-content" : "border-line-strong bg-paper-100 hover:bg-paper-300"
										}`}
									>
										{r.label}
									</PlainButton>
								);
							})}
						</div>
					</div>
				) : null}

				{needs.map((id) => {
					const field = preset.fields?.find((f) => f.id === id);
					if (!field) return null;
					const inputId = `preset-field-${id}`;
					return (
						<div key={id} className="space-y-1">
							<label htmlFor={inputId} className="block text-xs font-semibold">
								{field.label}
							</label>
							<input
								id={inputId}
								value={fields[id] ?? ""}
								onChange={(e) => setField(id, e.target.value.trim())}
								placeholder={field.placeholder}
								pattern={field.pattern}
								autoComplete="off"
								className="input-doodle h-9 touch-target-dense w-full border border-line-strong bg-paper-100 px-2.5 font-mono text-xs"
							/>
							<p className="m-0 text-xs text-ink-muted">{field.help}</p>
						</div>
					);
				})}

				{!preset.custom && keys.baseUrl ? (
					<p className="m-0 text-xs text-ink-muted" data-testid="preset-base-url">
						接口地址{" "}
						<span className="break-all font-mono text-ink">
							{missing.length > 0 ? "填写上面的字段后自动生成" : baseUrl || "—"}
						</span>
					</p>
				) : null}

				{showsModel ? (
					<div className="space-y-1">
						<label htmlFor={`preset-model-${service}`} className="block text-xs font-semibold">
							{preset.modelLabel ?? "模型"}
						</label>
						<input
							id={`preset-model-${service}`}
							name={keys.model}
							value={model}
							onChange={onChange}
							list={preset.models.length ? `preset-models-${service}` : undefined}
							autoComplete="off"
							className="input-doodle h-9 touch-target-dense w-full border border-line-strong bg-paper-100 px-2.5 font-mono text-xs"
						/>
						{preset.models.length ? (
							<>
								<datalist id={`preset-models-${service}`}>
									{preset.models.map((m) => (
										<option key={m} value={m} />
									))}
								</datalist>
								<div className="flex flex-wrap gap-1" aria-label="推荐模型">
									{preset.models.map((m) => (
										<PlainButton
											key={m}
											aria-pressed={m === model}
											onClick={() => onApply({ [keys.model!]: m })}
											className={`touch-target-dense rounded-sm border px-2 py-0.5 font-mono text-xs transition-colors duration-fast ${
												m === model ? "border-primary bg-primary/10 text-ink" : "border-line bg-paper-100 text-ink-muted hover:bg-paper-300"
											}`}
										>
											{m}
										</PlainButton>
									))}
								</div>
							</>
						) : null}
					</div>
				) : null}

				{keys.voice ? (
					<div className="space-y-1">
						<label htmlFor={`preset-voice-${service}`} className="block text-xs font-semibold">
							默认音色
						</label>
						<input
							id={`preset-voice-${service}`}
							name={keys.voice}
							value={voice}
							onChange={onChange}
							list={voices.length ? `preset-voices-${service}` : undefined}
							autoComplete="off"
							className="input-doodle h-9 touch-target-dense w-full border border-line-strong bg-paper-100 px-2.5 font-mono text-xs"
						/>
						<p className="m-0 text-xs text-ink-muted">角色没有单独指定音色时用这个；角色音色在画布的属性面板里改。</p>
						{voices.length ? (
							<>
								<datalist id={`preset-voices-${service}`}>
									{voices.map((v) => (
										<option key={v} value={v} />
									))}
								</datalist>
								<div className="flex flex-wrap gap-1" aria-label="推荐音色">
									{voices.map((v) => (
										<PlainButton
											key={v}
											aria-pressed={v === voice}
											onClick={() => onApply({ [keys.voice!]: v })}
											className={`touch-target-dense rounded-sm border px-2 py-0.5 font-mono text-xs transition-colors duration-fast ${
												v === voice ? "border-primary bg-primary/10 text-ink" : "border-line bg-paper-100 text-ink-muted hover:bg-paper-300"
											}`}
										>
											{v}
										</PlainButton>
									))}
								</div>
							</>
						) : null}
					</div>
				) : null}

				{keyItem && showsKey ? (
					<ConfigField
						item={keyItem}
						value={formState[keyItem.key]}
						onChange={onChange}
						hint={preset.keyOptional ? `${preset.keyHint}（可留空）` : preset.keyHint || undefined}
					/>
				) : null}

				{preset.notes?.length ? (
					<ul className="m-0 list-none space-y-1 p-0">
						{preset.notes.map((note) => (
							<li key={note} className="flex items-start gap-1.5 text-xs text-ink-muted">
								<SvgIcon name="info" size={12} className="mt-0.5 shrink-0 text-primary" />
								<span>{note}</span>
							</li>
						))}
					</ul>
				) : null}

				{!preset.custom && preset.sources.length ? (
					<p className="m-0 text-xs text-ink-muted">预设依据官方文档整理，核对于 {PRESETS_VERIFIED_AT}。</p>
				) : null}
			</section>

			{renderAdvanced(shownKeys, Boolean(detected.preset.custom))}
		</div>
	);
}
