import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PRESETS_VERIFIED_AT,
	PROVIDER_PRESETS,
	customPreset,
	detectPreset,
	effectiveKeys,
	fillBaseUrl,
	isTestMode,
	presetById,
	presetConfigValues,
	presetKeys,
	regionNeeds,
	type PresetService,
} from "./providerPresets";
import { getConfigLabel } from "./configLabels";

const SERVICES: PresetService[] = ["text", "image", "video"];

describe("providerPresets 数据", () => {
	it("核对日期固定为 2026-10-30", () => {
		expect(PRESETS_VERIFIED_AT).toBe("2026-10-30");
	});

	it.each(SERVICES)("%s：id 唯一，每个真实服务商都有官方来源和 https 地址", (service) => {
		const presets = PROVIDER_PRESETS[service];
		expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
		for (const p of presets) {
			expect(p.service).toBe(service);
			expect(p.mark.length).toBeGreaterThan(0);
			expect(p.mark.length).toBeLessThanOrEqual(3);
			if (p.custom || p.provider === "fake") continue;
			expect(p.sources.length, p.id).toBeGreaterThan(0);
			for (const src of p.sources) expect(src, p.id).toMatch(/^https:\/\//);
			if (p.group !== "local") {
				for (const r of p.regions) expect(r.baseUrl, p.id).toMatch(/^https:\/\//);
			}
			// Azure 等按部署名调用的没有默认模型，但必须改模型输入框的标题
			if (p.defaultModel) expect(p.models, p.id).toContain(p.defaultModel);
			else expect(p.modelLabel, p.id).toBeTruthy();
			// 地址里的占位字段必须有对应的输入说明
			for (const r of p.regions) {
				for (const need of regionNeeds(r)) expect(p.fields?.some((f) => f.id === need), `${p.id}.${need}`).toBe(true);
			}
		}
	});

	it("每个服务只有一个通用自定义（OpenAI 兼容）和一个测试模式", () => {
		for (const service of SERVICES) {
			const customs = PROVIDER_PRESETS[service].filter((p) => p.custom);
			expect(customs.map((p) => [p.provider, p.name]), service).toEqual([["openai", "自定义 · OpenAI 兼容"]]);
			expect(PROVIDER_PRESETS[service].filter(isTestMode)).toHaveLength(1);
		}
	});

	it("「本地与自定义」只剩本地服务和通用自定义，没有按协议分的自定义卡片", () => {
		const local = (service: PresetService) =>
			PROVIDER_PRESETS[service].filter((p) => p.group === "local" && !isTestMode(p)).map((p) => p.id);
		expect(local("text")).toEqual(["ollama", "lmstudio", "custom-openai"]);
		expect(local("image")).toEqual(["custom-image"]);
		expect(local("video")).toEqual(["custom-video"]);
		expect(presetById("text", "anthropic-native")).toBeUndefined();
	});
});

describe("服务商 logo", () => {
	const logoDir = resolve(__dirname, "../../../public/provider-logos");
	const ALL = Object.values(PROVIDER_PRESETS).flat();

	it("真实服务商都有 logo，只有自定义和 Fake 用文字标记", () => {
		const missing = ALL.filter((p) => !p.custom && p.provider !== "fake" && !p.logo).map((p) => p.id);
		expect(missing).toEqual([]);
		for (const p of ALL) expect(p.mark.length).toBeGreaterThan(0);
	});

	it("每个 logo 文件都存在、是彩色、不带脚本或外链", () => {
		const used = new Set(ALL.flatMap((p) => (p.logo ? [p.logo] : [])));
		for (const name of used) {
			const svg = readFileSync(resolve(logoDir, `${name}.svg`), "utf-8");
			expect(svg.startsWith("<svg"), name).toBe(true);
			expect(svg, name).toMatch(/viewBox="0 0 24 24"/);
			expect(svg, name).not.toMatch(/<script|<image|<foreignObject|href=|url\((?!#)|currentColor/i);
			// 彩色：至少有一种不是黑 / 白的颜色（或渐变），不再是单色遮罩
			const colors = [...svg.matchAll(/(?:fill|stop-color)="([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
			expect(colors.some((c) => !["#000", "#000000", "#fff", "#ffffff", "none"].includes(c)) || /<rect[^>]*fill="#(?:000|fff)"/.test(svg), name).toBe(true);
			expect(svg.length, name).toBeLessThan(4096);
		}
	});

	it("logo 目录里每个文件都有来源许可", () => {
		const license = readFileSync(resolve(logoDir, "LICENSE.txt"), "utf-8");
		expect(license).toMatch(/lobe-icons/);
		expect(license).toMatch(/MIT License/);
		const files = readdirSync(logoDir).filter((f) => f.endsWith(".svg"));
		// 没有用不到的 logo 文件
		expect(new Set(files)).toEqual(new Set(ALL.flatMap((p) => (p.logo ? [`${p.logo}.svg`] : []))));
	});
});

describe("presetConfigValues", () => {
	it("DeepSeek 填好 provider、地址、路径和默认模型，不写密钥", () => {
		const values = presetConfigValues(presetById("text", "deepseek")!);
		expect(values).toEqual({
			TEXT_PROVIDER: "openai",
			TEXT_BASE_URL: "https://api.deepseek.com",
			TEXT_ENDPOINT: "/chat/completions",
			TEXT_MODEL: "deepseek-flash",
		});
		expect(Object.keys(values).some((k) => k.includes("KEY") || k.includes("TOKEN"))).toBe(false);
	});

	it("地域切换换 Base URL（Kimi 海外站）", () => {
		const values = presetConfigValues(presetById("text", "kimi")!, { regionId: "global" });
		expect(values.TEXT_BASE_URL).toBe("https://api.moonshot.ai/v1");
	});

	it("百炼业务空间地址需要 workspaceId，没填时不写 Base URL", () => {
		const preset = presetById("text", "dashscope")!;
		expect(presetConfigValues(preset, { regionId: "ws-cn-beijing" }).TEXT_BASE_URL).toBeUndefined();
		const values = presetConfigValues(preset, { regionId: "ws-cn-beijing", fields: { workspaceId: "ws-abc123" } });
		expect(values.TEXT_BASE_URL).toBe("https://ws-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
	});

	it("Azure 按资源名拼出 v1 地址", () => {
		const preset = presetById("text", "azure")!;
		const region = preset.regions[0]!;
		expect(regionNeeds(region)).toEqual(["resource"]);
		expect(fillBaseUrl(region, { resource: " my-res " })).toBe("https://my-res.openai.azure.com/openai/v1");
		expect(fillBaseUrl(region, {})).toBeNull();
	});

	it("视觉审查预设只写地址和模型，没有接口协议键", () => {
		const values = presetConfigValues(presetById("vision", "qwen-vl")!);
		expect(values.CRITIQUE_VISION_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
		expect(Object.keys(values).some((k) => k.endsWith("_PROVIDER"))).toBe(false);
		expect(presetConfigValues(customPreset("vision"))).toEqual({});
		expect(detectPreset("vision", {}).preset.custom).toBe(true);
	});

	it("自定义只切换 provider，保留已有地址和模型", () => {
		expect(presetConfigValues(presetById("text", "custom-openai")!)).toEqual({ TEXT_PROVIDER: "openai" });
	});

	it("豆包视频走 DOUBAO_* 键，Fake 只切 provider", () => {
		const seedance = presetById("video", "seedance")!;
		expect(presetKeys(seedance)).toEqual({ provider: "VIDEO_PROVIDER", model: "DOUBAO_VIDEO_MODEL", apiKey: "DOUBAO_API_KEY" });
		expect(presetConfigValues(seedance).VIDEO_PROVIDER).toBe("doubao");
		expect(presetConfigValues(presetById("image", "fake-image")!)).toEqual({ IMAGE_PROVIDER: "fake" });
	});

	it("视频服务商原生预设写 VIDEO_* 键，不写接口路径", () => {
		const vendors = ["kling", "vidu", "zhipu-video", "minimax-video", "wan", "veo"];
		for (const id of vendors) {
			const preset = presetById("video", id)!;
			expect(preset.provider, id).not.toBe("openai");
			const values = presetConfigValues(preset);
			expect(values.VIDEO_PROVIDER).toBe(preset.provider);
			expect(values.VIDEO_MODEL).toBe(preset.defaultModel);
			expect(values.VIDEO_ENDPOINT, id).toBeUndefined();
		}
		expect(presetConfigValues(presetById("video", "kling")!, { regionId: "intl" }).VIDEO_BASE_URL).toBe(
			"https://api-singapore.klingai.com",
		);
		expect(presetConfigValues(presetById("video", "veo")!, { regionId: "project", fields: { projectId: "demo-1" } }).VIDEO_BASE_URL).toBe(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/demo-1/locations/us-central1",
		);
		// Sora（OpenAI Videos API 已于 2026-09-24 关停）不提供预设
		expect(PROVIDER_PRESETS.video.some((p) => /sora/i.test(p.id + p.defaultModel))).toBe(false);
	});

	it("Claude 预设走 OpenAI 兼容层；老的 Anthropic 原生配置在自定义里沿用 ANTHROPIC_* 键", () => {
		const compat = presetById("text", "anthropic")!;
		expect(presetConfigValues(compat).TEXT_BASE_URL).toBe("https://api.anthropic.com/v1");
		const custom = customPreset("text");
		expect(effectiveKeys(custom, { TEXT_PROVIDER: "anthropic" })).toEqual({
			provider: "TEXT_PROVIDER",
			baseUrl: "ANTHROPIC_BASE_URL",
			model: "ANTHROPIC_MODEL",
			apiKey: "ANTHROPIC_AUTH_TOKEN",
		});
		expect(effectiveKeys(custom, { TEXT_PROVIDER: "openai" }).baseUrl).toBe("TEXT_BASE_URL");
		expect(effectiveKeys(customPreset("video"), { VIDEO_PROVIDER: "fake" }).baseUrl).toBe("VIDEO_BASE_URL");
	});
});

describe("detectPreset", () => {
	it("当前本机网关配置（muse 系列，127.0.0.1:18790）识别为自定义", () => {
		const detected = detectPreset("text", {
			TEXT_PROVIDER: "openai",
			TEXT_BASE_URL: "http://127.0.0.1:18790/v1",
			TEXT_MODEL: "muse-large",
		});
		expect(detected.preset.id).toBe("custom-openai");
		// 图像、视频两个页签的本机网关配置也落到各自唯一的自定义
		expect(
			detectPreset("image", { IMAGE_PROVIDER: "openai", IMAGE_BASE_URL: "http://127.0.0.1:18790", IMAGE_ENDPOINT: "/v1/images/generations" })
				.preset.id,
		).toBe("custom-image");
		expect(
			detectPreset("video", { VIDEO_PROVIDER: "openai", VIDEO_BASE_URL: "http://127.0.0.1:18790", VIDEO_ENDPOINT: "/v1/videos/generations" })
				.preset.id,
		).toBe("custom-video");
	});

	it("认不出的其它协议（Anthropic 中转、未知地址的服务商）也落到通用自定义，不误认成某个预设", () => {
		expect(detectPreset("text", { TEXT_PROVIDER: "anthropic", ANTHROPIC_BASE_URL: "https://relay.example.com" }).preset.id).toBe(
			"custom-openai",
		);
		expect(detectPreset("video", { VIDEO_PROVIDER: "kling", VIDEO_BASE_URL: "https://proxy.example.com" }).preset.id).toBe("custom-video");
	});

	it("预设写入的值能被反推回同一个预设和地域", () => {
		for (const service of SERVICES) {
			for (const preset of PROVIDER_PRESETS[service]) {
				if (preset.custom) continue;
				for (const region of preset.regions.length ? preset.regions : [undefined]) {
					const fields = Object.fromEntries(regionNeeds(region).map((n) => [n, "abc-1"]));
					const values = presetConfigValues(preset, { regionId: region?.id, fields });
					const detected = detectPreset(service, values);
					// 同一地址可能被多个预设共用时，至少落在同 provider 上
					expect(detected.preset.provider, `${preset.id}/${region?.id}`).toBe(preset.provider);
					if (presetKeys(preset).baseUrl) {
						expect(detected.preset.id, `${preset.id}/${region?.id}`).toBe(preset.id);
						expect(detected.regionId).toBe(region?.id);
						expect(detected.fields).toEqual(fields);
					}
				}
			}
		}
	});

	it("地址末尾斜杠和大小写不影响识别", () => {
		const detected = detectPreset("text", { TEXT_PROVIDER: "openai", TEXT_BASE_URL: "HTTPS://API.DEEPSEEK.COM/" });
		expect(detected.preset.id).toBe("deepseek");
	});

	it("没填 provider 时按后端默认值识别（文本 anthropic、图像 modelscope、视频 openai）", () => {
		expect(detectPreset("text", {}).preset.id).toBe("custom-openai");
		expect(detectPreset("image", { IMAGE_BASE_URL: "https://api-inference.modelscope.cn" }).preset.id).toBe("modelscope");
		expect(detectPreset("video", {}).preset.id).toBe("custom-video");
	});

	it("支持小写回退键", () => {
		expect(detectPreset("text", { text_provider: "fake" }).preset.id).toBe("fake-text");
	});
});

describe("configLabels", () => {
	it("主要配置项都有中文名，未登记的键退回环境变量名", () => {
		for (const key of ["TEXT_BASE_URL", "IMAGE_MODEL", "DOUBAO_API_KEY", "ANTHROPIC_AUTH_TOKEN", "redis_url"]) {
			expect(getConfigLabel(key)).toMatch(/[\u4e00-\u9fa5]|API Key|Redis/);
		}
		expect(getConfigLabel("some_new_key")).toBe("SOME_NEW_KEY");
	});
});
