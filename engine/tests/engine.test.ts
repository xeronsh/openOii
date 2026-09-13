import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createEngineApp } from "../src/index.js";

describe("engine sidecar", () => {
  let cleanupDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    process.env.TEXT_PROVIDER = "fake";
    cleanupDir = mkdtempSync(join(tmpdir(), "openoii-engine-"));
    const app = createEngineApp(join(cleanupDir, "test.db"));
    server = app.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  it("health reports ok with fake provider", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; provider: string };
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("fake");
  });

  it("runs a smoke agent loop and records events", async () => {
    const start = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: 1, run_id: 1, stage: "smoke" }),
    });
    expect(start.status).toBe(202);

    await new Promise((r) => setTimeout(r, 400));
    const eventsRes = await fetch(`http://127.0.0.1:${port}/runs/1/events`);
    const body = (await eventsRes.json()) as { events: Array<{ type: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain("engine_run_started");
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    expect(types).toContain("engine_run_completed");
  });

  it("cancel stops a running smoke loop", async () => {
    await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: 2, run_id: 2, stage: "smoke" }),
    });
    const cancel = await fetch(`http://127.0.0.1:${port}/runs/2/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const eventsRes = await fetch(`http://127.0.0.1:${port}/runs/2/events`);
    const body = (await eventsRes.json()) as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toContain("engine_run_cancelled");
  });
});

describe("better-sqlite3 native binding", () => {
  it("native module loads and executes SQL", async () => {
    // 回归守卫：better-sqlite3 的 prebuild 在 Node 20 上会 segfault（exit 139），
    // 症状是引擎静默崩溃、无日志。Docker 基础镜像因此固定在 Node 22。
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t (a) VALUES (?)").run(42);
    const row = db.prepare("SELECT a FROM t").get() as { a: number };
    expect(row.a).toBe(42);
    db.close();
  });
});
