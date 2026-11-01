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
  registerFauxProvider,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { EngineDatabase } from "../src/db.js";
import { TextLlmService } from "../src/llm.js";
import { ChatAgents, ChatBusyError, MAX_TURNS, recentContext, SYSTEM_PROMPT } from "../src/agent/index.js";
import { BackendError, backendFetch, readTools, type BackendFetch } from "../src/agent/tools.js";
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
  return async (path) => {
    calls.push(path);
    if (!(path in FIXTURES)) throw new BackendError(404, `no fixture ${path}`);
    return FIXTURES[path];
  };
}

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

    const history = chat.history(1);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(toolCalls(history).map((c) => c.name)).toEqual(["get_project_state"]);
    expect(calls).toEqual(["/projects/1", "/projects/1/characters", "/projects/1/shots"]);
    expect(lastText(history)).toBe("项目「雨夜」：2 个角色，2 个分镜，已出画面 1 个。");
    // long shot descriptions are clipped before they reach the model
    expect(JSON.stringify(history)).toContain(`${"x".repeat(120)}…`);

    // One long-lived conversation per project: a restarted engine resumes it.
    const again = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    expect(again.history(1)).toHaveLength(4);
    await again.send(1, "运行到哪了").done;
    expect(lastText(again.history(1))).toBe("运行 #7：running，当前阶段 render_shots。");
    expect(again.history(2)).toEqual([]);
  });

  it("never hands a secret to the model", async () => {
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    await chat.send(1, "看看模型设置").done;
    const saved = JSON.stringify(chat.history(1));
    expect(saved).toContain("TEXT_PROVIDER");
    expect(saved).not.toContain(SECRET);
    expect(saved).not.toContain("API_KEY");
    expect(lastText(chat.history(1))).toBe("文本提供商：fake。");
  });

  it("has no tool that approves a gate and refuses to approve", async () => {
    const names = readTools(1, fixtureApi()).map((t) => t.name);
    expect(names).toEqual(["get_project_state", "get_run_status", "read_settings"]);
    expect(SYSTEM_PROMPT).toContain("永远不能替用户通过审批门");
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi() });
    await chat.send(1, "帮我批准这个审批门").done;
    expect(toolCalls(chat.history(1))).toEqual([]);
    expect(lastText(chat.history(1))).toContain("不能替你批准");
    await chat.send(1, "你好").done;
    expect(lastText(chat.history(1))).toContain("项目状态");
  });

  it("returns a backend failure to the model as a tool error", async () => {
    const api: BackendFetch = async () => {
      throw new BackendError(500, "backend down");
    };
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api });
    await chat.send(1, "项目状态").done;
    const result = chat.history(1).find((m) => m.role === "toolResult");
    expect(result).toMatchObject({ role: "toolResult", isError: true });
    expect(lastText(chat.history(1))).toContain("backend down");
  });

  it("reports no run when nothing is running", async () => {
    const api: BackendFetch = async (path) => (path.endsWith("/runs/current") ? null : FIXTURES[path]);
    const result = await readTools(1, api)[1]!.execute("c1", {});
    expect(result.content[0]).toMatchObject({ text: '{"run":null}' });
  });

  it("is busy while answering, and stop aborts the turn", async () => {
    const slow = registerFauxProvider({ provider: "slow-chat", models: [{ id: "slow" }], tokensPerSecond: 20 });
    const streamFn: StreamFn = (model, context, options) => {
      slow.appendResponses([fauxAssistantMessage(fauxText("很长的回答".repeat(200)))]);
      return streamSimple(slow.getModel(), context, options);
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
    const last = chat.history(1).at(-1);
    expect(last).toMatchObject({ role: "assistant", stopReason: "aborted" });
    slow.unregister();
  });

  it("stops a model that keeps calling tools after MAX_TURNS turns", async () => {
    const loop = registerFauxProvider({ provider: "loop-chat", models: [{ id: "loop" }] });
    const streamFn: StreamFn = (model, context, options) => {
      loop.appendResponses([fauxAssistantMessage(fauxToolCall("get_run_status", {}), { stopReason: "toolUse" })]);
      return streamSimple(loop.getModel(), context, options);
    };
    const chat = new ChatAgents({ db, llm: new TextLlmService(db), api: fixtureApi(), streamFn });
    await chat.send(1, "一直查").done;
    expect(chat.history(1).filter((m) => m.role === "assistant")).toHaveLength(MAX_TURNS);
    loop.unregister();
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
    expect(await (await fetch(`${base}/chat/1`)).json()).toEqual({ messages: [], busy: false });
    expect((await post("/chat/1", { content: "  " })).status).toBe(422);
    expect((await post("/chat/1", { content: "项目状态" })).status).toBe(202);
    expect((await post("/chat/1", { content: "再问一次" })).status).toBe(409);
    for (let i = 0; i < 100 && app.chat.busy(1); i += 1) await new Promise((r) => setTimeout(r, 10));
    const body = (await (await fetch(`${base}/chat/1`)).json()) as { messages: AgentMessage[]; busy: boolean };
    expect(body.busy).toBe(false);
    expect(lastText(body.messages)).toBe("项目「雨夜」：2 个角色，2 个分镜，已出画面 1 个。");
    expect(await (await post("/chat/1/abort")).json()).toEqual({ aborted: false });
  });

  it("surfaces backend errors with their detail", async () => {
    await expect(backendFetch(process.env.OPENOII_BACKEND_URL!)("/nope")).rejects.toThrow(/missing \/nope/);
  });
});
