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

type MockServer = {
	generateCalls: number;
	resumeCalls: number;
	chatSends: unknown[];
	chatConfirms: unknown[];
	/** What GET runs/current answers: the server's view of the run. */
	current: JsonValue;
};

/** The server writes the run to the DB, then announces it over WS. */
function serverRunAfter(event: { type: string; data: Record<string, unknown> }, previous: JsonValue): JsonValue {
	const { type, data } = event;
	if (type === "run_completed" || type === "run_failed" || type === "run_cancelled") return null;
	if (!["run_started", "run_progress", "run_confirmed", "run_awaiting_confirm"].includes(type)) return previous;
	const atGate = type === "run_awaiting_confirm";
	return {
		state: "active",
		detail: "运行中",
		available_actions: ["cancel"],
		active_run: {
			id: (data.run_id as number | undefined) ?? 901,
			project_id: 7,
			status: atGate ? "waiting_for_approval" : "running",
			current_agent: (data.current_agent ?? data.agent ?? null) as string | null,
			progress: (data.progress as number | undefined) ?? 0,
			provider_snapshot: null,
		},
		recovery_summary: (data.recovery_summary as Record<string, unknown> | undefined) ?? {
			current_stage: data.current_stage ?? data.stage ?? "plan",
			next_stage: null,
			preserved_stages: [],
		},
		awaiting_gate: atGate ? data : null,
		pending_gate_feedback: null,
	};
}

async function push(page: Page, server: MockServer, event: { type: string; data: Record<string, unknown> }) {
	server.current = serverRunAfter(event, server.current);
	await page.evaluate((frame) => window.__mockWs.dispatch(frame), event);
}

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
	const state: MockServer = {
		generateCalls: 0,
		resumeCalls: 0,
		chatSends: [],
		chatConfirms: [],
		current: null,
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
			return fulfillJson(state.current);
		}

		if (path === "/api/v1/projects/7/runs/regenerate-plan" && method === "GET") {
			return fulfillJson({
				project_id: 7,
				has_content: characters.length > 0 || shots.length > 0,
				character_count: Array.isArray(characters) ? characters.length : 0,
				shot_count: Array.isArray(shots) ? shots.length : 0,
				has_final_video: Boolean(project.video_url),
				stages: ["剧本", "角色", "分镜", "渲染", "合成"],
				estimate: { seconds_low: 180, seconds_high: 480, text_calls: 4, image_calls: 2, video_calls: 1, basis: "heuristic" },
				previous_version: null,
			});
		}

		if (path === "/api/v1/projects/7/runs" && method === "POST") {
			state.generateCalls += 1;
			if (options?.generateResponse) {
				// a 409 answer is the run the server already has
				if (options.generateResponse.status === 409) state.current = options.generateResponse.body;
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

		if (/^\/api\/v1\/runs\/\d+\/confirm$/.test(path) && method === "POST") {
			return fulfillJson({ run_id: Number(path.split("/")[4]), status: "accepted" }, 202);
		}

		if (path === "/api/v1/runs/2002/resume" && method === "POST") {
			state.resumeCalls += 1;
			state.current = serverRunAfter(
				{ type: "run_started", data: { run_id: 2002, current_agent: "plan", progress: 0.33 } },
				state.current,
			);
			return fulfillJson(
				options?.resumeResponse ?? {
					id: 901,
					current_agent: "render",
					progress: 0.33,
					provider_snapshot: null,
				},
			);
		}

		if (path === "/api/v1/projects/7/chat" && method === "GET") {
			return fulfillJson({ messages: [], busy: false, text: "", pending: null });
		}

		if (path === "/api/v1/projects/7/chat" && method === "POST") {
			state.chatSends.push(route.request().postDataJSON());
			return fulfillJson({ accepted: true }, 202);
		}

		if (path === "/api/v1/projects/7/chat/confirm" && method === "POST") {
			state.chatConfirms.push(route.request().postDataJSON());
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
	// 窄桌面下 Agent 面板默认收起成胶囊；需要时展开
	const pill = page.getByRole("button", { name: "展开活动面板" });
	if (await pill.isVisible()) await pill.click();
	await expect(page.locator("aside[aria-label='工作流活动']")).toBeVisible();
}

test("canvas progressively reveals sections following 3-stage plan→render→compose pipeline", async ({
	page,
}) => {
	const routes = await mockProjectPageApis(page);

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await expect
		.poll(() => page.evaluate(() => window.__mockWs.count()))
		.toBeGreaterThan(0);

	await openChatPanel(page);
	await expect(page.getByText("活动记录", { exact: true })).toBeVisible();

	await push(page, routes, {
		type: "run_progress",
		data: {
			current_agent: "plan",
			current_stage: "plan_outline",
			stage: "plan_outline",
			progress: 0.33,
		},
	});

	await push(page, routes, {
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

	await expect(page.getByText(/已完成，等待确认/)).toBeVisible();
	await expect(page.getByRole("button", { name: "确认继续" })).toHaveCount(1);

	await push(page, routes, {
		type: "run_progress",
		data: {
			current_agent: "render",
			current_stage: "render_shots",
			stage: "render_shots",
			progress: 0.5,
		},
	});

	// 审批门把面板切到了收件箱；阶段头在活动流里
	await page.getByRole("tab", { name: "活动" }).click();
	await expect(page.getByText("分镜画面 · 5/6", { exact: true })).toBeVisible();

	await push(page, routes, {
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

	await expect(page.getByText(/已完成，等待确认/)).toBeVisible();
	await expect(page.getByRole("button", { name: "确认继续" })).toHaveCount(1);

	await push(page, routes, {
		type: "run_progress",
		data: {
			current_agent: "compose",
			current_stage: "compose_videos",
			stage: "compose_videos",
			progress: 0.83,
		},
	});

	await page.getByRole("tab", { name: "活动" }).click();
	await expect(page.getByText("视频与成片 · 6/6", { exact: true })).toBeVisible();
});

test("recovery card keeps plan_approval checkpoint as resume target", async ({ page }) => {
	const routes = await mockProjectPageApis(page, {
		generateResponse: {
			status: 409,
			body: {
				state: "recoverable",
				detail: "运行停在审批节点，可继续恢复。",
				available_actions: ["resume", "cancel"],
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

	await page.getByRole("button", { name: /开始生成|重新生成/ }).click();

	await expect(page.getByRole("button", { name: /继续$/ })).toBeVisible();

	await expect.poll(() => routes.resumeCalls).toBe(0);

	await page.getByRole("button", { name: /继续$/ }).click();

	await expect.poll(() => routes.generateCalls).toBe(1);
	await expect.poll(() => routes.resumeCalls).toBe(1);
	await expect(page.getByText(/运行中断于/)).toHaveCount(0);
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

	const routes = await mockProjectPageApis(page, { characters, shots });

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");

	await expect
		.poll(() => page.evaluate(() => window.__mockWs.count()))
		.toBeGreaterThan(0);

	await openChatPanel(page);
	// 先等 POST /runs 落地：它的 onSuccess 会重置运行态，晚到会盖掉下面推送的待确认
	const runStarted = page.waitForResponse(
		(response) => response.url().endsWith("/api/v1/projects/7/runs") && response.request().method() === "POST",
	);
	// 已有角色和分镜：重新生成要先确认
	await page.getByRole("button", { name: /开始生成|重新生成/ }).click();
	await page.getByTestId("regenerate-dialog").getByRole("button", { name: "重新生成" }).click();
	await runStarted;

	await push(page, routes, {
		type: "run_started",
		data: {
			run_id: 901,
			current_agent: "plan",
			current_stage: "plan_outline",
			stage: "plan_outline",
			progress: 0,
		},
	});

	await expect(page.getByText("故事大纲 · 1/6", { exact: true })).toBeVisible();

	await push(page, routes, {
		type: "run_progress",
		data: {
			current_agent: "plan",
			current_stage: "plan",
			stage: "plan",
			progress: 0.33,
		},
	});

	await push(page, routes, {
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

	await expect(page.getByText(/已完成，等待确认/)).toBeVisible();
	await expect(page.getByRole("button", { name: "确认继续" })).toHaveCount(1);

	await page.getByRole("button", { name: "确认继续" }).click();

	await push(page, routes, {
		type: "run_confirmed",
		data: {
			agent: "plan",
			run_id: 901,
			stage: "render_characters",
			recovery_summary: {
				current_stage: "render",
				next_stage: "compose",
				preserved_stages: ["plan", "render"],
			},
		},
	});

	await expect(page.getByText("角色形象 · 4/6", { exact: true })).toBeVisible();

	await push(page, routes, {
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

	await expect(page.getByText(/已完成，等待确认/)).toBeVisible();

	await page.getByRole("button", { name: "确认继续" }).click();

	await push(page, routes, {
		type: "run_confirmed",
		data: {
			agent: "render",
			run_id: 901,
			stage: "compose_videos",
			recovery_summary: {
				current_stage: "compose",
				preserved_stages: ["plan", "render", "compose"],
			},
		},
	});

	await expect(page.getByText("视频与成片 · 6/6", { exact: true })).toBeVisible();

	await push(page, routes, {
		type: "run_completed",
		data: {
			run_id: 901,
			current_stage: "compose",
			message: "视频合成完成！",
		},
	});

	await expect(page.getByText("活动记录", { exact: true })).toBeVisible();
});

test("the prompt bar talks to the assistant and a proposed change runs only after 确认", async ({ page }) => {
	const routes = await mockProjectPageApis(page);

	await page.goto("/project/7");
	await page.waitForLoadState("networkidle");
	await expect.poll(() => page.evaluate(() => window.__mockWs.count())).toBeGreaterThan(0);

	await page.getByPlaceholder("问助手，或让它重画、修改…").fill("重画第2镜");
	await page.getByRole("button", { name: "发送" }).click();
	await expect.poll(() => routes.chatSends).toEqual([{ content: "重画第2镜" }]);
	await expect(page.getByRole("tab", { name: "助手" })).toHaveAttribute("aria-selected", "true");

	await push(page, routes, { type: "chat_message", data: { message: { id: 1, role: "user", text: "重画第2镜" } } });
	await push(page, routes, {
		type: "chat_status",
		data: { busy: true, text: "", pending: { tool_call_id: "call-1", tool: "重画分镜", summary: "重画第 2 镜的画面" } },
	});
	const card = page.getByTestId("chat-confirm");
	await expect(card).toContainText("重画第 2 镜的画面");
	await card.getByRole("button", { name: "确认" }).click();
	await expect.poll(() => routes.chatConfirms).toEqual([{ tool_call_id: "call-1", approved: true }]);
});
