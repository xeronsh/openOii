/**
 * Real-provider regressions found running the full flow against an
 * OpenAI-compatible endpoint (muse2api): critic scoring without pixels,
 * unchecked JSON repair, TEXT_ENDPOINT ignored, relative / expiring media
 * URLs, async video tasks, base-path loss and fractional durations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { TextLlmService, openAiCompatibleBaseUrl, type LlmRequest } from "../src/llm.js";
import {
  MediaService,
  absoluteMediaUrl,
  extractMediaUrl,
  joinEndpoint,
  normalizeVideoDuration,
  sniffImageMime,
  videoTaskPollUrls,
  type MediaSettings,
} from "../src/media/media.js";
import { OUTPUT_SHAPES, critiqueScore, runCritique, type StageContext } from "../src/agents/index.js";
import { installEngineRuntimeSchema } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const WEBP = Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(24)]);

function newDb(dir: string): EngineDatabase {
  const file = join(dir, "o.db");
  const raw = new SqliteDatabase(file);
  raw.exec(SCHEMA);
  installEngineRuntimeSchema(raw);
  raw.close();
  return new EngineDatabase(file);
}

function setConfig(edb: EngineDatabase, values: Record<string, string>): void {
  const columns = (edb.db.prepare("PRAGMA table_info(configitem)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const [key, value] of Object.entries(values)) {
    const row: Record<string, unknown> = { key, value };
    if (columns.includes("is_sensitive")) row.is_sensitive = 0;
    if (columns.includes("created_at")) row.created_at = new Date().toISOString();
    if (columns.includes("updated_at")) row.updated_at = new Date().toISOString();
    const keys = Object.keys(row);
    edb.db
      .prepare(`INSERT OR REPLACE INTO configitem (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((k) => row[k]));
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ role: "assistant" }) + chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

describe("structured output repair", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-repair-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function llmWithAnswers(answers: string[]) {
    const edb = newDb(dir);
    const llm = new TextLlmService(edb, { provider: "fake", model: "fake" } as never, {
      workflow_version: 1,
      policy: { x: 1 },
    });
    const calls: Array<{ req: LlmRequest; opts: { withRunContext?: boolean } | undefined }> = [];
    (llm as unknown as { generateOnce: unknown }).generateOnce = vi.fn(
      async (req: LlmRequest, opts?: { withRunContext?: boolean }) => {
        calls.push({ req, opts });
        return { text: answers[calls.length - 1] ?? "", provider: "fake", model: "fake" };
      },
    );
    return { edb, llm, calls };
  }

  it("rejects a repair that echoes the request envelope", async () => {
    const { edb, llm } = llmWithAnswers([
      "not json",
      JSON.stringify({ invalid_output: "not json", run_context: { workflow_version: 1 } }),
    ]);
    await expect(llm.generate({ system: "s", prompt: "{}" })).rejects.toThrow(/echoes the request envelope/);
    edb.close();
  });

  it("validates the repaired object against the operation's shape", async () => {
    const { edb, llm } = llmWithAnswers(['{"shots": "oops"', JSON.stringify({ text: "anything" })]);
    await expect(
      llm.generate({ system: "s", prompt: "{}", validate: OUTPUT_SHAPES.planShots }),
    ).rejects.toThrow(/shots array/);
    edb.close();
  });

  it("repairs a valid-JSON answer of the wrong shape and keeps operation and budget", async () => {
    const operation = { operationId: "op-1" } as never;
    const { edb, llm, calls } = llmWithAnswers([
      JSON.stringify({ story: "wrong" }),
      JSON.stringify({ story_outline: { logline: "x" } }),
    ]);
    const res = await llm.generate({
      system: "s",
      prompt: "{}",
      validate: OUTPUT_SHAPES.outline,
      operation,
    });
    expect(JSON.parse(res.text)).toEqual({ story_outline: { logline: "x" } });
    expect(calls).toHaveLength(2);
    const repair = calls[1]!;
    expect(repair.req.operation).toBe(operation);
    expect(repair.req.maxTokens).toBe(8192);
    expect(repair.opts?.withRunContext).toBe(false);
    expect(repair.req.prompt).toBe(JSON.stringify({ story: "wrong" }));
    expect(repair.req.system).toMatch(/story_outline/);
    edb.close();
  });

  it("does not spend a repair call after the run was cancelled (#149)", async () => {
    const { edb, llm, calls } = llmWithAnswers(['{"story_outline": ', JSON.stringify({ story_outline: {} })]);
    const controller = new AbortController();
    (llm as unknown as { generateOnce: (req: LlmRequest) => Promise<unknown> }).generateOnce = vi.fn(async (req: LlmRequest) => {
      calls.push({ req, opts: undefined });
      // The stop lands while the first answer streams in: it comes back cut off.
      controller.abort();
      return { text: '{"story_outline": ', provider: "fake", model: "fake" };
    });
    await expect(
      llm.generate({ system: "s", prompt: "{}", validate: OUTPUT_SHAPES.outline, signal: controller.signal }),
    ).rejects.toThrow("run cancelled: llm request aborted");
    expect(calls).toHaveLength(1);
    edb.close();
  });

  it("uses the caller's output budget for the repair", async () => {
    const { edb, llm, calls } = llmWithAnswers(["nope", '{"visual_notes": "red scarf"}']);
    await llm.generate({ system: "s", prompt: "p", maxTokens: 512, validate: OUTPUT_SHAPES.visualNotes });
    expect(calls[1]!.req.maxTokens).toBe(512);
    edb.close();
  });
});

describe("critic verdicts", () => {
  it("never turns a missing or invalid score into 0", () => {
    expect(critiqueScore({})).toBeNull();
    expect(critiqueScore({ score: null })).toBeNull();
    expect(critiqueScore({ score: "n/a" })).toBeNull();
    expect(critiqueScore({ score: 11 })).toBeNull();
    expect(critiqueScore({ score: "7.5" })).toBe(7.5);
    expect(critiqueScore({ total_score: 0 })).toBe(0);
    expect(OUTPUT_SHAPES.critique({ issues: [] })).toBeNull();
    expect(OUTPUT_SHAPES.critique({ score: "bad" })).toMatch(/number/);
  });

  function critiqueContext(answer: Record<string, unknown>) {
    const requests: LlmRequest[] = [];
    const messages: string[] = [];
    const results: unknown[] = [];
    const ctx = {
      projectId: 1,
      runId: 1,
      signal: new AbortController().signal,
      operation: null,
      critiqueRounds: { characters: 0, shots: 0 },
      critiqueScoreThreshold: 6,
      critiqueMaxRounds: 2,
      shared: {
        charactersForProject: () => [
          { id: 31, name: "小雨", description: "红围巾女孩", image_url: "/static/a.png" },
        ],
        insertAgentMessage: () => undefined,
      },
      emitter: {
        sendMessage: async (_agent: string, content: string) => void messages.push(content),
        llmStream: () => ({ update: () => undefined, end: () => undefined }),
        critiqueResult: (data: unknown) => void results.push(data),
        consistencyEvalCompleted: () => undefined,
      },
      media: { readImageBytes: async () => PNG },
      llm: {
        generate: async (req: LlmRequest) => {
          requests.push(req);
          return { text: JSON.stringify(answer), provider: "openai", model: "m" };
        },
      },
    } as unknown as StageContext;
    return { ctx, requests, messages, results };
  }

  it("sends the render as image content, not as a URL in the prompt", async () => {
    const { ctx, requests, results } = critiqueContext({
      score: 8.2,
      dimensions: { consistency: 8, quality: 8, composition: 9 },
      issues: [],
      suggestions: [],
    });
    const outcome = await runCritique(ctx, "character");
    expect(outcome.willRegenerate).toBe(false);
    expect(requests[0]!.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
    expect(requests[0]!.prompt).not.toContain("/static/a.png");
    expect(requests[0]!.prompt).toContain("红围巾女孩");
    expect(results).toHaveLength(1);
  });

  it("treats a missing score as no verdict: no regeneration, a warning instead", async () => {
    const { ctx, messages, results } = critiqueContext({ issues: [], suggestions: [] });
    const outcome = await runCritique(ctx, "character");
    expect(outcome.willRegenerate).toBe(false);
    expect(outcome.regenerateEntityIds).toEqual([]);
    expect(results).toHaveLength(0);
    expect(messages.some((m) => m.includes("未能完成审查") && m.includes("不重新生成"))).toBe(true);
  });

  it("still regenerates on a real low score", async () => {
    const { ctx } = critiqueContext({ score: 3, dimensions: {}, issues: ["脸型不符"], suggestions: [] });
    const outcome = await runCritique(ctx, "character");
    expect(outcome).toMatchObject({ willRegenerate: true, regenerateEntityIds: [31], minScore: 3 });
  });
});

describe("shot critic asks for its story checks (#147)", () => {
  function shotCritique(answers: Array<Record<string, unknown>>, targetShotIds?: number[]) {
    const requests: LlmRequest[] = [];
    const reviews: Array<{ id: number; status: unknown }> = [];
    const shots = [
      { id: 41, project_id: 1, order: 1, description: "乌鸦看见水瓶\n画面状态：水位很低", image_url: "/static/s1.png", character_ids: "[]" },
      { id: 42, project_id: 1, order: 2, description: "乌鸦丢石子\n画面状态：水位升到一半", image_url: "/static/s2.png", character_ids: "[]" },
    ];
    const ctx = {
      projectId: 1,
      runId: 1,
      signal: new AbortController().signal,
      operation: null,
      targetShotIds,
      critiqueRounds: { characters: 0, shots: 0 },
      critiqueScoreThreshold: 6,
      critiqueMaxRounds: 2,
      shared: {
        shotsForProject: () => shots,
        charactersForProject: () => [],
        getProject: () => ({ id: 1, visual_bible: null }),
        getShot: (id: number) => shots.find((shot) => shot.id === id),
        getLiveShot: (id: number) => shots.find((shot) => shot.id === id),
        updateShot: (id: number, fields: Record<string, unknown>) => void reviews.push({ id, status: fields.review_status }),
        insertAgentMessage: () => undefined,
      },
      emitter: {
        sendMessage: async () => undefined,
        llmStream: () => ({ update: () => undefined, end: () => undefined }),
        critiqueResult: () => undefined,
        consistencyEvalCompleted: () => undefined,
        commit: (_type: string, write: () => unknown) => write(),
        shotUpdated: () => undefined,
      },
      media: { readImageBytes: async () => PNG },
      llm: {
        generate: async (req: LlmRequest) => {
          requests.push(req);
          const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
          return { text: JSON.stringify(answer), provider: "openai", model: "m" };
        },
      },
    } as unknown as StageContext;
    return { ctx, requests, reviews };
  }
  const allTrue = { characters: true, state: true, props: true, look: true, no_future_beat: true };

  it("asks once more when the reply skips the checks, then passes on them", async () => {
    const { ctx, requests } = shotCritique([{ score: 8, issues: [] }, { score: 8, checks: allTrue, issues: [] }], [42]);
    const outcome = await runCritique(ctx, "shot");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("上一次回答缺少 checks");
    expect(outcome.willRegenerate).toBe(false);
  });

  it("does not pass a reported issue on score alone when checks never come", async () => {
    const { ctx } = shotCritique([{ score: 9, issues: ["水位没有升高"] }], [42]);
    const outcome = await runCritique(ctx, "shot");
    expect(outcome).toMatchObject({ willRegenerate: true, regenerateEntityIds: [42] });
  });

  it("sends a failed check back for a redraw", async () => {
    const { ctx } = shotCritique([{ score: 9, checks: { ...allTrue, state: false }, issues: [] }], [42]);
    const outcome = await runCritique(ctx, "shot");
    expect(outcome.regenerateEntityIds).toEqual([42]);
  });

  it("reviews only the targeted shots", async () => {
    const { ctx, requests } = shotCritique([{ score: 8, checks: allTrue, issues: [] }], [42]);
    await runCritique(ctx, "shot");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain("开始状态：水位很低");
  });
});

describe("OpenAI-compatible text endpoint", () => {
  let dir: string;
  let server: Server;
  let seen: Array<{ path: string; body: Record<string, unknown>; auth?: string }>;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openoii-text-"));
    seen = [];
    server = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      seen.push({ path: req.url ?? "", body, auth: req.headers.authorization });
      if (req.url !== "/api/v3/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(JSON.stringify({ score: 7 })));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("joins base and endpoint like the Python backend", () => {
    expect(openAiCompatibleBaseUrl("https://h/v1", "/chat/completions")).toBe("https://h/v1");
    expect(openAiCompatibleBaseUrl("https://h/", "api/v3/chat/completions")).toBe("https://h/api/v3");
    expect(openAiCompatibleBaseUrl("https://h/v1", undefined)).toBe("https://h/v1");
    expect(() => openAiCompatibleBaseUrl("https://h", "/v1/responses")).toThrow(/TEXT_ENDPOINT/);
  });

  it("honours TEXT_ENDPOINT from config and sends images as image_url parts", async () => {
    const edb = newDb(dir);
    setConfig(edb, {
      TEXT_PROVIDER: "openai",
      TEXT_BASE_URL: base,
      TEXT_ENDPOINT: "/api/v3/chat/completions",
      TEXT_MODEL: "custom-vision",
      TEXT_API_KEY: "k",
    });
    const llm = new TextLlmService(edb);
    expect(llm.resolveProvider().endpoint).toBe("/api/v3/chat/completions");
    const res = await llm.generate({
      system: "s",
      prompt: "review",
      images: [{ data: PNG.toString("base64"), mimeType: "image/png" }],
    });
    expect(JSON.parse(res.text)).toEqual({ score: 7 });
    expect(seen[0]!.path).toBe("/api/v3/chat/completions");
    const messages = seen[0]!.body.messages as Array<{ role: string; content: unknown }>;
    const user = messages.find((m) => m.role === "user")!;
    expect(user.content).toEqual([
      { type: "text", text: "review" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
    ]);
    edb.close();
  });

  it("keeps the chat-completions request shape across the pi-ai upgrade", async () => {
    // P1 upgrade guard: system prompt, key, output budget and
    // streaming must reach an OpenAI-compatible server exactly as before.
    const edb = newDb(dir);
    setConfig(edb, {
      TEXT_PROVIDER: "openai",
      TEXT_BASE_URL: base,
      TEXT_ENDPOINT: "/api/v3/chat/completions",
      TEXT_MODEL: "custom-text",
      TEXT_API_KEY: "test-key",
    });
    const res = await new TextLlmService(edb).generate({ system: "sys-prompt", prompt: "hello", maxTokens: 321 });
    expect(JSON.parse(res.text)).toEqual({ score: 7 });
    const call = seen[0]!;
    expect(call.auth).toBe("Bearer test-key");
    expect(call.body.stream).toBe(true);
    expect(call.body.model).toBe("custom-text");
    expect(call.body.max_tokens).toBe(321);
    const messages = call.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toMatchObject({ role: "system", content: "sys-prompt" });
    expect(messages.find((m) => m.role === "user")?.content).toBe("hello");
    edb.close();
  });

  it("honours a pinned snapshot endpoint", () => {
    const edb = newDb(dir);
    const llm = new TextLlmService(edb, {
      provider: "openai",
      base_url: base,
      model: "m",
      endpoint: "/api/v3/chat/completions",
      credential_keys: [],
    });
    expect(llm.resolveProvider().endpoint).toBe("/api/v3/chat/completions");
    edb.close();
  });
});

describe("media URL helpers", () => {
  it("keeps the base path when joining an endpoint with a leading slash", () => {
    expect(joinEndpoint("https://h/v1", "/videos/generations")).toBe("https://h/v1/videos/generations");
    expect(joinEndpoint("https://h/", "v1/images/generations")).toBe("https://h/v1/images/generations");
    expect(joinEndpoint("https://h/v1", "https://other/x")).toBe("https://other/x");
  });

  it("resolves provider-relative media URLs", () => {
    expect(absoluteMediaUrl("/v1/media/a.webp", "http://h:1/v1")).toBe("http://h:1/v1/media/a.webp");
    expect(absoluteMediaUrl("media/a.webp", "http://h:1/v1")).toBe("http://h:1/v1/media/a.webp");
    expect(absoluteMediaUrl("https://cdn/a.webp", "http://h")).toBe("https://cdn/a.webp");
  });

  it("sniffs image types and rounds durations for every provider", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("<svg xmlns='x'/>"))).toBe("image/svg+xml");
    expect(sniffImageMime(Buffer.from("hello"))).toBeNull();
    expect(normalizeVideoDuration("openai", 4.5)).toBe(5);
    expect(normalizeVideoDuration("fake", 4.4)).toBe(4);
    expect(normalizeVideoDuration("openai", 0.2)).toBe(1);
    expect(normalizeVideoDuration("doubao", 9.6)).toBe(10);
    expect(normalizeVideoDuration("doubao", 4.5)).toBe(5);
  });

  it("derives task poll URLs and reads nested result URLs", () => {
    expect(videoTaskPollUrls("https://h", "/v1/videos/generations", "t 1")).toEqual([
      "https://h/v1/videos/t%201",
      "https://h/v1/videos/generations/t%201",
    ]);
    expect(extractMediaUrl({ result: { url: "/v1/media/v.mp4" } })).toBe("/v1/media/v.mp4");
    expect(extractMediaUrl({ data: [{ url: "u" }] })).toBe("u");
    expect(extractMediaUrl({ status: "queued" })).toBeNull();
  });
});

describe("OpenAI-compatible media provider", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let seen: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  let polls: number;
  let imageFailures: number;

  beforeEach(async () => {
    imageFailures = 0;
    dir = mkdtempSync(join(tmpdir(), "openoii-media-"));
    seen = [];
    polls = 0;
    server = createServer(async (req, res) => {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, body });
      if (path === "/v1/images/generations" && imageFailures > 0) {
        imageFailures -= 1;
        res.writeHead(524).end("origin timeout");
      } else if (path === "/v1/images/generations") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ url: "/v1/media/img.webp" }] }));
      } else if (path === "/v1/media/img.webp") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(WEBP);
      } else if (path === "/v1/videos/generations" && body.prompt === "local") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", url: "/static/videos/gateway-clip.mp4" }));
      } else if (path === "/v1/videos/generations") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "task_1", status: "queued" }));
      } else if (path === "/v1/videos/task_1") {
        polls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            polls < 2
              ? { id: "task_1", status: "running" }
              : { id: "task_1", status: "completed", result: { url: "/v1/media/clip.mp4" } },
          ),
        );
      } else if (path === "/v1/media/clip.mp4") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.from("fake-mp4-bytes"));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function service(): { media: MediaService; registered: string[] } {
    const media = new MediaService({
      staticDir: dir,
      imageProvider: "openai",
      imageApiKey: "k",
      imageBaseUrl: base,
      imageEndpoint: "/images/generations",
      imageModel: "muse-image",
      enableImageToImage: true,
      fakeImageFixtureUrl: null,
      videoProvider: "openai",
      videoApiKey: "k",
      videoBaseUrl: base,
      videoEndpoint: "/videos/generations",
      videoModel: "muse-video",
      enableImageToVideo: true,
      videoInlineLocalImages: true,
      publicBaseUrl: null,
      fakeVideoFixtureUrl: null,
    } as MediaSettings);
    const registered: string[] = [];
    media.setMediaRegistrar((path) => void registered.push(path));
    return { media, registered };
  }

  it("absolutises a relative image URL and stores the image locally", async () => {
    const { media, registered } = service();
    const url = await media.generateImageUrl({ prompt: "lantern" });
    expect(seen[0]!.path).toBe("/v1/images/generations");
    expect(url).toMatch(/^\/static\/managed-v1\/[\w-]+\.webp$/);
    expect(registered).toEqual([url.slice("/static/".length)]);
    expect(readFileSync(join(dir, url.slice("/static/".length)))).toEqual(WEBP);
  });

  it("polls an async video task, inlines a remote reference image and stores the mp4", async () => {
    vi.stubEnv("OPENOII_VIDEO_POLL_MS", "5");
    const { media } = service();
    const url = await media.generateVideoUrl({
      prompt: "clip",
      imageUrl: `${base}/media/img.webp`,
      duration: 4.5,
    });
    const create = seen.find((s) => s.path === "/v1/videos/generations")!;
    expect(create.body.duration).toBe(5);
    expect(create.body.image_url).toBe(`data:image/webp;base64,${WEBP.toString("base64")}`);
    expect(polls).toBe(2);
    expect(url).toMatch(/^\/static\/managed-v1\/[\w-]+\.mp4$/);
    expect(existsSync(join(dir, url.slice("/static/".length)))).toBe(true);
  });

  it("retries transient provider failures (gateway 524) with the same idempotency key", async () => {
    vi.stubEnv("OPENOII_PROVIDER_RETRY_MS", "1");
    imageFailures = 2;
    const { media } = service();
    const url = await media.generateImageUrl({ prompt: "lantern" });
    expect(seen.filter((s) => s.path === "/v1/images/generations")).toHaveLength(3);
    expect(url).toMatch(/^\/static\/managed-v1\/[\w-]+\.webp$/);
  });

  it("gives up after the retry budget and reports the status", async () => {
    vi.stubEnv("OPENOII_PROVIDER_RETRY_MS", "1");
    imageFailures = 10;
    const { media } = service();
    await expect(media.generateImageUrl({ prompt: "lantern" })).rejects.toThrow(
      "image provider failed: 524",
    );
    expect(seen.filter((s) => s.path === "/v1/images/generations")).toHaveLength(4);
  });

  it("keeps a relative /static/ URL that a local gateway already wrote into our static dir", async () => {
    mkdirSync(join(dir, "videos"), { recursive: true });
    writeFileSync(join(dir, "videos", "gateway-clip.mp4"), "mp4");
    const { media } = service();
    const url = await media.generateVideoUrl({ prompt: "local", duration: 5 });
    expect(url).toBe("/static/videos/gateway-clip.mp4");
    expect(seen.map((s) => s.path)).toEqual(["/v1/videos/generations"]);
  });
});
