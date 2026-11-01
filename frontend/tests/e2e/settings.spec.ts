import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * 设置页 e2e：配置接口全部 mock，绝不读写真实配置。
 * 密钥只有脱敏占位值（不是任何真实密钥）。
 */
type Item = { key: string; value: string | null; is_sensitive: boolean; is_masked: boolean; source: "db" | "env" | "default" };
const item = (key: string, value: string | null, sensitive = false): Item => ({
	key,
	value,
	is_sensitive: sensitive,
	is_masked: sensitive,
	source: "db",
});

export const LOCAL_GATEWAY_CONFIG: Item[] = [
	item("TEXT_PROVIDER", "openai"),
	item("TEXT_BASE_URL", "http://127.0.0.1:18790/v1"),
	item("TEXT_ENDPOINT", "/chat/completions"),
	item("TEXT_MODEL", "muse-spark"),
	item("TEXT_API_KEY", "sk-****", true),
	item("TEXT_REASONING_EFFORT", ""),
	item("ANTHROPIC_BASE_URL", ""),
	item("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929"),
	item("ANTHROPIC_AUTH_TOKEN", "****", true),
	item("IMAGE_PROVIDER", "openai"),
	item("IMAGE_BASE_URL", "http://127.0.0.1:18790"),
	item("IMAGE_ENDPOINT", "/v1/images/generations"),
	item("IMAGE_MODEL", "muse-image"),
	item("IMAGE_API_KEY", "sk-****", true),
	item("ENABLE_IMAGE_TO_IMAGE", "true"),
	item("VIDEO_PROVIDER", "openai"),
	item("VIDEO_BASE_URL", "http://127.0.0.1:18790"),
	item("VIDEO_ENDPOINT", "/v1/videos/generations"),
	item("VIDEO_MODEL", "muse-video"),
	item("VIDEO_API_KEY", "sk-****", true),
	item("VIDEO_RATIO", "16:9"),
	item("DOUBAO_API_KEY", "****", true),
	item("DOUBAO_VIDEO_MODEL", "doubao-seedance-1-5-pro-251215"),
	item("DOUBAO_VIDEO_DURATION", "5"),
	item("DOUBAO_VIDEO_RATIO", "adaptive"),
	item("ENABLE_IMAGE_TO_VIDEO", "true"),
];

export async function mockConfig(
	page: Page,
	opts: {
		testResponse?: Record<string, unknown>;
		onTest?: (req: Request) => void;
		onSave?: (req: Request) => void;
		config?: Item[];
	} = {},
) {
	await page.route("**/api/v1/config**", (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (path === "/api/v1/config/test-connection") {
			opts.onTest?.(req);
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(opts.testResponse ?? { success: true, message: "连接成功", details: "", status: "valid" }),
			});
		}
		if (path === "/api/v1/config" && req.method() === "GET") {
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.config ?? LOCAL_GATEWAY_CONFIG) });
		}
		if (path === "/api/v1/config") {
			opts.onSave?.(req);
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ updated: 0, skipped: 0, restart_required: false, restart_keys: [], message: "ok" }),
			});
		}
		return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
	});
}

export async function openSettings(page: Page) {
	await page.goto("/");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await expect(page.getByRole("dialog", { name: /系统设置/ })).toBeVisible();
}

test("测试连接 sends the saved local gateway URL and shows the Chinese failure reason", async ({ page }) => {
	const bodies: Array<Record<string, unknown>> = [];
	await mockConfig(page, {
		testResponse: {
			success: false,
			status: "invalid",
			message: "API Key 无效",
			details: "服务返回 401：密钥填错、已过期，或与所选地域不匹配。",
		},
		onTest: (req) => bodies.push(req.postDataJSON() as Record<string, unknown>),
	});
	await openSettings(page);
	await page.getByRole("tab", { name: /文本/ }).click();
	await page.getByRole("button", { name: "测试连接" }).click();

	await expect(page.getByText("API Key 无效")).toBeVisible();
	await expect(page.getByText(/与所选地域不匹配/)).toBeVisible();
	expect(bodies).toHaveLength(1);
	expect(bodies[0]!.service).toBe("llm");
	const overrides = bodies[0]!.config_overrides as Record<string, string>;
	expect(overrides.TEXT_BASE_URL).toBe("http://127.0.0.1:18790/v1");
	// 脱敏占位值原样回传，由后端忽略，不会被当成新密钥
	expect(overrides.TEXT_API_KEY).toContain("***");
});

const savedValues = (req: Request) => {
	const body = req.postDataJSON() as { configs?: Record<string, unknown> } & Record<string, unknown>;
	return (body.configs ?? body) as Record<string, string>;
};

test("当前本机网关配置在文本 / 图像 / 视频里都识别为唯一的「自定义」，原值不变", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	await mockConfig(page, { onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	const detail = dialog.getByTestId("preset-detail");
	await expect(dialog.getByRole("radio", { name: /自定义 · OpenAI 兼容/ })).toHaveAttribute("aria-checked", "true");
	await expect(dialog.getByRole("button", { name: /高级设置/ })).toHaveAttribute("aria-expanded", "true");
	// 通用自定义：地址、模型、密钥就地填写
	await expect(detail.locator("#TEXT_BASE_URL")).toHaveValue("http://127.0.0.1:18790/v1");
	await expect(detail.getByLabel("模型", { exact: true })).toHaveValue("muse-spark");
	await expect(dialog.locator("#TEXT_ENDPOINT")).toHaveValue("/chat/completions");
	// 中文标签为主，环境变量名作次要信息
	const baseField = dialog.locator('[data-config-key="TEXT_BASE_URL"]');
	await expect(baseField.getByText("接口地址（Base URL）")).toBeVisible();
	await expect(baseField.getByText("TEXT_BASE_URL", { exact: true })).toBeVisible();

	for (const [tab, prefix, base, endpoint, model] of [
		["图像服务", "IMAGE", "http://127.0.0.1:18790", "/v1/images/generations", "muse-image"],
		["视频服务", "VIDEO", "http://127.0.0.1:18790", "/v1/videos/generations", "muse-video"],
	] as const) {
		await dialog.getByRole("tab", { name: new RegExp(tab) }).click();
		await expect(dialog.getByRole("radio", { name: /自定义 · OpenAI 兼容/ })).toHaveAttribute("aria-checked", "true");
		await expect(detail.locator(`#${prefix}_BASE_URL`)).toHaveValue(base);
		await expect(detail.getByLabel("模型", { exact: true })).toHaveValue(model);
		await expect(dialog.locator(`#${prefix}_ENDPOINT`)).toHaveValue(endpoint);
	}
	// 只是打开看，不改任何值：保存按钮无事可做
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await page.waitForTimeout(300);
	expect(saves).toEqual([]);
});

test("「本地与自定义」只剩本地服务和一个通用自定义；测试模式是小选项", async ({ page }) => {
	await mockConfig(page);
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	const presets = dialog.getByTestId("provider-presets");
	const localCards = presets.locator("div:has(> p:text-is('本地与自定义')) [data-preset]");
	for (const [tab, ids] of [
		["文本生成", ["ollama", "lmstudio", "custom-openai"]],
		["图像服务", ["custom-image"]],
		["视频服务", ["custom-video"]],
	] as const) {
		await dialog.getByRole("tab", { name: new RegExp(tab) }).click();
		await expect(localCards).toHaveCount(ids.length);
		expect(await localCards.evaluateAll((els) => els.map((el) => el.getAttribute("data-preset")))).toEqual(ids);
		await expect(presets.getByRole("radio", { name: /自定义/ })).toHaveCount(1);
		await expect(presets.locator('[data-preset^="anthropic-native"]')).toHaveCount(0);
		// Fake 不再是卡片：一个小的「测试模式」选项
		const testMode = presets.getByRole("radio", { name: /测试模式/ });
		await expect(testMode).toHaveCount(1);
		const box = await testMode.boundingBox();
		expect(box!.height).toBeLessThan(40);
	}
	await presets.getByRole("radio", { name: /测试模式/ }).click();
	await expect(dialog.getByTestId("preset-detail")).toContainText("不调用任何外部服务");
});

test("老的 Anthropic 原生 / 中转配置也落到通用自定义，协议和地址保持不变", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	const config = LOCAL_GATEWAY_CONFIG.map((i) =>
		i.key === "TEXT_PROVIDER" ? item("TEXT_PROVIDER", "anthropic") : i.key === "ANTHROPIC_BASE_URL" ? item("ANTHROPIC_BASE_URL", "https://relay.example.com") : i,
	);
	await mockConfig(page, { config, onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	const detail = dialog.getByTestId("preset-detail");
	const custom = dialog.getByRole("radio", { name: /自定义 · OpenAI 兼容/ });
	await expect(custom).toHaveAttribute("aria-checked", "true");
	await expect(detail.getByTestId("custom-protocol")).toContainText("Anthropic 原生");
	await expect(detail.locator("#ANTHROPIC_BASE_URL")).toHaveValue("https://relay.example.com");
	await expect(detail.getByLabel("模型", { exact: true })).toHaveValue("claude-sonnet-4-5-20250929");
	// 再点一次自定义不会把协议改成 OpenAI；协议只在高级设置里改
	await custom.click();
	await expect(dialog.getByTestId("advanced-settings").getByRole("radio", { name: /Anthropic Claude/ })).toBeChecked();
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await page.waitForTimeout(300);
	expect(saves).toEqual([]);
});

test("服务商卡片显示品牌彩色 logo，深色模式下也放在浅色方块里；高级设置的单选卡用主色", async ({ page }) => {
	const logoResponses: number[] = [];
	page.on("response", (res) => {
		if (res.url().includes("/provider-logos/")) logoResponses.push(res.status());
	});
	await page.emulateMedia({ colorScheme: "dark" });
	await page.addInitScript(() => localStorage.setItem("openoii-theme", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
	await mockConfig(page);
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	const presets = dialog.getByTestId("provider-presets");
	const tile = presets.locator('[data-preset="deepseek"] [data-logo="deepseek"]');
	const img = tile.locator("img");
	await expect(img).toBeVisible();
	await expect(img).toHaveAttribute("src", "/provider-logos/deepseek.svg");
	await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
	// 方块是固定的浅色，尺寸统一
	const bg = await tile.evaluate((el) => getComputedStyle(el).backgroundColor);
	const [r, g, b] = (bg.match(/[\d.]+/g) ?? []).map(Number);
	const lightness = bg.startsWith("oklch") ? r! : (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
	expect(lightness).toBeGreaterThan(0.9);
	const sizes = await presets.locator(".provider-tile").evaluateAll((els) => [...new Set(els.map((el) => `${el.clientWidth}x${el.clientHeight}`))]);
	expect(sizes).toEqual(["28x28"]);
	// 自定义没有 logo，退回文字标记
	await expect(presets.locator('[data-preset="custom-openai"] img')).toHaveCount(0);
	await expect.poll(() => logoResponses.length).toBeGreaterThan(5);
	expect(logoResponses.every((s) => s === 200 || s === 304)).toBe(true);
	// 高级设置里选中的单选卡不再是青色
	const advanced = dialog.getByTestId("advanced-settings");
	const checked = advanced.locator('label:has(input[type="radio"]:checked)').first();
	await expect(checked).toBeVisible();
	const border = await checked.evaluate((el) => getComputedStyle(el).borderColor);
	expect(border).not.toMatch(/rgb\(11, 110, 127\)/);
});

test("选 DeepSeek 预设自动填好地址、路径和模型，保存时不改密钥", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	await mockConfig(page, { onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });

	await dialog.getByRole("radio", { name: /DeepSeek/ }).click();
	await expect(dialog.getByRole("radio", { name: /DeepSeek/ })).toHaveAttribute("aria-checked", "true");
	const detail = dialog.getByTestId("preset-detail");
	await expect(detail.getByTestId("preset-base-url")).toContainText("https://api.deepseek.com");
	await expect(detail.getByRole("link", { name: "获取 API Key" })).toHaveAttribute("href", /platform\.deepseek\.com/);
	await detail.getByRole("button", { name: "deepseek-v4-pro" }).click();
	await expect(detail.getByLabel("模型", { exact: true })).toHaveValue("deepseek-v4-pro");
	// 高级设置里的原始字段同步变化
	await expect(dialog.locator("#TEXT_BASE_URL")).toHaveValue("https://api.deepseek.com");
	await expect(dialog.locator("#TEXT_ENDPOINT")).toHaveValue("/chat/completions");

	await dialog.getByRole("button", { name: "保存配置" }).click();
	await expect.poll(() => saves.length).toBe(1);
	expect(saves[0]).toMatchObject({ TEXT_BASE_URL: "https://api.deepseek.com", TEXT_MODEL: "deepseek-v4-pro" });
	expect(Object.keys(saves[0]!)).not.toContain("TEXT_API_KEY");
});

test("百炼：切地域换地址，专属域名需要填业务空间 ID", async ({ page }) => {
	await mockConfig(page);
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	await dialog.getByRole("radio", { name: /阿里云百炼/ }).click();
	const detail = dialog.getByTestId("preset-detail");
	await expect(dialog.locator("#TEXT_BASE_URL")).toHaveValue("https://dashscope.aliyuncs.com/compatible-mode/v1");

	await detail.getByRole("radio", { name: "新加坡" }).click();
	await expect(dialog.locator("#TEXT_BASE_URL")).toHaveValue("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");

	await detail.getByRole("radio", { name: "北京 · 专属域名" }).click();
	await expect(detail.getByTestId("preset-base-url")).toContainText("填写上面的字段后自动生成");
	await detail.getByLabel("业务空间 ID").fill("llm-demo01");
	await expect(dialog.locator("#TEXT_BASE_URL")).toHaveValue("https://llm-demo01.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
	await expect(dialog.getByRole("radio", { name: /阿里云百炼/ })).toHaveAttribute("aria-checked", "true");
});

test("高级模式：手动改地址后回到「自定义」，并原样保存", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	await mockConfig(page, { onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	await dialog.getByRole("radio", { name: /DeepSeek/ }).click();
	await dialog.locator("#TEXT_BASE_URL").fill("https://gateway.example.com/v1");
	await expect(dialog.getByRole("radio", { name: /自定义 · OpenAI 兼容/ })).toHaveAttribute("aria-checked", "true");
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await expect.poll(() => saves.length).toBe(1);
	expect(saves[0]!.TEXT_BASE_URL).toBe("https://gateway.example.com/v1");
});

test("视频：选火山方舟 Seedance 切到豆包原生配置", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	await mockConfig(page, { onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	await dialog.getByRole("tab", { name: /视频服务/ }).click();
	await dialog.getByRole("radio", { name: /火山方舟 Seedance/ }).click();
	await expect(dialog.getByTestId("preset-detail").getByLabel("模型", { exact: true })).toHaveValue("doubao-seedance-2-5-260628");
	// 原配置是自定义，高级设置本来就展开着
	await expect(dialog.getByRole("button", { name: /高级设置/ })).toHaveAttribute("aria-expanded", "true");
	await expect(dialog.getByText("豆包视频配置")).toBeVisible();
	await expect(dialog.locator("#DOUBAO_VIDEO_RATIO")).toBeVisible();
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await expect.poll(() => saves.length).toBe(1);
	expect(saves[0]).toMatchObject({ VIDEO_PROVIDER: "doubao", DOUBAO_VIDEO_MODEL: "doubao-seedance-2-5-260628" });
});

test("视频：选可灵 / Veo 切到服务商原生接口，地域和项目 ID 拼出地址", async ({ page }) => {
	const saves: Record<string, string>[] = [];
	await mockConfig(page, { onSave: (req) => saves.push(savedValues(req)) });
	await openSettings(page);
	const dialog = page.getByRole("dialog", { name: /系统设置/ });
	await dialog.getByRole("tab", { name: /视频服务/ }).click();
	const presets = dialog.getByTestId("provider-presets");
	for (const [id, logo] of [["kling", "kling"], ["vidu", "vidu"], ["zhipu-video", "zhipu"], ["minimax-video", "hailuo"], ["wan", "bailian"], ["veo", "deepmind"]]) {
		await expect(presets.locator(`[data-preset="${id}"] [data-logo="${logo}"]`)).toHaveCount(1);
	}

	await dialog.getByRole("radio", { name: /可灵 Kling/ }).click();
	const detail = dialog.getByTestId("preset-detail");
	await detail.getByRole("radio", { name: "新加坡" }).click();
	await expect(dialog.locator("#VIDEO_BASE_URL")).toHaveValue("https://api-singapore.klingai.com");
	await expect(dialog.getByText("服务商原生接口配置")).toBeVisible();
	await expect(dialog.locator("#VIDEO_RATIO")).toBeVisible();
	await expect(dialog.locator("#VIDEO_ENDPOINT")).toHaveCount(0);
	// 原生接口的地址说明按服务商写，不再说「OpenAI 兼容」
	const baseField = dialog.locator('[data-config-key="VIDEO_BASE_URL"]');
	await expect(baseField).toContainText("可灵原生接口的基础地址");
	await expect(baseField).not.toContainText("OpenAI 兼容");

	await dialog.getByRole("radio", { name: /Google Veo/ }).click();
	await detail.getByRole("radio", { name: /项目/ }).click();
	await detail.getByLabel("项目 ID").fill("demo-proj");
	await expect(dialog.locator("#VIDEO_BASE_URL")).toHaveValue(
		"https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/us-central1",
	);
	await dialog.getByRole("button", { name: "保存配置" }).click();
	await expect.poll(() => saves.length).toBe(1);
	expect(saves[0]).toMatchObject({ VIDEO_PROVIDER: "veo", VIDEO_MODEL: "veo-3.1-fast-generate-001" });
	expect(Object.keys(saves[0]!)).not.toContain("VIDEO_API_KEY");
});
