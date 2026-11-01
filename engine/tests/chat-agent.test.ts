/**
 * Chat agent (ADR 0011): pi-agent-core Agent + read-only tools over the
 * backend API, driven by a scripted fake model. No real provider is called.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { piModels, registerFake } from "../src/pi-models.js";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { EngineDatabase } from "../src/db.js";
import { TextLlmService } from "../src/llm.js";
import { ChatAgents, ChatBusyError, chatItem, MAX_TURNS, recentContext, SYSTEM_PROMPT, type ChatItem } from "../src/agent/index.js";
import { BackendError, backendFetch, chatTools, readTools, writeTools, type BackendFetch } from "../src/agent/tools.js";
import { createEngineApp } from "../src/index.js";
import { installEngineRuntimeSchema } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");
const SECRET = "sk-test-never-shown";

const FIXTURES: Record<string, unknown> = {
  "/projects/1": { id: 1, title: "雨夜", status: "draft", style: "anime", story_outline: { logline: "一个雨夜" }, video_url: null },
  "/projects/1/characters": [
    { id: 11, name: "林", image_url: "/c/11.png", approval_state: "approved" },
    { id: 12, name: "雨", image_url: null, approval_state: "draft" },
  ],
  "/projects/1/shots": [
    { id: 21, order: 1, description: "开场", image_url: "/s/21.png", video_url: null, review_status: "passed", approval_state: "draft" },
    { id: 22, order: 2, description: "x".repeat(300), image_url: null, video_url: null, approval_state: "draft" },
  ],
  "/projects/1/runs/current": { state: "active", active_run: { id: 7, status: "running" }, awaiting_gate: null },
  "/runs/7/timing": { run_id: 7, current_stage: "render_shots", at_gate: false, elapsed_seconds: 12 },
  "/config": [
    { key: "TEXT_PROVIDER", value: "fake", is_sensitive: false },
    { key: "TEXT_API_KEY", value: SECRET, is_sensitive: true },
    { key: "ANTHROPIC_AUTH_TOKEN", value: SECRET, is_sensitive: false },
  ],
};

function fixtureApi(calls: string[] = []): BackendFetch {
  return async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push(method === "GET" ? path : `${method} ${path} ${JSON.stringify(init?.body ?? null)}`);
    if (method !== "GET") return { id: 9 };
    if (!(path in FIXTURES)) throw new BackendError(404, `no fixture ${path}`);
    return FIXTURES[path];
  };
}

/** The raw pi-agent-core messages saved for a project. */
const saved = (db: EngineDatabase, projectId = 1) => db.chatMessages(projectId).map((row) => row.message as AgentMessage);
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
const events = (db: EngineDatabase, type: string) =>
  (db.db.prepare("SELECT payload FROM engine_run_events WHERE run_id = 0 AND type = ? ORDER BY seq").all(type) as Array<{ payload: string }>).map(
    (row) => JSON.parse(row.payload) as Record<string, unknown>,
  );

const toolCalls = (messages: AgentMessage[]) =>
  messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall") : []));
const lastText = (messages: AgentMessage[]) => {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
};

describe("chat agent", () => {
  let dir: string;
  let db: EngineDatabase;

  beforeEach(() => {
    process.env.TEXT_PROVIDER = "fake";
    process.env.OPENOII_FAKE_STREAM_MS = "0";
    dir = mkdtempSync(join(tmpdir(), "openoii-chat-"));
    const file = join(dir, "o.db");
    const raw = new SqliteDatabase(file);
    raw.exec(SCHEMA);
    installEngineRuntimeSchema(raw);
    raw.close();
    db = new EngineDatabase(file);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a state question by calling a read tool, and saves the conversation", async () => {
    const calls: string[] = [];
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(calls) });
    await chat.send(1, "现在项目状态怎么样？").done;

    const history = saved(db);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    // the UI form hides the tool-call turn and the raw tool output
    expect(chat.history(1).map(({ role, tool, ok, text }) => ({ role, tool, ok, text }))).toEqual([
      { role: "user", tool: undefined, ok: undefined, text: "现在项目状态怎么样？" },
      { role: "tool", tool: "读取项目", ok: true, text: "" },
      { role: "assistant", tool: undefined, ok: undefined, text: "项目「雨夜」：2 个角色，2 个分镜，已出画面 1 个。" },
    ]);
    expect(toolCalls(history).map((c) => c.name)).toEqual(["get_project_state"]);
    expect(calls).toEqual(["/projects/1", "/projects/1/characters", "/projects/1/shots"]);
    expect(lastText(history)).toBe("项目「雨夜」：2 个角色，2 个分镜，已出画面 1 个。");
    // long shot descriptions are clipped before they reach the model
    expect(JSON.stringify(history)).toContain(`${"x".repeat(120)}…`);

    // One long-lived conversation per project: a restarted engine resumes it.
    const again = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    expect(again.history(1)).toHaveLength(3);
    await again.send(1, "运行到哪了").done;
    expect(lastText(saved(db))).toBe("运行 #7：running，当前阶段 render_shots。");
    expect(again.history(2)).toEqual([]);
  });

  it("never hands a secret to the model", async () => {
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    await chat.send(1, "看看模型设置").done;
    const stored = JSON.stringify(saved(db));
    expect(stored).toContain("TEXT_PROVIDER");
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("API_KEY");
    expect(lastText(saved(db))).toBe("文本提供商：fake。");
    const log = JSON.stringify(db.db.prepare("SELECT payload FROM engine_run_events").all());
    expect(log).not.toContain(SECRET);
  });

  it("has no tool that approves a gate and refuses to approve", async () => {
    const names = chatTools(1, fixtureApi()).map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(["get_project_state", "get_run_status", "read_settings"]);
    expect(names.filter((name) => /approve|confirm|gate|批准/.test(name))).toEqual([]);
    expect(SYSTEM_PROMPT).toContain("永远不能替用户通过审批门");
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    await chat.send(1, "帮我批准这个审批门").done;
    expect(toolCalls(saved(db))).toEqual([]);
    expect(lastText(saved(db))).toContain("不能替你批准");
    await chat.send(1, "你好").done;
    expect(lastText(saved(db))).toContain("项目状态");
  });

  it("returns a backend failure to the model as a tool error", async () => {
    const api: BackendFetch = async () => {
      throw new BackendError(500, "backend down");
    };
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api });
    await chat.send(1, "项目状态").done;
    expect(chat.history(1).find((m) => m.role === "tool")).toMatchObject({ ok: false, text: "backend down" });
    expect(lastText(saved(db))).toContain("backend down");
  });

  it("reports no run when nothing is running", async () => {
    const api: BackendFetch = async (path) => (path.endsWith("/runs/current") ? null : FIXTURES[path]);
    const result = await readTools(1, api)[1]!.execute("c1", {});
    expect(result.content[0]).toMatchObject({ text: '{"run":null}' });
  });

  it("is busy while answering, and stop aborts the turn", async () => {
    const slow = registerFake({ provider: "slow-chat", models: [{ id: "slow" }], tokensPerSecond: 20 });
    const streamFn: StreamFn = (model, context, options) => {
      slow.appendResponses([fauxAssistantMessage(fauxText("很长的回答".repeat(200)))]);
      return piModels.streamSimple(slow.getModel(), context, options);
    };
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(), streamFn });
    expect(chat.abort(1)).toBe(false);
    const turn = chat.send(1, "讲个长故事");
    expect(chat.busy(1)).toBe(true);
    expect(() => chat.send(1, "再来一个")).toThrow(ChatBusyError);
    await new Promise((r) => setTimeout(r, 50));
    expect(chat.abort(1)).toBe(true);
    await turn.done;
    expect(chat.busy(1)).toBe(false);
    expect(saved(db).at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(chat.history(1).at(-1)).toMatchObject({ role: "assistant", error: "已停止" });
    piModels.deleteProvider(slow.provider.id);
  });

  it("stops a model that keeps calling tools after MAX_TURNS turns", async () => {
    const loop = registerFake({ provider: "loop-chat", models: [{ id: "loop" }] });
    const streamFn: StreamFn = (model, context, options) => {
      loop.appendResponses([fauxAssistantMessage(fauxToolCall("get_run_status", {}), { stopReason: "toolUse" })]);
      return piModels.streamSimple(loop.getModel(), context, options);
    };
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(), streamFn });
    await chat.send(1, "一直查").done;
    expect(saved(db).filter((m) => m.role === "assistant")).toHaveLength(MAX_TURNS);
    piModels.deleteProvider(loop.provider.id);
  });

  it("runs a write tool only after the user confirms it, and says what it will do", async () => {
    const calls: string[] = [];
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(calls) });
    const turn = chat.send(1, "把第2镜重画一下");
    await until(() => chat.status(1).pending !== null);
    const card = chat.status(1).pending!;
    expect(card).toMatchObject({ tool: "重画分镜", summary: "重新生成分镜 #22 的画面" });
    expect(chat.busy(1)).toBe(true);
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
    expect(chat.confirm(1, "not-this-call", true)).toBe(false);
    expect(chat.confirm(1, card.tool_call_id, true)).toBe(true);
    await turn.done;
    expect(calls).toContain('POST /shots/22/regenerate {"type":"image","description":null}');
    expect(chat.status(1)).toEqual({ busy: false, text: "", pending: null });
    expect(lastText(saved(db))).toBe("已开始重画第 2 镜，可以在时间线里看进度。");
    expect(chat.confirm(1, card.tool_call_id, true)).toBe(false);
  });

  it("does not run a declined, stopped or expired write tool", async () => {
    const calls: string[] = [];
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(calls), confirmTimeoutMs: 30 });
    let turn = chat.send(1, "重画第1镜的视频");
    await until(() => chat.status(1).pending !== null);
    expect(chat.status(1).pending?.summary).toBe("重新生成分镜 #21 的视频");
    chat.confirm(1, chat.status(1).pending!.tool_call_id, false);
    await turn.done;
    expect(lastText(saved(db))).toBe("好的，没有重画。");
    expect(chat.history(1).find((m) => m.role === "tool" && m.tool === "重画分镜")).toMatchObject({ ok: false });

    turn = chat.send(1, "重画第1镜");
    await until(() => chat.status(1).pending !== null);
    expect(chat.abort(1)).toBe(true);
    await turn.done;
    expect(chat.status(1).pending).toBeNull();

    await chat.send(1, "重画第1镜").done; // nobody answers: the card expires
    expect(lastText(saved(db))).toBe("好的，没有重画。");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);

    await chat.send(1, "重画第9镜").done;
    expect(lastText(saved(db))).toBe("这个项目没有第 9 镜。");
  });

  it("checks that a shot or character belongs to the project before writing", async () => {
    const calls: string[] = [];
    const tools = writeTools(1, fixtureApi(calls));
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    await expect(tool("regenerate_shot").execute("c", { shot_id: 99, type: "image" })).rejects.toThrow("分镜 #99 不属于当前项目");
    await expect(tool("update_character").execute("c", { character_id: 99, name: "x" })).rejects.toThrow("角色 #99 不属于当前项目");
    expect(calls.filter((call) => call.startsWith("P"))).toEqual([]);

    await tool("regenerate_character").execute("c", { character_id: 12, description: "红伞" });
    await tool("update_shot").execute("c", { shot_id: 21, dialogue: "走吧" });
    await tool("update_character").execute("c", { character_id: 11, name: "林夕" });
    await tool("update_outline").execute("c", { logline: "雨停了", tone: 3 });
    await tool("start_run").execute("c", {});
    await tool("resume_run").execute("c", {});
    await tool("cancel_run").execute("c", {});
    await tool("recompose").execute("c", {});
    expect(calls.filter((call) => /^(POST|PUT|PATCH)/.test(call))).toEqual([
      'POST /characters/12/regenerate {"type":"image","description":"红伞"}',
      'PATCH /shots/21 {"dialogue":"走吧"}',
      'PATCH /characters/11 {"name":"林夕"}',
      'PUT /projects/1/outline {"logline":"雨停了"}',
      'POST /projects/1/runs {"notes":null,"auto_mode":false}',
      "POST /runs/7/resume null",
      "POST /runs/7/cancel null",
      "POST /projects/1/runs/recompose null",
    ]);

    const idle = writeTools(1, async (path) => (path.endsWith("/runs/current") ? null : {}));
    await expect(idle.find((t) => t.name === "cancel_run")!.execute("c", {})).rejects.toThrow("当前没有");
    const summaries = tools.map((t) => t.confirm!({ shot_id: 3, character_id: 4, type: "video", notes: "快一点", description: "新", name: "n", logline: "l" }));
    expect(summaries).toEqual([
      "从头完整生成这个项目，要求：快一点",
      "继续当前中断的运行",
      "停止当前运行",
      "重新生成分镜 #3 的视频：新",
      "重新生成角色 #4 的形象图：新",
      "用现有片段重新合成成片",
      "修改大纲的 logline",
      "修改分镜 #3 的 description",
      "修改角色 #4 的 name、description",
    ]);
    expect(readTools(1, fixtureApi()).every((t) => !("confirm" in t))).toBe(true);
  });

  it("publishes saved messages and one live status frame per project", async () => {
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    await chat.send(1, "项目状态").done;
    const messages = events(db, "chat_message");
    expect(messages.map((e) => (e.message as ChatItem).role)).toEqual(["user", "tool", "assistant"]);
    expect(messages[0]).toMatchObject({ project_id: 1, message: { id: expect.any(Number), text: "项目状态" } });
    expect(events(db, "chat_status")).toEqual([{ project_id: 1, busy: false, text: "", pending: null }]);
  });

  it("shows provider errors as one short line", () => {
    const labels = new Map<string, string>();
    const base = { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage;
    const error = { ...base, stopReason: "error", errorMessage: `<html>${"x".repeat(400)}\n<body>` } as AgentMessage;
    const item = chatItem(5, error, labels)!;
    expect(item.error!.length).toBeLessThanOrEqual(161);
    expect(item.error).not.toContain("<body>");
    expect(chatItem(6, { ...base, stopReason: "error" } as AgentMessage, labels)?.error).toBe("模型调用失败");
    expect(chatItem(7, { ...base, stopReason: "stop" } as AgentMessage, labels)).toBeNull();
    expect(chatItem(8, { role: "custom" } as unknown as AgentMessage, labels)).toBeNull();
  });

  it("keeps the newest turns in the model context without orphaning tool results", () => {
    const user = (n: number) => ({ role: "user", content: `u${n}`, timestamp: n }) as AgentMessage;
    const tool = (n: number) => ({ role: "toolResult", toolCallId: `t${n}`, toolName: "x", content: [], isError: false, timestamp: n }) as AgentMessage;
    const short = [user(1), tool(2)];
    expect(recentContext(short, 4)).toBe(short);
    expect(recentContext([user(1), tool(2), tool(3), user(4), tool(5)], 4).map((m) => m.timestamp)).toEqual([4, 5]);
    expect(recentContext([user(1), tool(2), tool(3), tool(4)], 2)).toHaveLength(2);
  });

  it("uses the configured text model for real providers", () => {
    process.env.TEXT_PROVIDER = "openai";
    process.env.TEXT_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.TEXT_MODEL = "custom-text";
    process.env.TEXT_API_KEY = "test-key";
    try {
      const resolved = new TextLlmService(db).agentModel();
      expect(resolved.model).toMatchObject({ id: "custom-text", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" });
      expect(resolved.apiKey).toBe("test-key");
      delete process.env.TEXT_BASE_URL;
      expect(() => new TextLlmService(db).agentModel()).toThrow(/base URL/);
    } finally {
      for (const key of ["TEXT_BASE_URL", "TEXT_MODEL", "TEXT_API_KEY"]) delete process.env[key];
      process.env.TEXT_PROVIDER = "fake";
    }
    expect(new TextLlmService(db).agentModel()).toEqual({ model: null });
  });

  it("is never imported by the workflow", () => {
    const runner = readFileSync(resolve(import.meta.dirname, "../src/pipeline/runner.ts"), "utf8");
    const agents = readFileSync(resolve(import.meta.dirname, "../src/agents/index.ts"), "utf8");
    expect(runner).not.toContain("agent/index");
    expect(agents).not.toContain("agent/index");
  });
});

describe("chat HTTP routes", () => {
  let dir: string;
  let backend: Server;
  let app: ReturnType<typeof createEngineApp>;
  let base: string;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  beforeEach(async () => {
    process.env.TEXT_PROVIDER = "fake";
    process.env.OPENOII_FAKE_STREAM_MS = "0";
    backend = createServer((req: IncomingMessage, res) => {
      const path = (req.url ?? "").replace(/^\/api\/v1/, "");
      if (path === "/wrapped") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "RUN_ALREADY_ACTIVE", message: "已有运行在进行" } }));
        return;
      }
      const body = FIXTURES[path];
      res.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? { detail: `missing ${path}` }));
    });
    process.env.OPENOII_BACKEND_URL = await listen(backend);
    dir = mkdtempSync(join(tmpdir(), "openoii-chat-http-"));
    const file = join(dir, "o.db");
    const raw = new SqliteDatabase(file);
    raw.exec(SCHEMA);
    installEngineRuntimeSchema(raw);
    raw.close();
    app = createEngineApp(file);
    base = await listen(app.server);
  });

  afterEach(async () => {
    await new Promise((done) => app.server.close(done));
    await new Promise((done) => backend.close(done));
    app.db.close();
    delete process.env.OPENOII_BACKEND_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  it("accepts a message, answers through the backend API and serves the history", async () => {
    expect(await (await fetch(`${base}/chat/1`)).json()).toEqual({ messages: [], busy: false, text: "", pending: null });
    expect((await post("/chat/1", { content: "  " })).status).toBe(422);
    expect((await post("/chat/1", { content: "项目状态" })).status).toBe(202);
    expect((await post("/chat/1", { content: "再问一次" })).status).toBe(409);
    for (let i = 0; i < 100 && app.chat.busy(1); i += 1) await new Promise((r) => setTimeout(r, 10));
    const body = (await (await fetch(`${base}/chat/1`)).json()) as { messages: ChatItem[]; busy: boolean };
    expect(body.busy).toBe(false);
    expect(body.messages.at(-1)?.text).toBe("项目「雨夜」：2 个角色，2 个分镜，已出画面 1 个。");
    expect(await (await post("/chat/1/abort")).json()).toEqual({ aborted: false });
  });

  it("confirms a pending write tool over HTTP", async () => {
    expect((await post("/chat/1/confirm", { tool_call_id: 1 })).status).toBe(422);
    expect((await post("/chat/1/confirm", { tool_call_id: "x", approved: true })).status).toBe(404);
    expect((await post("/chat/1", { content: "重画第1镜" })).status).toBe(202);
    await until(() => app.chat.status(1).pending !== null);
    const state = (await (await fetch(`${base}/chat/1`)).json()) as { busy: boolean; pending: { tool_call_id: string } };
    expect(state.busy).toBe(true);
    expect((await post("/chat/1/confirm", { tool_call_id: state.pending.tool_call_id, approved: false })).status).toBe(200);
    await until(() => !app.chat.busy(1));
  });

  it("surfaces backend errors with their detail", async () => {
    await expect(backendFetch(process.env.OPENOII_BACKEND_URL!)("/nope")).rejects.toThrow(/missing \/nope/);
    await expect(backendFetch(process.env.OPENOII_BACKEND_URL!)("/wrapped")).rejects.toThrow("已有运行在进行");
  });
});
