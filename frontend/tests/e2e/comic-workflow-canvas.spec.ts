import { expect, test, type Page } from "@playwright/test";

// 排序 / 补齐收进了画布工具条的「更多」菜单
async function openSortMode(page: Page) {
	await page.getByRole("button", { name: "更多画布操作" }).click();
	await page.getByRole("menuitem", { name: "排序九宫格" }).click();
}

const providerSettings = {
	text: {
		selected_key: "fake",
		source: "default",
		resolved_key: "fake",
		valid: true,
		status: "valid",
		reason_code: null,
		reason_message: null,
	},
	image: {
		selected_key: "fake",
		source: "default",
		resolved_key: "fake",
		valid: true,
		status: "valid",
		reason_code: null,
		reason_message: null,
	},
	video: {
		selected_key: "fake",
		source: "default",
		resolved_key: "fake",
		valid: true,
		status: "valid",
		reason_code: null,
		reason_message: null,
	},
};

const project = {
	id: 7,
	title: "创意工作台",
	story: "导演把故事拆成角色、分镜、视频，并在画布中审阅。",
	style: "anime",
	summary: "一个完整的漫剧工作流测试项目。",
	story_outline: null,
	visual_bible: null,
	outline_approved: true,
	video_url: "https://example.test/final.mp4",
	status: "ready",
	target_shot_count: 2,
	character_hints: [],
	creation_mode: "review",
	reference_images: [],
	exports: [],
	provider_settings: providerSettings,
	created_at: "2026-05-05T00:00:00Z",
	updated_at: "2026-05-05T00:00:00Z",
};

const characters = [
	{
		id: 1,
		project_id: 7,
		name: "导演小陈",
		description: "执行力强，负责审阅每一步生成结果。",
		image_url: "https://example.test/character.png",
		reference_images: [],
		has_embedding: true,
		visual_notes: "现代服装",
		approval_state: "approved",
		approval_version: 1,
		approved_at: "2026-05-05T01:00:00Z",
		approved_name: "导演小陈",
		approved_description: "执行力强，负责审阅每一步生成结果。",
		approved_image_url: "https://example.test/character.png",
	},
];

const shots = [
	{
		id: 1,
		project_id: 7,
		order: 1,
		description: "创作工作室中，导演按下开始生成按钮。",
		prompt: "director starts generation",
		image_prompt: "comic studio first frame",
		image_url: "https://example.test/shot-1.png",
		video_url: "https://example.test/shot-1.mp4",
		duration: 2,
		camera: "中景推近",
		motion_note: null,
		scene: "创作工作室",
		action: "按下按钮",
		expression: "期待",
		lighting: "屏幕冷光",
		dialogue: "开始本地测试。",
		sfx: null,
		seed: null,
		character_ids: [1],
		approval_state: "approved",
		approval_version: 1,
		approved_at: "2026-05-05T02:00:00Z",
		approved_description: "创作工作室中，导演按下开始生成按钮。",
		approved_prompt: "director starts generation",
		approved_image_prompt: "comic studio first frame",
		approved_duration: 2,
		approved_camera: "中景推近",
		approved_motion_note: null,
		approved_scene: "创作工作室",
		approved_action: "按下按钮",
		approved_expression: "期待",
		approved_lighting: "屏幕冷光",
		approved_dialogue: "开始本地测试。",
		approved_sfx: null,
		approved_character_ids: [1],
	},
	{
		id: 2,
		project_id: 7,
		order: 2,
		description: "最终时间线里，镜头被拼成完整短片。",
		prompt: "timeline composes video",
		image_prompt: "timeline final frame",
		image_url: "https://example.test/shot-2.png",
		video_url: "https://example.test/shot-2.mp4",
		duration: 2,
		camera: "俯拍",
		motion_note: null,
		scene: "视频时间线",
		action: "拼接片段",
		expression: "满意",
		lighting: "柔和高光",
		dialogue: "完整流程跑通。",
		sfx: null,
		seed: null,
		character_ids: [1],
		approval_state: "approved",
		approval_version: 1,
		approved_at: "2026-05-05T02:10:00Z",
		approved_description: "最终时间线里，镜头被拼成完整短片。",
		approved_prompt: "timeline composes video",
		approved_image_prompt: "timeline final frame",
		approved_duration: 2,
		approved_camera: "俯拍",
		approved_motion_note: null,
		approved_scene: "视频时间线",
		approved_action: "拼接片段",
		approved_expression: "满意",
		approved_lighting: "柔和高光",
		approved_dialogue: "完整流程跑通。",
		approved_sfx: null,
		approved_character_ids: [1],
	},
];

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		class MockWebSocket {
			static OPEN = 1;
			static CLOSED = 3;
			readyState = MockWebSocket.OPEN;
			onopen: null | ((event: Event) => void) = null;
			onclose: null | ((event: Event) => void) = null;
			onmessage: null | ((event: MessageEvent<string>) => void) = null;
			onerror: null | ((event: Event) => void) = null;

			constructor(_url: string) {
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}

			send(_data: string) {}

			close() {
				this.readyState = MockWebSocket.CLOSED;
				this.onclose?.(new Event("close"));
			}
		}

		Object.defineProperty(window, "WebSocket", {
			configurable: true,
			writable: true,
			value: MockWebSocket,
		});
	});

	const transparentPixel = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
		"base64",
	);
	await page.route("https://example.test/**", (route) => {
		const isVideo = route.request().url().endsWith(".mp4");
		return route.fulfill({
			status: 200,
			contentType: isVideo ? "video/mp4" : "image/png",
			body: isVideo ? Buffer.from("") : transparentPixel,
		});
	});

	await page.route("**/api/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const method = route.request().method();
		const path = url.pathname;
		const json = (body: unknown, status = 200) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});

		if (path === "/api/v1/config") return json([]);
		if (path === "/api/v1/projects" && method === "GET") {
			return json({ items: [project], total: 1 });
		}
		if (path === "/api/v1/projects/7" && method === "GET") return json(project);
		if (path === "/api/v1/projects/7/characters" && method === "GET") {
			return json(characters);
		}
		if (path === "/api/v1/projects/7/shots" && method === "GET") {
			return json(shots);
		}
		if (path === "/api/v1/projects/7/messages" && method === "GET") {
			return json([]);
		}
		if (path === "/api/v1/projects/7/runs/current" && method === "GET") {
			return json(null);
		}
		if (path === "/api/v1/projects/7/runs/regenerate-plan" && method === "GET") {
			return json({
				project_id: 7,
				has_content: true,
				character_count: 1,
				shot_count: 1,
				has_final_video: false,
				stages: ["剧本", "角色", "分镜", "渲染", "合成"],
				estimate: { seconds_low: 180, seconds_high: 480, text_calls: 4, image_calls: 2, video_calls: 1, basis: "heuristic" },
				previous_version: null,
			});
		}
		if (path === "/api/v1/projects/7/export/webtoon" && method === "POST") {
			return json({ export_id: "test-export", status: "completed", download_url: "/static/test.png" });
		}
		if (path === "/api/v1/projects/7/export/test-export/status" && method === "GET") {
			return json({ export_id: "test-export", status: "completed", download_url: "/static/test.png" });
		}
		if (path === "/api/v1/assets" && method === "GET") {
			return json({ items: [], total: 0, page: 1, page_size: 50 });
		}

		return json({ error: { message: `Unhandled route: ${method} ${path}` } }, 404);
	});
});

test("comic workflow canvas supports core review interactions", async ({ page }) => {
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("response", (response) => {
		if (response.status() >= 400) {
			consoleErrors.push(`${response.status()} ${response.url()}`);
		}
	});

	await page.goto("/project/7");
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');

	// Brief 不在画布上：它是右栏 Inspector 的项目级上下文
	await expect(page.getByRole("region", { name: "角色" })).toBeAttached();
	await expect(page.getByRole("region", { name: "九宫格分镜" })).toBeVisible();
	await expect(page.getByRole("region", { name: "故事" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "一致性评估" })).toHaveCount(0);

	// 每个「下载成片」都走 final-video 端点（attachment 存盘），不是直链到 mp4
	const downloads = page.getByRole("link", { name: /下载成片/ });
	await expect(downloads.first()).toBeAttached();
	for (const link of await downloads.all()) {
		await expect(link).toHaveAttribute("href", /\/api\/v1\/projects\/7\/final-video$/);
	}

	// 窄于 1440px 时 Agent 面板默认收起成胶囊，不挡画布
	const agentPanel = page.locator("aside[aria-label='工作流活动']");
	await expect(page.getByRole("button", { name: "展开活动面板" })).toBeVisible();

	const card = page.locator('.react-flow__node[data-id="shot:1"]');
	// 自动适配：卡片标题的屏幕字号 ≥ 12px（可读下限；整块放不下时以分镜区为中心）
	await expect
		.poll(() =>
			card.evaluate((el) => {
				// 画布缩放 = 卡片屏幕宽度 / 布局宽度（宽元素，取整误差小）
				const scale = el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth;
				const title = el.querySelector("p.font-bold");
				return title ? parseFloat(getComputedStyle(title).fontSize) * scale : 0;
			}),
		)
		.toBeGreaterThanOrEqual(11.95);

	// 手动「适应视图」看全图（#54）：所有分区都在画布可见范围内。
	// 先等首次自动适配跑完，免得它在点击之后又把视口拉回可读下限
	await page.waitForTimeout(300);
	await page.getByRole("button", { name: "适应视图" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
				if (!pane) return false;
				const frames = [...document.querySelectorAll(".react-flow__node-frame")];
				return frames.length > 0 && frames.every((node) => {
					const r = node.getBoundingClientRect();
					return r.left >= pane.left - 1 && r.right <= pane.right + 1 && r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1;
				});
			}),
		)
		.toBe(true);
	const before = await card.boundingBox();
	expect(before).not.toBeNull();
	if (!before) return;

	await openSortMode(page);
	await expect(page.getByRole("button", { name: "完成分镜排序" })).toBeVisible();
	// 排序模式切换后分镜才可拖：拖不动就再拖一次
	await expect(async () => {
		const start = await card.boundingBox();
		if (!start) throw new Error("card not visible");
		await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
		await page.mouse.down();
		await page.mouse.move(start.x + start.width / 2 + 80, start.y + start.height / 2 + 24, {
			steps: 10,
		});
		await page.mouse.up();
		const moved = await card.boundingBox();
		expect(Math.abs((moved?.x ?? before.x) - before.x)).toBeGreaterThan(20);
	}).toPass({ timeout: 5000 });

	await page.getByRole("button", { name: "完成分镜排序" }).click();
	await page.getByRole("button", { name: "整理画布" }).click();
	await expect(card).toBeVisible();

	await card.click();
	for (const name of ["概览", "属性", "生成", "历史"]) {
		await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
	}

	await expect(page.getByRole("button", { name: "重排镜头顺序" })).toHaveCount(0);

	await page.getByRole("button", { name: "工作台工具" }).click();
	await page.getByRole("menuitem", { name: "导出 Webtoon 长图" }).click();
	await expect(page.getByText("Webtoon 长图已生成")).toBeVisible();

	await page.locator('button[aria-label="预览视频"]').first().click();
	const videoPreview = page.getByRole("dialog", { name: /视频预览/ });
	await expect(videoPreview).toBeVisible();
	await videoPreview.getByRole("button", { name: "关闭" }).click();

	await page.getByRole("button", { name: "打开资产库" }).click();
	await expect(page.getByRole("heading", { name: "资产库" })).toBeVisible();
	await page.getByRole("button", { name: "关闭资产库" }).click();

	await page.getByRole("button", { name: "展开活动面板" }).click();
	await expect(agentPanel).toBeVisible();
	await agentPanel.getByRole("button", { name: "收起活动面板" }).click();
	await expect(agentPanel).toHaveCount(0);
	await expect(page.getByPlaceholder("让助手调整所选内容…")).toBeVisible();

	expect(consoleErrors).toEqual([]);
});

test("mobile studio is one readable column at 390×844", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/project/7");

	const preview = page.getByRole("region", { name: "项目预览" });
	await expect(preview).toBeVisible();
	await expect(page.locator(".react-flow")).toHaveCount(0);
	await expect(page.locator("aside[aria-label='工作流活动']")).toHaveCount(0);

	// 从上到下：状态 → 待处理 → 成片 → 分镜 → 角色 → 最近动态
	const headings = await preview.getByRole("heading").allInnerTexts();
	const order = ["分镜", "角色", "最近动态"].map((name) =>
		headings.findIndex((text) => text.startsWith(name)),
	);
	expect(order.every((index) => index >= 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);

	await expect(page.getByTestId("mobile-final-video")).toBeVisible();
	await expect(page.getByRole("link", { name: /下载成片/ })).toBeVisible();
	await expect(page.locator('[data-shell="prompt-bar"]')).toBeVisible();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});

test("the project switcher's chevron stays whole and legible next to the title at 390px", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/project/7");
	const switcher = page.locator('header button[aria-haspopup="listbox"]');
	await expect(switcher).toBeVisible();
	const geo = await switcher.evaluate((button) => {
		const clip = button.parentElement!.getBoundingClientRect();
		const icons = [...button.querySelectorAll("svg")].filter((svg) => svg.getBoundingClientRect().width > 0);
		const chevron = icons.at(-1)!.getBoundingClientRect();
		return { clipRight: clip.right, buttonRight: button.getBoundingClientRect().right, chevronRight: chevron.right, chevronSize: chevron.width, icons: icons.length };
	});
	// 按钮不比裁切它的 wrapper 宽：chevron 不会被切成半截
	expect(geo.buttonRight).toBeLessThanOrEqual(geo.clipRight + 0.5);
	expect(geo.chevronRight).toBeLessThanOrEqual(geo.clipRight + 0.5);
	expect(geo.chevronSize).toBeGreaterThanOrEqual(16);
	// 窄屏只留标题和 chevron
	expect(geo.icons).toBe(1);
});

test("panels re-fit the board until the user pans", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/project/7");
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');
	const viewport = page.locator(".react-flow__viewport");
	const transform = () => viewport.getAttribute("style");

	const before = await transform();
	await page.getByRole("button", { name: "收起检查器" }).click();
	await expect.poll(transform).not.toBe(before);

	await page.mouse.move(720, 400);
	await page.mouse.wheel(0, 120);
	await page.waitForTimeout(300);
	const panned = await transform();
	await page.getByRole("button", { name: "展开检查器" }).click();
	await page.waitForTimeout(500);
	expect(await transform()).toBe(panned);
});

test("shots reorder from the keyboard with a live announcement", async ({ page }) => {
	const bodies: unknown[] = [];
	await page.goto("/project/7");
	await page.route("**/api/v1/projects/7/shots/reorder", async (route) => {
		bodies.push(route.request().postDataJSON());
		await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
	});
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');
	await openSortMode(page);
	const live = page.locator("[aria-live='polite']", { hasText: "排序模式" });
	await expect(live).toBeVisible();

	await page.locator('.react-flow__node[data-id="shot:1"]').focus();
	await page.keyboard.press("Alt+ArrowRight");
	await expect(page.locator("[aria-live='polite']", { hasText: "移到第 2 格" })).toBeVisible();
	await expect.poll(() => bodies.length).toBe(1);
	const items = (bodies[0] as { items: { shot_id: number; order: number }[] }).items;
	expect(items[1]).toEqual({ shot_id: 1, order: 2 });
	// 键盘排序后留在排序模式，可以继续移动
	await expect(page.getByRole("button", { name: "完成分镜排序" })).toBeVisible();
});

test("right-clicking a card opens its actions until Escape", async ({ page }) => {
	await page.goto("/project/7");
	const card = page.locator('.react-flow__node[data-id="shot:1"]');
	await card.click({ button: "right" });
	const menu = page.getByRole("region", { name: /的操作$/ });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("button", { name: /重做首帧/ })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
});

test("canvas toolbar keeps primary actions visible and rare ones in a keyboard menu", async ({ page }) => {
	await page.goto("/project/7");
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');
	const toolbar = page.getByRole("toolbar", { name: "画布工具栏" });
	await expect(toolbar.getByRole("button")).toHaveCount(9);
	await expect(toolbar.getByRole("button", { name: "整理画布" })).toHaveText("整理");
	await expect(toolbar.getByRole("button", { name: "排序九宫格" })).toHaveCount(0);

	// V / H 切换工具（输入框里不抢）
	await page.keyboard.press("h");
	await expect(toolbar.getByRole("button", { name: "抓手工具" })).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.press("v");
	await expect(toolbar.getByRole("button", { name: "选择工具" })).toHaveAttribute("aria-pressed", "true");

	const more = toolbar.getByRole("button", { name: "更多画布操作" });
	await more.click();
	const menu = page.getByRole("menu", { name: "更多画布操作" });
	await expect(menu).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "排序九宫格" })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "补齐空格 · 首帧" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(more).toBeFocused();
	// 菜单向上展开，不被画布底边裁掉
	await more.click();
	const barBox = await toolbar.boundingBox();
	await expect
		.poll(async () => {
			const box = await menu.boundingBox();
			return box && barBox ? Math.round(box.y + box.height - barBox.y) : 999;
		})
		.toBeLessThanOrEqual(2);
});


test("the board paints only between the side panels, nothing under or beside them", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/project/7");
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');
	const box = (selector: string) =>
		page.locator(selector).first().evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right };
		});
	const agent = await box('aside:has(button[aria-label="收起活动面板"])');
	const inspector = await box('aside:has(button[aria-label="收起检查器"])');
	await expect
		.poll(async () => {
			const flow = await box(".react-flow");
			return [Math.round(flow.left - agent.right), Math.round(inspector.left - flow.right)];
		})
		.toEqual([0, 0]);

	// 每段节点文字可见的部分都点得到它自己：没有被面板、工具栏或提示栏压住
	const covered = await page.evaluate(() => {
		const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
		const out: string[] = [];
		for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node p, .react-flow__node span")) {
			if (!el.textContent?.trim() || el.children.length > 0) continue;
			const r = el.getBoundingClientRect();
			const left = Math.max(r.left, flow.left + 24);
			const right = Math.min(r.right, flow.right - 24);
			const top = Math.max(r.top, flow.top);
			const bottom = Math.min(r.bottom, flow.bottom);
			if (right <= left || bottom <= top) continue;
			const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
			if (!hit || !el.closest(".react-flow__node")!.contains(hit)) out.push(el.textContent.trim().slice(0, 20));
		}
		return out;
	});
	expect(covered).toEqual([]);
});

test("opening or closing the activity panel after a pan leaves the board where it is", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/project/7");
	const shot = page.locator('.react-flow__node[data-id="shot:1"]');
	await shot.waitFor();
	await page.mouse.move(720, 400);
	await page.mouse.wheel(0, 120);
	await page.waitForTimeout(300);
	const at = async () => {
		const r = await shot.boundingBox();
		return r ? [Math.round(r.x), Math.round(r.y)] : null;
	};
	const panned = await at();
	await page.getByRole("button", { name: "收起活动面板" }).click();
	await page.waitForTimeout(400);
	expect(await at()).toEqual(panned);
	await page.getByRole("button", { name: "展开活动面板" }).click();
	await page.waitForTimeout(400);
	expect(await at()).toEqual(panned);
});

test("React Flow attribution never sits under the collapsed 项目 button", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/project/7");
	await page.waitForSelector('.react-flow__node[data-id="shot:1"]');
	await page.getByRole("button", { name: "收起检查器" }).click();
	await page.getByRole("button", { name: "收起活动面板" }).click();
	const pill = page.getByRole("button", { name: "展开检查器" });
	await expect(pill).toBeVisible();
	const attribution = page.locator(".react-flow__attribution");
	await expect(attribution).toBeVisible();
	const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
		a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
	const a = (await attribution.boundingBox())!;
	for (const other of [pill, page.getByRole("toolbar", { name: "画布工具栏" }), page.locator('[data-shell="prompt-bar"]').first()]) {
		if (!(await other.count())) continue;
		expect(overlap(a, (await other.boundingBox())!)).toBe(false);
	}
	// 署名本身可点（没有被别的浮层盖住）
	const hit = await attribution.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return el.contains(top);
	});
	expect(hit).toBe(true);
});
