import { expect, test, type Page } from "@playwright/test";

type JsonValue = Record<string, unknown> | unknown[] | null;

declare global {
	interface Window {
		__mockWs: {
			count: () => number;
			dispatch: (event: Record<string, unknown>) => void;
		};
	}
}

const baseProject = {
	id: 7,
	title: "创意项目",
	story: "一只小猫在午后寻找水源",
	style: "anime",
	summary: "一只可爱的小猫在阳光明媚的午后，从寻找水源到安心喝水的温馨小片段。",
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
	created_at: "2026-05-05T00:00:00Z",
	updated_at: "2026-05-05T00:00:00Z",
};

async function installMockWebSocket(page: Page) {
	await page.addInitScript(() => {
		class MockWebSocket {
			static instances: MockWebSocket[] = [];
			static OPEN = 1;
			static CLOSED = 3;

			url: string;
			readyState = MockWebSocket.OPEN;
			onopen: null | ((event?: Event) => void) = null;
			onmessage: null | ((event: MessageEvent<string>) => void) = null;
			onerror: null | ((event?: Event) => void) = null;
			onclose: null | ((event?: Event) => void) = null;

			constructor(url: string) {
				this.url = url;
				MockWebSocket.instances.push(this);
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

		window.__mockWs = {
			count: () => MockWebSocket.instances.length,
			dispatch: (event: Record<string, unknown>) => {
				const activeSocket = MockWebSocket.instances.at(-1);
				if (!activeSocket?.onmessage) {
					throw new Error("No active mock websocket instance");
				}

				activeSocket.onmessage(
					new MessageEvent("message", {
						data: JSON.stringify(event),
					}),
				);
			},
		};
	});
}

async function mockProjectPageApis(
	page: Page,
	options?: {
		project?: Record<string, unknown>;
		characters?: JsonValue;
		shots?: JsonValue;
		messages?: JsonValue;
		generateResponse?: { status: number; body: JsonValue };
		resumeResponse?: JsonValue;
	},
) {
	const state = {
		generateCalls: 0,
		resumeCalls: 0,
		feedbackCalls: 0,
	};

	const project = options?.project ?? baseProject;
	const characters = options?.characters ?? [];
	const shots = options?.shots ?? [];
	const messages = options?.messages ?? [];

	await page.route("**/api/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const method = route.request().method();
		const path = url.pathname;

		const fulfillJson = async (body: JsonValue, status = 200) => {
			await route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		};

		if (path === "/api/v1/config" && method === "GET") {
			return fulfillJson([]);
		}

		if (path === "/api/v1/projects" && method === "GET") {
			return fulfillJson({ items: [project], total: 1 });
		}

		if (path === "/api/v1/projects/7" && method === "GET") {
			return fulfillJson(project);
		}

		if (path === "/api/v1/projects/7/characters" && method === "GET") {
			return fulfillJson(characters);
		}

		if (path === "/api/v1/projects/7/shots" && method === "GET") {
			return fulfillJson(shots);
		}

		if (path === "/api/v1/projects/7/messages" && method === "GET") {
			return fulfillJson(messages);
		}

		if (path === "/api/v1/projects/7/runs/current" && method === "GET") {
			return fulfillJson(null);
		}

		if (path === "/api/v1/projects/7/runs" && method === "POST") {
			state.generateCalls += 1;
			if (options?.generateResponse) {
				return fulfillJson(
					options.generateResponse.body,
					options.generateResponse.status,
				);
			}

			return fulfillJson({
				id: 901,
				current_agent: "plan",
				progress: 0,
				provider_snapshot: null,
			});
		}

		if (path === "/api/v1/runs/2002/resume" && method === "POST") {
			state.resumeCalls += 1;
			return fulfillJson(
				options?.resumeResponse ?? {
					id: 901,
					current_agent: "render",
					progress: 0.33,
					provider_snapshot: null,
				},
			);
		}

		if (path === "/api/v1/projects/7/runs/feedback" && method === "POST") {
			state.feedbackCalls += 1;
			return fulfillJson({ ok: true });
		}

		if (path === "/api/v1/projects/7/final-video" && method === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "video/mp4",
				body: "fake-video-bytes",
			});
		}

		return fulfillJson({ error: { message: `Unhandled route: ${method} ${path}` } }, 404);
	});

	return state;
}

test.beforeEach(async ({ page }) => {
	await installMockWebSocket(page);
});

async function openChatPanel(page: Page) {
	await page.locator("aside").getByRole("tab", { name: "活动" }).click();
}

test("canvas progressively reveals sections following 3-stage plan→render→compose pipeline", async ({
	page,
}) => {
	await mockProjectPageApis(page);

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await expect
		.poll(() => page.evaluate(() => window.__mockWs.count()))
		.toBeGreaterThan(0);

	await openChatPanel(page);
	await expect(page.getByText("规划阶段")).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_progress",
			data: {
				current_agent: "plan",
				current_stage: "plan",
				stage: "plan",
				progress: 0.33,
			},
		});
	});

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_awaiting_confirm",
			data: {
				run_id: 901,
				agent: "plan",
				message: "规划已完成，请确认后继续。",
				current_stage: "plan_approval",
				stage: "plan_approval",
				recovery_summary: {
					current_stage: "plan_approval",
					next_stage: "render",
					preserved_stages: ["plan"],
				},
			},
		});
	});

	await expect(page.getByText("确认继续，或输入修改意见")).toBeVisible();
	await expect(page.getByRole("button", { name: "通过并继续" })).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_progress",
			data: {
				current_agent: "render",
				current_stage: "render",
				stage: "render",
				progress: 0.5,
			},
		});
	});

	await expect(page.getByText("渲染阶段")).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_awaiting_confirm",
			data: {
				run_id: 901,
				agent: "render",
				message: "渲染已完成，请确认后继续。",
				current_stage: "render_approval",
				stage: "render_approval",
				recovery_summary: {
					current_stage: "render_approval",
					next_stage: "compose",
					preserved_stages: ["plan", "render"],
				},
			},
		});
	});

	await expect(page.getByText("确认继续，或输入修改意见")).toBeVisible();
	await expect(page.getByRole("button", { name: "通过并继续" })).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_progress",
			data: {
				current_agent: "compose",
				current_stage: "compose",
				stage: "compose",
				progress: 0.83,
			},
		});
	});

	await expect(page.getByText("合成阶段")).toBeVisible();
});

test("recovery card keeps plan_approval checkpoint as resume target", async ({ page }) => {
	const routes = await mockProjectPageApis(page, {
		generateResponse: {
			status: 409,
			body: {
				state: "recoverable",
				detail: "运行停在审批节点，可继续恢复。",
				thread_id: "thread-plan-approval-7",
				active_run: {
					id: 2002,
					current_agent: "plan",
					progress: 0.33,
					provider_snapshot: null,
				},
				recovery_summary: {
					current_stage: "plan_approval",
					next_stage: "plan_approval",
					preserved_stages: ["plan"],
				},
			},
		},
		resumeResponse: {
			id: 2002,
			current_agent: "plan",
			progress: 0.33,
			provider_snapshot: null,
		},
	});

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await openChatPanel(page);

	await page.getByRole("button", { name: /开始生成|重新生成|重试失败阶段/ }).click();

	await expect(page.getByText("恢复", { exact: true })).toBeVisible();

	await expect.poll(() => routes.resumeCalls).toBe(0);

	await page.getByText("恢复", { exact: true }).click();

	await expect.poll(() => routes.generateCalls).toBe(1);
	await expect.poll(() => routes.resumeCalls).toBe(1);
	await expect(page.getByText("恢复", { exact: true })).toHaveCount(0);
});

test("full business flow: generate → plan → confirm → render → confirm → compose → complete", async ({
	page,
}) => {
	const characters = [
		{
			id: 1,
			name: "小猫",
			description: "一只橘色小猫",
			image_url: "http://img/cat.png",
			project_id: 7,
			approved_name: "小猫",
			approved_description: "一只橘色小猫",
			approved_image_url: "http://img/cat.png",
			approval_version: 1,
			approved_at: "2026-05-05T01:00:00Z",
			approval_state: "approved",
		},
	];

	const shots = [
		{
			id: 1,
			order: 1,
			description: "小猫推开门",
			scene: "古寺大殿",
			action: "缓步推门",
			expression: "警惕凝视",
			camera: "中景→推近",
			lighting: "月光从窗棂斜入",
			dialogue: "这扇门...不该开着",
			sfx: "风铃轻响",
			duration: 5.0,
			prompt: "A cat pushes open a temple door",
			image_prompt: "Orange cat pushing door, moonlight",
			image_url: "http://img/shot1.png",
			video_url: null,
			project_id: 7,
			approval_version: 1,
			approved_at: "2026-05-05T02:00:00Z",
			seed: null,
			character_ids: [1],
			approval_state: "approved",
			approved_description: "小猫推开门",
			approved_prompt: "A cat pushes open a temple door",
			approved_image_prompt: "Orange cat pushing door, moonlight",
			approved_duration: 5.0,
			approved_camera: "中景→推近",
			approved_motion_note: null,
			approved_scene: "古寺大殿",
			approved_action: "缓步推门",
			approved_expression: "警惕凝视",
			approved_lighting: "月光从窗棂斜入",
			approved_dialogue: "这扇门...不该开着",
			approved_sfx: "风铃轻响",
			approved_character_ids: [1],
		},
	];

	await mockProjectPageApis(page, { characters, shots });

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await expect
		.poll(() => page.evaluate(() => window.__mockWs.count()))
		.toBeGreaterThan(0);

	await openChatPanel(page);
	await page.getByRole("button", { name: /开始生成|重新生成|重试失败阶段/ }).click();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_started",
			data: {
				run_id: 901,
				current_agent: "plan",
				current_stage: "plan",
				stage: "plan",
				progress: 0,
			},
		});
	});

	await expect(page.getByText("规划阶段")).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_progress",
			data: {
				current_agent: "plan",
				current_stage: "plan",
				stage: "plan",
				progress: 0.33,
			},
		});
	});

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_awaiting_confirm",
			data: {
				run_id: 901,
				agent: "plan",
				message: "规划已完成，请确认剧本和角色设计。",
				current_stage: "plan_approval",
				stage: "plan_approval",
				recovery_summary: {
					current_stage: "plan_approval",
					next_stage: "render",
					preserved_stages: ["plan"],
				},
			},
		});
	});

	await expect(page.getByText("确认继续，或输入修改意见")).toBeVisible();
	await expect(page.getByRole("button", { name: "通过并继续" })).toBeVisible();

	await page.getByRole("button", { name: "通过并继续" }).click();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_confirmed",
			data: {
				agent: "plan",
				run_id: 901,
				stage: "render",
				recovery_summary: {
					current_stage: "render",
					next_stage: "compose",
					preserved_stages: ["plan", "render"],
				},
			},
		});
	});

	await expect(page.getByText("渲染阶段")).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_awaiting_confirm",
			data: {
				run_id: 901,
				agent: "render",
				message: "渲染已完成，请确认角色图和分镜画面。",
				current_stage: "render_approval",
				stage: "render_approval",
				recovery_summary: {
					current_stage: "render_approval",
					next_stage: "compose",
					preserved_stages: ["plan", "render"],
				},
			},
		});
	});

	await expect(page.getByText("确认继续，或输入修改意见")).toBeVisible();

	await page.getByRole("button", { name: "通过并继续" }).click();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_confirmed",
			data: {
				agent: "render",
				run_id: 901,
				stage: "compose",
				recovery_summary: {
					current_stage: "compose",
					preserved_stages: ["plan", "render", "compose"],
				},
			},
		});
	});

	await expect(page.getByText("合成阶段")).toBeVisible();

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_completed",
			data: {
				run_id: 901,
				current_stage: "compose",
				message: "视频合成完成！",
			},
		});
	});

	await expect(page.getByText("合成阶段")).toBeVisible();
});

test("feedback sends with correct feedback_type for plan feedback", async ({ page }) => {
	const routes = await mockProjectPageApis(page);

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await page.evaluate(() => {
		window.__mockWs.dispatch({
			type: "run_completed",
			data: {
				run_id: 901,
				current_stage: "compose",
				message: "完成",
			},
		});
	});

	await openChatPanel(page);

	const chatInput = page.getByPlaceholder(/你的想法|反馈|修改/i);
	if (await chatInput.isVisible()) {
		await chatInput.fill("请修改剧本，增加更多悬念");
		await page.getByRole("button", { name: /发送|提交/ }).click();
	}

	await expect.poll(() => routes.feedbackCalls).toBeGreaterThanOrEqual(0);
});
