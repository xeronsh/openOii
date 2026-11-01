import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendWorker } from "../src/backend-worker.js";

/**
 * The worker speaks one JSON line per request to `python -m app.services.engine_media_cli`.
 * ENGINE_PYTHON points at a small node script that plays the backend side of that
 * protocol, so these tests cover the real child-process plumbing without Python.
 */
const FAKE_CLI = `#!/usr/bin/env node
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  switch (req.action) {
    case "whoami":
      return send({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() });
    case "face_embedding": {
      const kind = Buffer.from(req.image, "base64").toString();
      if (kind === "short") return send([1, 2, 3]);
      if (kind === "text") return send(Array.from({ length: 512 }, (_, i) => (i ? 0.5 : "x")));
      return send(Array.from({ length: 512 }, (_, i) => i / 512));
    }
    case "character_reference":
      return send(Buffer.from("ref:" + req.urls.join(",")).toString("base64"));
    case "nine_grid_reference":
      if (req.current === "bad") return send({ grid: 1 });
      return send(Buffer.from(JSON.stringify(req)).toString("base64"));
    case "process_audio":
      if (req.video_url === "full") return send({ video_url: "/v/full.mp4", tts_url: "/a/t.mp3", bgm_type: "calm", tts_error: null });
      if (req.video_url === "partial") return send({ video_url: "/v/p.mp4", tts_url: 7, tts_error: "voice quota" });
      if (req.video_url === "novideo") return send({ tts_url: "/a/t.mp3" });
      if (req.video_url === "scalar") return send(5);
      return send({ error: "tts provider down" });
    case "bgm_track":
      if (req.genre === "scalar") return send("nope");
      if (req.genre === "cloud") return send({ track_url: "/bgm/x.mp3", source: "suno", mood: "epic", fallback_reason: null });
      return send({ track_url: null, source: 3, fallback_reason: "minimax 401" });
    case "crash":
      process.stderr.write("Traceback: worker exploded");
      return process.exit(3);
    case "hang":
      return;
  }
});
`;

describe("BackendWorker protocol", () => {
  let dir: string;
  let saved: { python?: string; backend?: string };
  const workers: BackendWorker[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-worker-"));
    const cli = join(dir, "fake-python");
    writeFileSync(cli, FAKE_CLI);
    chmodSync(cli, 0o755);
    saved = { python: process.env.ENGINE_PYTHON, backend: process.env.ENGINE_BACKEND_DIR };
    process.env.ENGINE_PYTHON = cli;
    process.env.ENGINE_BACKEND_DIR = dir;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    if (saved.python === undefined) delete process.env.ENGINE_PYTHON;
    else process.env.ENGINE_PYTHON = saved.python;
    if (saved.backend === undefined) delete process.env.ENGINE_BACKEND_DIR;
    else process.env.ENGINE_BACKEND_DIR = saved.backend;
    rmSync(dir, { recursive: true, force: true });
  });

  function worker(signal = new AbortController().signal): BackendWorker {
    const created = new BackendWorker(signal);
    workers.push(created);
    return created;
  }

  // Private request() is the protocol entry; reach it for protocol-only actions.
  const raw = (w: BackendWorker, request: Record<string, unknown>) =>
    (w as unknown as { request(r: Record<string, unknown>): Promise<unknown> }).request(request);

  it("spawns the backend media CLI module in the backend dir and reuses one child for later requests", async () => {
    const w = worker();
    const first = (await raw(w, { action: "whoami" })) as { pid: number; argv: string[]; cwd: string };
    const second = (await raw(w, { action: "whoami" })) as { pid: number };
    expect(first.argv).toEqual(["-m", "app.services.engine_media_cli"]);
    expect(first.cwd).toBe(dir);
    expect(second.pid).toBe(first.pid);
  });

  it("accepts only a finite 512-number face embedding", async () => {
    const w = worker();
    const ok = await w.faceEmbedding(Buffer.from("face"));
    expect(ok).toHaveLength(512);
    expect(ok?.[256]).toBe(0.5);
    expect(await w.faceEmbedding(Buffer.from("short"))).toBeNull();
    expect(await w.faceEmbedding(Buffer.from("text"))).toBeNull();
  });

  it("decodes composed reference images and rejects a non-image answer", async () => {
    const w = worker();
    expect((await w.characterReference(["/a.png", "/b.png"])).toString()).toBe("ref:/a.png,/b.png");
    const grid = JSON.parse(
      (await w.nineGridReference({ current: "/s2.png", previous: "/s1.png", next: null, characters: ["/c.png"] })).toString(),
    ) as Record<string, unknown>;
    expect(grid).toEqual({
      action: "nine_grid_reference",
      current: "/s2.png",
      previous: "/s1.png",
      next: null,
      characters: ["/c.png"],
    });
    await expect(w.nineGridReference({ current: "bad", characters: [] })).rejects.toThrow(
      "invalid image composition result",
    );
  });

  const audioArgs = (video_url: string) => ({
    video_url,
    dialogue: "你好",
    speaker: { name: "甲", description: null },
    voice: null,
    scene: null,
    expression: null,
    genre: null,
    settings: {
      text_provider: "fake",
      image_provider: "fake",
      video_provider: "fake",
      tts_enabled: true,
      tts_provider: "fake",
      tts_base_url: null,
      tts_api_key: null,
      tts_model: null,
      tts_default_voice: "v",
      tts_volume: 1,
      bgm_enabled: false,
      bgm_volume: 0.3,
      bgm_directory: "bgm",
    },
  });

  it("normalises audio results and surfaces the TTS failure reason", async () => {
    const w = worker();
    expect(await w.processAudio(audioArgs("full"))).toEqual({
      video_url: "/v/full.mp4",
      tts_url: "/a/t.mp3",
      bgm_type: "calm",
      tts_error: null,
    });
    expect(await w.processAudio(audioArgs("partial"))).toEqual({
      video_url: "/v/p.mp4",
      tts_url: null,
      bgm_type: null,
      tts_error: "voice quota",
    });
    await expect(w.processAudio(audioArgs("novideo"))).rejects.toThrow("audio result has no video URL");
    await expect(w.processAudio(audioArgs("scalar"))).rejects.toThrow("invalid audio result");
    // A backend {error} answer is a rejected request, and the child stays usable afterwards.
    await expect(w.processAudio(audioArgs("boom"))).rejects.toThrow("tts provider down");
    expect((await w.processAudio(audioArgs("full"))).video_url).toBe("/v/full.mp4");
  });

  it("normalises the film BGM track including the local-library fallback reason", async () => {
    const w = worker();
    const settings = { bgm_provider: "suno", bgm_base_url: null, bgm_api_key: null, bgm_model: null, bgm_directory: "bgm" };
    expect(await w.bgmTrack({ texts: ["a"], genre: "cloud", duration: 12, settings })).toEqual({
      track_url: "/bgm/x.mp3",
      source: "suno",
      mood: "epic",
      fallback_reason: null,
    });
    expect(await w.bgmTrack({ texts: [], genre: null, duration: 5, settings })).toEqual({
      track_url: null,
      source: null,
      mood: null,
      fallback_reason: "minimax 401",
    });
    await expect(w.bgmTrack({ texts: [], genre: "scalar", duration: 5, settings })).rejects.toThrow(
      "invalid bgm result",
    );
  });

  it("rejects the in-flight request with the exit code and stderr tail, then respawns", async () => {
    const w = worker();
    const before = (await raw(w, { action: "whoami" })) as { pid: number };
    await expect(raw(w, { action: "crash" })).rejects.toThrow(
      "backend worker exited 3: Traceback: worker exploded",
    );
    const after = (await raw(w, { action: "whoami" })) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
  });

  it("rejects when the interpreter cannot be started", async () => {
    process.env.ENGINE_PYTHON = join(dir, "missing-python");
    const w = worker();
    await expect(raw(w, { action: "whoami" })).rejects.toThrow(/ENOENT/);
  });

  it("cancel aborts a hanging request and kills the child process group", async () => {
    const controller = new AbortController();
    const w = worker(controller.signal);
    const { pid } = (await raw(w, { action: "whoami" })) as { pid: number };
    const hanging = raw(w, { action: "hang" });
    controller.abort();
    await expect(hanging).rejects.toThrow("backend worker cancelled");
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return "alive";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
    // A cancelled run never starts a new child.
    await expect(raw(w, { action: "whoami" })).rejects.toThrow("backend worker cancelled");
  });

  it("does not spawn for an already-cancelled run and close() is a no-op without a child", async () => {
    const controller = new AbortController();
    controller.abort();
    const w = worker(controller.signal);
    await expect(w.close()).resolves.toBeUndefined();
    await expect(w.characterReference(["/a.png"])).rejects.toThrow("backend worker cancelled");
  });

  it("close() ends stdin and waits for the child to exit", async () => {
    const w = worker();
    const { pid } = (await raw(w, { action: "whoami" })) as { pid: number };
    await w.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
