import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import SqliteDatabase from "better-sqlite3";
import { createEngineApp } from "../src/index.js";
import type { PipelineRunner } from "../src/pipeline/runner.js";
import { installEngineRuntimeSchema } from "./test-db.js";

describe("engine sidecar", () => {
  let cleanupDir: string;
  let server: Server;
  let port: number;
  let app: ReturnType<typeof createEngineApp>;

  beforeEach(async () => {
    process.env.TEXT_PROVIDER = "fake";
    cleanupDir = mkdtempSync(join(tmpdir(), "openoii-engine-"));
    const dbFile = join(cleanupDir, "test.db");
    const migrated = new SqliteDatabase(dbFile);
    installEngineRuntimeSchema(migrated);
    migrated.close();
    app = createEngineApp(dbFile);
    server = app.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.db.close();
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  it("health reports ok with fake provider and workflow version", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      provider: string;
      workflow_version: number;
    };
    expect(body.status).toBe("ok");
    expect(body.provider).toBe("fake");
    expect(body.workflow_version).toBe(1);
  });

  it("returns 400 when project_id/run_id are missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a second executor for the same run id", async () => {
    // Seed the active-execution registry directly so this test isolates the
    // HTTP duplicate guard from project fixtures/provider timing.
    app.pipelines.set(77, {} as PipelineRunner);
    const res = await fetch(`http://127.0.0.1:${port}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: 1, run_id: 77 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { run_id: number } };
    };
    expect(body.error.code).toBe("RUN_ALREADY_ACTIVE");
    expect(body.error.details.run_id).toBe(77);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("schema ownership", () => {
  it("fails fast when Alembic runtime tables are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openoii-unmigrated-"));
    try {
      expect(() => createEngineApp(join(dir, "empty.db"))).toThrow(
        /engine database schema is not migrated/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("pipeline prompts", () => {
  it("every prompt is non-empty text", async () => {
    // 回归守卫：曾因引用不存在的 key（critic.SYSTEM_PROMPT）导致 critic 阶段
    // 拿到空 system prompt，而 `?? ""` 把错误吞掉。类型层已能拦住拼错的 key，
    // 这个测试再兜住“key 对但内容是空串”的情况。
    const { PROMPTS } = await import("../src/prompts.js");
    for (const [key, value] of Object.entries(PROMPTS)) {
      expect(value.length, `${key} 不应为空`).toBeGreaterThan(50);
    }
  });
});
