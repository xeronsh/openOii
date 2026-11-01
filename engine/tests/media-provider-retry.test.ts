/**
 * Provider-call failure handling in MediaService (regressions from #146, #148,
 * #149, #151): transient errors are retried 5 s / 15 s / 45 s (530 included),
 * other 4xx and timed-out requests are not, a slow provider gets a "still
 * waiting" notice after a minute, a non-JSON body is reported readably, and a
 * provider image that cannot be copied locally fails the step after 3 tries
 * instead of keeping an expiring remote URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaService, type MediaSettings } from "../src/media/media.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

type Reply = { status: number; body: string; type?: string };

let dir: string;
let server: Server;
let base: string;
let posts: number;
let replies: Reply[];
let mediaStatus: number;
let mediaGets: number;
let notices: string[];
let waits: number[];

function json(status: number, body: unknown): Reply {
  return { status, body: JSON.stringify(body) };
}

beforeEach(async () => {
  // Default backoff base (5 s): the waits are recorded, not slept.
  vi.stubEnv("OPENOII_PROVIDER_RETRY_MS", undefined);
  dir = mkdtempSync(join(tmpdir(), "openoii-retry-"));
  posts = 0;
  replies = [];
  mediaStatus = 200;
  mediaGets = 0;
  notices = [];
  waits = [];
  vi.spyOn(MediaService.prototype as unknown as { wait: (ms: number) => Promise<void> }, "wait").mockImplementation(
    async (ms: number) => {
      waits.push(ms);
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/images/generations") {
        const reply = replies[Math.min(posts, replies.length - 1)] ?? json(200, { data: [{ url: `${base}/media/out.png` }] });
        posts += 1;
        res.writeHead(reply.status, { "Content-Type": reply.type ?? "application/json" });
        res.end(reply.body);
      } else if (req.url === "/media/out.png") {
        mediaGets += 1;
        res.writeHead(mediaStatus, { "Content-Type": "image/png" });
        res.end(mediaStatus === 200 ? PNG : "gone");
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function service(): MediaService {
  const media = new MediaService({
    staticDir: dir,
    imageProvider: "openai",
    imageApiKey: "k",
    imageBaseUrl: base,
    imageEndpoint: "/v1/images/generations",
    imageModel: "m",
    enableImageToImage: false,
    fakeImageFixtureUrl: null,
    videoProvider: "fake",
    videoApiKey: "",
    videoBaseUrl: base,
    videoEndpoint: "/v1/videos/generations",
    videoModel: "",
    enableImageToVideo: false,
    videoInlineLocalImages: true,
    publicBaseUrl: null,
    fakeVideoFixtureUrl: null,
  } as MediaSettings);
  media.setMediaRegistrar(() => undefined);
  media.setRetryNotice((message) => {
    notices.push(message);
  });
  return media;
}

describe("provider retries", () => {
  it("retries transient errors after 5 s, 15 s and 45 s and tells the run each time", async () => {
    replies = [json(503, {}), json(502, {}), json(429, {}), json(200, { data: [{ url: `${base}/media/out.png` }] })];
    const url = await service().generateImageUrl({ prompt: "x" });
    expect(url).toMatch(/^\/static\/managed-v1\/[\w-]+\.png$/);
    expect(posts).toBe(4);
    expect(waits).toEqual([5_000, 15_000, 45_000]);
    expect(notices).toEqual([
      "上游暂时不可用（HTTP 503），5 秒后第1次重试（共3次）",
      "上游暂时不可用（HTTP 502），15 秒后第2次重试（共3次）",
      "上游暂时不可用（HTTP 429），45 秒后第3次重试（共3次）",
    ]);
  });

  it("treats Cloudflare 530 (origin unreachable) as transient", async () => {
    replies = [json(530, {}), json(200, { data: [{ url: `${base}/media/out.png` }] })];
    await expect(service().generateImageUrl({ prompt: "x" })).resolves.toMatch(/^\/static\//);
    expect(posts).toBe(2);
  });

  it("gives up after 3 retries with the provider's status", async () => {
    replies = [json(500, {})];
    await expect(service().generateImageUrl({ prompt: "x" })).rejects.toThrow("image provider failed: 500");
    expect(posts).toBe(4);
  });

  it.each([400, 401, 404])("does not retry HTTP %i", async (status) => {
    replies = [json(status, { error: "no" })];
    await expect(service().generateImageUrl({ prompt: "x" })).rejects.toThrow(`image provider failed: ${status}`);
    expect(posts).toBe(1);
    expect(waits).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("does not retry a request that timed out waiting for headers", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(service().generateImageUrl({ prompt: "x" })).rejects.toThrow(
      "media provider request timed out (no response)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("retries a refused connection and labels it 连接失败", async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      return realFetch(input, init);
    });
    await expect(service().generateImageUrl({ prompt: "x" })).resolves.toMatch(/^\/static\//);
    expect(notices[0]).toBe("上游暂时不可用（连接失败），5 秒后第1次重试（共3次）");
  });

  it("says it is still waiting when a provider is silent for a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (answer = resolve)));
    const pending = service().generateImageUrl({ prompt: "x" });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toEqual(["上游 1 分钟还没返回，继续等待（最长约 5 分钟）"]);
    answer(new Response("{}", { status: 400 }));
    expect(String(await outcome)).toContain("image provider failed: 400");
    // The notice timer belongs to that attempt only.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(notices).toHaveLength(1);
  });
});

describe("provider bodies", () => {
  it("reports a non-JSON body readably instead of a JSON.parse error", async () => {
    replies = [{ status: 200, body: "<html>Bad gateway</html>", type: "text/html" }];
    await expect(service().generateImageUrl({ prompt: "x" })).rejects.toThrow(
      "image provider returned invalid JSON (HTTP 200)",
    );
  });

  it("fails the step after 3 local-copy attempts instead of keeping the remote URL", async () => {
    mediaStatus = 500;
    await expect(service().generateImageUrl({ prompt: "x" })).rejects.toThrow(
      /^生成的图片没能存到本地（已重试 3 次：.*这一步算失败，点继续会重新生成$/,
    );
    expect(mediaGets).toBeGreaterThanOrEqual(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("keeps the copy when a later attempt succeeds", async () => {
    let gets = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/media/out.png") && gets++ === 0) throw new TypeError("fetch failed");
      return realFetch(input, init);
    });
    await expect(service().generateImageUrl({ prompt: "x" })).resolves.toMatch(/^\/static\/managed-v1\//);
    expect(waits).toEqual([1_000]);
  });
});
