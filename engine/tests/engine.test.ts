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

  it("returns 400 when project_id/run_id are missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
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
