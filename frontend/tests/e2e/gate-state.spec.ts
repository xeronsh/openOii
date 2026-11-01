import { expect, test, type Page } from "@playwright/test";

/**
 * P0 gate contract: the server is the truth for where a run stands.
 * - a reload at a gate still offers 确认继续 (desktop and 390px)
 * - 发送意见 at a gate is a change request: it never approves, and the run comes back to the SAME gate
 * - lifecycle events and user actions re-read runs/current, so stale states reconcile
 */

type Json = Record<string, unknown> | unknown[] | null;

declare global {
	interface Window {
		__mockWs: {
			count: () => number;
			dispatch: (event: Record<string, unknown>) => void;
			sent: () => string[];
			drop: () => void;
		};
	}
}

const project = {
	id: 7,
	title: "闸门测试",
	story: "一只小猫在午后寻找水源",
	style: "anime",
	summary: null,
	video_url: null,
	status: "active",
	target_shot_count: 6,
	character_hints: [],
	creation_mode: "story",
	reference_images: [],
	provider_settings: {
		text: { selected_key: "openai", resolved_key: "openai", source: "default", valid: true, status: "valid", reason_message: null },
		image: { selected_key: "fal", resolved_key: "fal", source: "default", valid: true, status: "valid", reason_message: null },
		video: { selected_key: "runway", resolved_key: "runway", source: "default", valid: true, status: "valid", reason_message: null },
	},
	created_at: "2026-10-29T00:00:00Z",
	updated_at: "2026-10-29T00:00:00Z",
};

const RUN = 901;
const summary = { project_id: 7, run_id: RUN, current_stage: "outline_approval", next_stage: "characters", preserved_stages: ["outline"], stage_history: [], resumable: true };

function gatePayload(feedback: Record<string, unknown> | null = null) {
	return {
		run_id: RUN,
		project_id: 7,
		agent: "outline",
		message: "故事大纲已完成，请确认。",
		current_stage: "outline_approval",
		stage: "outline_approval",
		recovery_summary: summary,
		...(feedback ? { feedback } : {}),
	};
}

function control(status: "running" | "waiting_for_approval", extra: Record<string, unknown> = {}) {
	return {
		state: "active",
		detail: "运行中",
		available_actions: ["cancel"],
		active_run: { id: RUN, project_id: 7, status, current_agent: "outline", progress: 0.2, provider_snapshot: null },
		recovery_summary: summary,
		awaiting_gate: status === "waiting_for_approval" ? gatePayload() : null,
		pending_gate_feedback: null,
		...extra,
	};
}

type Server = {
	current: Json;
	/** GET /runs/{id}/timing；null = 404（界面不显示计时条） */
	timing: Json;
	confirmCalls: number;
	feedback: Array<Record<string, unknown>>;
	currentReads: number;
};

async function installMockWebSocket(page: Page) {
	await page.addInitScript(() => {
		const sent: string[] = [];
		class MockWebSocket {
			static instances: MockWebSocket[] = [];
			static OPEN = 1;
			static CLOSED = 3;
			readyState = 1;
			url: string;
			onopen: null | ((event?: Event) => void) = null;
			onmessage: null | ((event: MessageEvent<string>) => void) = null;
			onerror: null | ((event?: Event) => void) = null;
			onclose: null | ((event?: Event) => void) = null;
			constructor(url: string) {
				this.url = url;
				MockWebSocket.instances.push(this);
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}
			send(data: string) {
				sent.push(data);
			}
			close() {
				this.readyState = 3;
				this.onclose?.(new Event("close"));
			}
		}
		Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: MockWebSocket });
		window.__mockWs = {
			count: () => MockWebSocket.instances.length,
			sent: () => sent,
			drop: () => MockWebSocket.instances.at(-1)?.close(),
			dispatch: (event) => {
				const socket = MockWebSocket.instances.at(-1);
				if (!socket?.onmessage) throw new Error("No active mock websocket");
				socket.onmessage(new MessageEvent("message", { data: JSON.stringify(event) }));
			},
		};
	});
}

async function mockServer(page: Page, current: Json, characters: Json = []): Promise<Server> {
	const server: Server = { current, timing: null, confirmCalls: 0, feedback: [], currentReads: 0 };
	await page.route("**/api/v1/**", async (route) => {
		const { pathname: path } = new URL(route.request().url());
		const method = route.request().method();
		const json = (body: Json, status = 200) =>
			route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/api/v1/config") return json([]);
		if (path === "/api/v1/projects" && method === "GET") return json({ items: [project], total: 1 });
		if (path === "/api/v1/projects/7") return json(project);
		if (path === "/api/v1/projects/7/characters") return json(characters);
		if (["/api/v1/projects/7/shots", "/api/v1/projects/7/messages"].includes(path)) return json([]);
		if (path === "/api/v1/projects/7/runs/current") {
			server.currentReads += 1;
			return json(server.current);
		}
		if (path === `/api/v1/runs/${RUN}/timing` && server.timing) return json(server.timing);
		if (path === `/api/v1/runs/${RUN}/confirm` && method === "POST") {
			server.confirmCalls += 1;
			server.current = control("running", { awaiting_gate: null });
			return json({ run_id: RUN, status: "accepted" }, 202);
		}
		if (path === `/api/v1/runs/${RUN}/gate-feedback` && method === "POST") {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			server.feedback.push(body);
			server.current = control("waiting_for_approval", {
				pending_gate_feedback: { id: "fb1", content: body.content, received_at: "2026-10-29T00:00:00Z" },
			});
			return json({ run_id: RUN, feedback_id: "fb1", status: "accepted" }, 202);
		}
		return json({ error: { message: `Unhandled ${method} ${path}` } }, 404);
	});
	return server;
}

async function push(page: Page, event: Record<string, unknown>) {
	await page.evaluate((frame) => window.__mockWs.dispatch(frame), event);
}

async function openPanel(page: Page) {
	const pill = page.getByRole("button", { name: "展开活动面板" });
	if (await pill.isVisible()) await pill.click();
	await expect(page.locator("aside[aria-label='工作流活动']")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
	await installMockWebSocket(page);
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`a reload at a gate still offers 确认继续 at ${viewport.width}px`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const server = await mockServer(page, control("waiting_for_approval"));
		await page.goto("/project/7");
		await page.reload();
		if (viewport.width > 600) await openPanel(page);

		const confirm = page.getByRole("button", { name: "确认继续" });
		await expect(confirm).toBeVisible();
		await expect(confirm).toBeEnabled();
		await confirm.click();
		await expect.poll(() => server.confirmCalls).toBe(1);
		// the approval goes over REST, never as a WS frame that could get lost
		expect(await page.evaluate(() => window.__mockWs.sent().filter((frame) => frame.includes("confirm")))).toEqual([]);
		await expect(confirm).toHaveCount(0);
	});
}

test("feedback at a gate is a change request that comes back to the same gate", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = await mockServer(page, control("waiting_for_approval"));
	await page.goto("/project/7");
	await openPanel(page);
	await expect(page.getByRole("button", { name: "确认继续" })).toBeVisible();

	await page.getByPlaceholder("说明需要修改的地方…").fill("结局更温暖一些");
	await page.getByRole("button", { name: "发送意见" }).click();

	await expect.poll(() => server.feedback).toEqual([{ content: "结局更温暖一些" }]);
	expect(server.confirmCalls).toBe(0);
	// received: the gate stays, but approval waits for the new version
	await expect(page.getByText("已收到修改意见，故事大纲重做中")).toBeVisible();
	await expect(page.getByRole("button", { name: "确认继续" })).toBeDisabled();

	// the engine picks it up and redoes the outline
	server.current = control("running", {
		awaiting_gate: null,
		pending_gate_feedback: { id: "fb1", content: "结局更温暖一些" },
	});
	await push(page, { type: "run_feedback", data: { run_id: RUN, project_id: 7, id: "fb1", round: 1, state: "regenerating", content: "结局更温暖一些", gate: "outline_approval", stage: "outline_approval" } });
	await page.getByRole("tab", { name: "活动" }).click();
	const receipt = page.getByTestId("feedback-receipt");
	await expect(receipt).toHaveAttribute("data-state", "regenerating");
	await expect(receipt).toContainText("结局更温暖一些");

	// the new version waits at the SAME gate; nothing advanced on its own
	const revised = { id: "fb1", round: 1, state: "revised", content: "结局更温暖一些", reason: null };
	server.current = control("waiting_for_approval", { awaiting_gate: gatePayload(revised) });
	await push(page, { type: "run_awaiting_confirm", data: gatePayload(revised) });
	// the gate opens 待处理 again
	await expect(page.getByRole("tab", { name: /待处理/ })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByText("故事大纲第 2 版，等待确认")).toBeVisible();
	await expect(page.getByRole("button", { name: "确认新版本" })).toBeEnabled();
	await page.getByRole("tab", { name: "活动" }).click();
	await expect(receipt).toHaveAttribute("data-state", "revised");
	await expect(receipt).toContainText("第 2 版待确认");
	await expect(receipt).toHaveCount(1);
	expect(server.confirmCalls).toBe(0);

	// a reload keeps the version and the receipt (rebuilt from the gate payload)
	await page.reload();
	await openPanel(page);
	await expect(page.getByText("故事大纲第 2 版，等待确认")).toBeVisible();
	await page.getByRole("button", { name: "确认新版本" }).click();
	await expect.poll(() => server.confirmCalls).toBe(1);
});

test("a rejected change request says why and stays at the gate", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const notApplied = { id: "fb2", round: 1, state: "not_applied", content: "改一下", reason: "意见没有指向具体内容，大纲保持不变" };
	await mockServer(page, control("waiting_for_approval", { awaiting_gate: gatePayload(notApplied) }));
	await page.goto("/project/7");
	await openPanel(page);
	await expect(page.getByText("故事大纲没有改动，等待确认")).toBeVisible();
	await expect(page.getByText("意见没有指向具体内容，大纲保持不变").first()).toBeVisible();
	await expect(page.getByRole("button", { name: "确认继续" })).toBeEnabled();
});

test("stale run state reconciles with the server after events and reconnects", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = await mockServer(page, control("running", { awaiting_gate: null }));
	await page.goto("/project/7");
	await openPanel(page);
	await expect(page.getByTestId("sync-status")).toContainText("最后更新");

	// The run dies while the socket is down; the reconnect re-reads the server.
	await page.evaluate(() => window.__mockWs.drop());
	await expect(page.getByTestId("sync-status")).toHaveAttribute("data-tone", "offline");
	await expect(page.getByTestId("sync-status")).toContainText("连接中断，正在重连");
	server.current = {
		state: "recoverable",
		detail: "运行中断，可从故事大纲继续。",
		available_actions: ["resume", "cancel"],
		active_run: { id: RUN, project_id: 7, status: "failed", current_agent: "outline", progress: 0.2, error: "llm error: 超时", provider_snapshot: null },
		recovery_summary: summary,
		awaiting_gate: null,
		pending_gate_feedback: null,
	};
	await expect.poll(() => page.evaluate(() => window.__mockWs.count()), { timeout: 15_000 }).toBeGreaterThan(1);
	// the resync found a recoverable run, which opens 待处理
	await expect(page.getByRole("tab", { name: /待处理/ })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });

	// one card: resumable, with the reason; no 生成中 / 停止 left behind
	await expect(page.getByRole("button", { name: /继续$/ })).toHaveCount(1);
	await expect(page.getByText(/超时/).first()).toBeVisible();
	// the interrupted pill names the gate it stopped at, not a bare 规划
	await expect(page.getByRole("button", { name: /^状态：/ })).toContainText("可恢复 · 故事大纲确认");
	await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
	await page.getByRole("tab", { name: "活动" }).click();
	await expect(page.getByTestId("sync-status")).toHaveAttribute("data-tone", "ok");

	// a terminal event clears it, even when the event itself is the only signal
	server.current = null;
	await push(page, { type: "run_cancelled", data: { run_id: RUN, project_id: 7 } });
	await expect(page.getByRole("button", { name: /继续$/ })).toHaveCount(0);
});

test("the character-image gate shows what it reviews, and canvas cards carry no approve buttons", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const stageSummary = { ...summary, current_stage: "character_images_approval", next_stage: "shots" };
	const gate = { ...gatePayload(), agent: "character_artist", current_stage: "character_images_approval", stage: "character_images_approval", recovery_summary: stageSummary };
	const characters = [1, 2].map((id) => ({
		id,
		project_id: 7,
		name: id === 1 ? "小曦" : "店员",
		description: "雨夜里的便利店常客，总在凌晨两点出现，买一罐热咖啡然后站在门口看雨很久很久",
		image_url: null,
		approval_state: "draft",
		revision: 1,
	}));
	await mockServer(page, control("waiting_for_approval", { awaiting_gate: gate, recovery_summary: stageSummary }), characters);
	await page.goto("/project/7");
	await openPanel(page);

	const strip = page.getByRole("list", { name: "本关要审的内容" });
	await expect(strip).toBeVisible();
	await expect(strip.getByRole("button")).toHaveCount(2);
	await expect(strip.getByText("小曦")).toBeVisible();
	await expect(page.getByRole("button", { name: "通过" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "确认继续" })).toHaveCount(1);

	// one vocabulary: pill, panel header and PromptBar chip all name the same step
	await expect(page.getByRole("button", { name: /^状态：/ })).toContainText("待确认 · 角色形象");
	await expect(page.getByRole("button", { name: /^状态：/ })).not.toContainText("%");
	await expect(page.getByText("角色形象 · 待确认").first()).toBeVisible();
	await expect(page.getByText("规划阶段")).toHaveCount(0);
});

test("at a gate the inspector lets you edit properties and says how to change results", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const stageSummary = { ...summary, current_stage: "character_images_approval", next_stage: "shots" };
	const gate = { ...gatePayload(), agent: "character_artist", current_stage: "character_images_approval", stage: "character_images_approval", recovery_summary: stageSummary };
	const characters = [{ id: 1, project_id: 7, name: "小曦", description: "便利店常客", image_url: null, approval_state: "draft", revision: 1 }];
	await mockServer(page, control("waiting_for_approval", { awaiting_gate: gate, recovery_summary: stageSummary }), characters);
	await page.goto("/project/7");
	await openPanel(page);

	await page.getByRole("list", { name: "本关要审的内容" }).getByRole("button", { name: /小曦/ }).click();
	await page.getByRole("button", { name: "属性", exact: true }).click();
	await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "生成", exact: true }).click();
	await expect(page.getByRole("note").filter({ hasText: "提修改意见" })).toBeVisible();
	await expect(page.getByRole("button", { name: "重新生成当前角色" })).toBeDisabled();
});

test("mobile names the step and shows where it is in the six", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const stageSummary = { ...summary, current_stage: "shots_approval", next_stage: "render_characters" };
	const gate = { ...gatePayload(), agent: "storyboard", current_stage: "shots_approval", stage: "shots_approval", recovery_summary: stageSummary };
	await mockServer(page, control("waiting_for_approval", { awaiting_gate: gate, recovery_summary: stageSummary }));
	await page.goto("/project/7");

	await expect(page.getByRole("heading", { name: "待确认 · 分镜脚本" })).toBeVisible();
	await expect(page.getByLabel("第 3 步，共 6 步")).toBeVisible();
});

test("mobile while running: one status card with the only 停止, and the input talks to the assistant", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockServer(page, control("running"));
	await page.goto("/project/7");

	await expect(page.getByRole("heading", { name: /^生成中/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(1);
	await expect(page.getByPlaceholder("问助手，或让它重画、修改…")).toBeVisible();
	await expect(page.getByPlaceholder(/待审批后可提交修改/)).toHaveCount(0);
});

test("mobile at a gate has no 停止 and the input asks for change notes", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockServer(page, control("waiting_for_approval"));
	await page.goto("/project/7");

	await expect(page.getByRole("button", { name: "确认继续" })).toHaveCount(1);
	await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
	await expect(page.getByPlaceholder("说明需要修改的地方…")).toBeVisible();
});

test("version compare opens on 当前 vs 上一版 and shows the current image", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const characters = [{ id: 1, project_id: 7, name: "小曦", description: "便利店常客", image_url: "/static/x.png", approval_state: "approved", revision: 1 }];
	await mockServer(page, null, characters);
	await page.route("**/static/x.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") }));
	await page.route("**/api/v1/projects/7/versions**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				entity_type: "character",
				entity_id: 1,
				versions: [{ id: 1, entity_type: "character", entity_id: 1, version: 1, trigger: "generation", created_at: "2026-10-29T00:00:00Z", snapshot: { name: "小曦", description: "便利店常客", image_url: null } }],
			}),
		}),
	);
	await page.goto("/project/7");
	await page.getByRole("button", { name: "工作台工具" }).click();
	await page.getByRole("menuitem", { name: "打开版本对比" }).click();

	const dialog = page.getByRole("dialog", { name: "版本对比" });
	await expect(dialog.getByText("新 · 当前")).toBeVisible();
	await expect(dialog.getByText("旧 · v1 · 生成")).toBeVisible();
	await expect(dialog.getByRole("img", { name: "新 · 当前" })).toBeVisible();
	await expect(dialog.getByText("这一版还没有图")).toBeVisible();
	await expect(dialog.getByText(/内容相同/)).toHaveCount(0);
});

// --- P1-8: elapsed / remaining and 完成后通知我 -----------------------------------

function timing(extra: Record<string, unknown> = {}) {
	return {
		run_id: RUN,
		status: "running",
		active: true,
		started_at: "2026-10-29T00:00:00Z",
		elapsed_seconds: 612,
		current_stage: "render_characters",
		at_gate: false,
		stages: [
			{ stage: "plan_outline", status: "succeeded", attempts: 1, elapsed_seconds: 70, estimate_seconds: 60 },
			{ stage: "plan_characters", status: "succeeded", attempts: 1, elapsed_seconds: 65, estimate_seconds: 60 },
			{ stage: "plan_shots", status: "succeeded", attempts: 1, elapsed_seconds: 60, estimate_seconds: 60 },
			{ stage: "render_characters", status: "running", attempts: 1, elapsed_seconds: 40, estimate_seconds: 180 },
		],
		remaining_seconds: 530,
		estimate_basis: "history",
		...extra,
	};
}

async function installFakeNotification(page: Page, permission: NotificationPermission = "default") {
	await page.addInitScript((initial) => {
		const sent: Array<{ title: string; body?: string }> = [];
		let requests = 0;
		class FakeNotification {
			static permission: NotificationPermission = initial;
			static async requestPermission() {
				requests += 1;
				FakeNotification.permission = "granted";
				return "granted" as NotificationPermission;
			}
			onclick: null | (() => void) = null;
			constructor(title: string, options?: NotificationOptions) {
				sent.push({ title, body: options?.body });
			}
			close() {}
		}
		Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: FakeNotification });
		(window as unknown as { __notifications: () => unknown }).__notifications = () => ({ sent, requests });
	}, permission);
}

const notifications = (page: Page) =>
	page.evaluate(() => (window as unknown as { __notifications: () => { sent: Array<{ title: string; body?: string }>; requests: number } }).__notifications());

test("running: the activity panel shows step and total elapsed, a 约 estimate, and 完成后通知我 asks only on click", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await installFakeNotification(page);
	const runningSummary = { ...summary, current_stage: "render_characters", next_stage: "character_images_approval" };
	const server = await mockServer(page, control("running", { recovery_summary: runningSummary }));
	server.timing = timing();
	await page.goto("/project/7");
	await openPanel(page);

	const bar = page.getByTestId("run-timing");
	await expect(bar).toBeVisible();
	await expect(bar.getByTestId("run-timing-step")).toHaveText(/本步 4\d 秒/);
	await expect(bar.getByTestId("run-timing-total")).toHaveText(/共 10 分 1\d 秒/);
	await expect(bar.getByTestId("run-timing-remaining")).toHaveText(/剩余约 9 分钟/);
	// the clock runs locally between server reads
	const first = await bar.getByTestId("run-timing-total").textContent();
	await expect.poll(async () => bar.getByTestId("run-timing-total").textContent(), { timeout: 4000 }).not.toBe(first);

	expect((await notifications(page)).requests).toBe(0);
	const notify = bar.getByRole("button", { name: "完成后通知我" });
	await expect(notify).toHaveAttribute("aria-pressed", "false");
	await notify.click();
	await expect(bar.getByRole("button", { name: "完成后会通知你" })).toHaveAttribute("aria-pressed", "true");
	expect((await notifications(page)).requests).toBe(1);

	// the tab goes to the background; the gate badges the workbench title until the user comes back
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
	});
	const gate = { ...gatePayload(), agent: "render", current_stage: "character_images_approval", stage: "character_images_approval" };
	server.current = control("waiting_for_approval", { awaiting_gate: gate });
	await push(page, { type: "run_awaiting_confirm", data: gate });
	await expect.poll(async () => (await notifications(page)).sent).toEqual([
		{ title: "openOii · 闸门测试", body: "角色形象 · 待确认" },
	]);
	await expect(page).toHaveTitle(/^【待确认】.*闸门测试 - openOii$/);
	// confirmed elsewhere: the gate badge goes, the run carries on
	server.current = control("running", { recovery_summary: runningSummary });
	await push(page, { type: "run_confirmed", data: { run_id: RUN, project_id: 7, current_stage: "compose_videos" } });
	await expect(page).toHaveTitle(/^(?!【).*闸门测试 - openOii$/);

	server.current = null;
	await push(page, { type: "run_completed", data: { run_id: RUN, project_id: 7, message: "完成" } });
	await expect.poll(async () => (await notifications(page)).sent.length).toBe(2);
	expect((await notifications(page)).sent[1]).toEqual({ title: "openOii · 闸门测试", body: "生成完成，成片可以查看了" });
	await expect(page).toHaveTitle(/^【已完成】/);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(page).toHaveTitle(/^(?!【)/);
});

test("no history: elapsed only; at a gate the estimate is for after confirming", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = await mockServer(page, control("running"));
	server.timing = timing({ remaining_seconds: null, estimate_basis: "none" });
	await page.goto("/project/7");
	await openPanel(page);

	const bar = page.getByTestId("run-timing");
	await expect(bar.getByTestId("run-timing-total")).toBeVisible();
	await expect(bar.getByTestId("run-timing-remaining")).toHaveCount(0);

	server.timing = timing({ at_gate: true, current_stage: "outline_approval", stages: timing().stages.slice(0, 1), remaining_seconds: 1200 });
	server.current = control("waiting_for_approval");
	await push(page, { type: "run_awaiting_confirm", data: gatePayload() });
	// a gate opens the 待处理 tab; the timing lives on the 活动 tab
	await page.getByRole("tab", { name: "活动" }).click();
	await expect(bar.getByTestId("run-timing-remaining")).toHaveText("· 确认后还要约 20 分钟");
	await expect(bar.getByTestId("run-timing-step")).toHaveCount(0);
});

test("mobile: the status card carries the timing and the notify toggle", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const server = await mockServer(page, control("running"));
	server.timing = timing();
	await page.goto("/project/7");

	const card = page.locator("[data-shell='mobile-workbench-preview']");
	await expect(card.getByTestId("run-timing-remaining")).toHaveText(/剩余约 9 分钟/);
	await expect(card.getByRole("button", { name: "完成后通知我" })).toBeVisible();
	await expect(page.getByTestId("run-timing")).toHaveCount(1);
});
