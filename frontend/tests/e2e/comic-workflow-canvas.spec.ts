import { expect, test } from "@playwright/test";

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
	await page.waitForSelector('[data-shape-id="shape:workflow-card-shot-1"]');

	await expect(page.getByRole("region", { name: "Brief" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Elements" })).toBeVisible();
	await expect(page.getByRole("region", { name: "九宫格分镜" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
	await expect(page.getByRole("button", { name: "一致性评估" })).toHaveCount(0);

	await page.getByRole("button", { name: "适应视图" }).click();
	const card = page.locator('[data-shape-id="shape:workflow-card-shot-1"]');
	const before = await card.boundingBox();
	expect(before).not.toBeNull();
	if (!before) return;

	await page.getByRole("button", { name: "排序九宫格" }).click();
	await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
	await page.mouse.down();
	await page.mouse.move(before.x + before.width / 2 + 80, before.y + before.height / 2 + 24, {
		steps: 10,
	});
	await page.mouse.up();

	const moved = await card.boundingBox();
	expect(moved).not.toBeNull();
	expect(Math.abs((moved?.x ?? before.x) - before.x)).toBeGreaterThan(20);

	await page.getByRole("button", { name: "完成分镜排序" }).click();
	await page.getByRole("button", { name: "整理画布" }).click();
	await expect(card).toBeVisible();

	const sidebar = page.locator("aside");
	await page.getByRole("button", { name: "展开工作区" }).click();
	await sidebar.getByRole("tab", { name: "属性" }).click();
	await expect(page.getByRole("button", { name: "概览" })).toBeVisible();
	await expect(page.getByRole("button", { name: "内容" })).toBeVisible();
	await expect(page.getByRole("button", { name: "操作" })).toBeVisible();

	await expect(page.getByRole("button", { name: "重排镜头顺序" })).toHaveCount(0);

	await page.getByRole("button", { name: "工作台工具" }).click();
	await page.getByRole("menuitem", { name: "导出 Webtoon 长图" }).click();
	await expect(page.getByText("Webtoon 长图已生成")).toBeVisible();

	await page.locator('button[aria-label="预览视频"]').first().click();
	const videoPreview = page.getByRole("dialog", { name: /视频预览/ });
	await expect(videoPreview).toBeVisible();
	await videoPreview.getByRole("button", { name: "关闭" }).click();

	await sidebar.getByRole("tab", { name: "资产" }).click();
	await expect(sidebar.getByRole("heading", { name: "资产库" })).toBeVisible();
	await sidebar.getByRole("tab", { name: "活动" }).click();
	await expect(sidebar.getByPlaceholder("描述如何调整所选内容…")).toBeVisible();

	expect(consoleErrors).toEqual([]);
});
