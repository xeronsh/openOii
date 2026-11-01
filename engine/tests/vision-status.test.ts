/**
 * TextLlmService.visionStatus: the critic reviews images only when a vision
 * endpoint answers; otherwise shots are marked 未检查 with this reason.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EngineDatabase } from "../src/db.js";
import { TextLlmService } from "../src/llm.js";

let server: Server;
let base: string;
let status = 200;
let hits = 0;
let auth: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    auth = req.headers.authorization;
    res.writeHead(req.url === "/v1/models" ? status : 404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

function llm(config: Record<string, string>): TextLlmService {
  const db = {
    configValue: (key: string, _env?: string, fallback?: string) => config[key] ?? fallback,
  } as unknown as EngineDatabase;
  return new TextLlmService(db);
}

describe("visionStatus", () => {
  it("lets the fake text provider review without a vision endpoint", async () => {
    expect(await llm({ TEXT_PROVIDER: "fake" }).visionStatus()).toEqual({ ok: true, reason: "" });
  });

  it("asks for a vision model when none is set", async () => {
    expect(await llm({ TEXT_PROVIDER: "openai" }).visionStatus()).toEqual({
      ok: false,
      reason: "未配置视觉审查模型（设置 → 视觉审查）",
    });
  });

  it("is ok when the endpoint lists its models, and sends the key", async () => {
    status = 200;
    const service = llm({ CRITIQUE_VISION_BASE_URL: `${base}/v1/`, CRITIQUE_VISION_API_KEY: "vk" });
    expect(await service.visionStatus()).toEqual({ ok: true, reason: "" });
    expect(auth).toBe("Bearer vk");
  });

  it.each([
    [401, "视觉审查服务拒绝了密钥（HTTP 401）"],
    [403, "视觉审查服务拒绝了密钥（HTTP 403）"],
    [502, "视觉审查服务出错（HTTP 502）"],
  ])("explains HTTP %i", async (code, reason) => {
    status = code;
    expect(await llm({ CRITIQUE_VISION_BASE_URL: `${base}/v1` }).visionStatus()).toEqual({ ok: false, reason });
  });

  it("explains an endpoint that is not running", async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    const result = await llm({ CRITIQUE_VISION_BASE_URL: `http://127.0.0.1:${port}/v1` }).visionStatus();
    expect(result).toEqual({ ok: false, reason: "视觉审查服务连不上（未启动、已崩溃或内存不足被系统结束）" });
  });

  it("asks the endpoint at most once a minute", async () => {
    status = 200;
    hits = 0;
    const service = llm({ CRITIQUE_VISION_BASE_URL: `${base}/v1` });
    await service.visionStatus();
    status = 500;
    expect(await service.visionStatus()).toEqual({ ok: true, reason: "" });
    expect(hits).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect((await service.visionStatus()).ok).toBe(false);
    expect(hits).toBe(2);
    vi.restoreAllMocks();
  });
});
