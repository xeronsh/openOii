import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { SharedDb } from "../src/shared-db.js";
import { TextLlmService } from "../src/llm.js";
import { PipelineRunner } from "../src/pipeline/runner.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");

/**
 * Targeted redraw is now an engine capability: FastAPI passes entity scope and
 * an intent, the engine decides which stages run (ADR 0008). These tests pin
 * the scoping/skip semantics that replaced the Python `agent_plan` dispatch.
 */
describe("targeted runs", () => {
  let cleanupDir: string;
  let dbFile: string;

  beforeEach(() => {
    process.env.TEXT_PROVIDER = "fake";
    process.env.IMAGE_PROVIDER = "fake";
    process.env.VIDEO_PROVIDER = "fake";
    process.env.TTS_ENABLED = "false";
    process.env.BGM_ENABLED = "false";
    cleanupDir = mkdtempSync(join(tmpdir(), "openoii-targeted-"));
    dbFile = join(cleanupDir, "openoii.db");
    const raw = new SqliteDatabase(dbFile);
    raw.exec(SCHEMA);
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
    raw.close();
  });

  afterEach(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  function boot() {
    process.env.ENGINE_STATIC_DIR = join(cleanupDir, "static");
    const edb = new EngineDatabase(dbFile);
    const shared = new SharedDb(edb.db);
    const runner = new PipelineRunner(edb, shared, new TextLlmService(edb));
    return { edb, shared, runner };
  }

  function seed(edb: EngineDatabase) {
    edb.db
      .prepare(
        `INSERT INTO project (title, story, style, status, story_outline, outline_approved, updated_at, created_at)
         VALUES ('测试项目', '一句话故事', 'anime', 'draft',
                 '{"logline":"","genre":[],"themes":[],"setting":"","tone":"","acts":[],"emotional_arc":""}', 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    const projectId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM project").get() as { id: number | null }).id ?? 0,
    );
    edb.db
      .prepare(
        `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
         VALUES (?, 'queued', 'render', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId);
    const runId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number | null }).id ?? 0,
    );
    edb.db
      .prepare(
        "INSERT INTO character (project_id, name, description, image_url) VALUES (?, '甲', 'A', NULL), (?, '乙', 'B', '/static/images/yi.svg')",
      )
      .run(projectId, projectId);
    edb.db
      .prepare(
        'INSERT INTO shot (project_id, "order", description, image_url, video_url) VALUES (?, 1, \'无图\', NULL, NULL), (?, 2, \'有图\', \'/static/images/s2.svg\', NULL)',
      )
      .run(projectId, projectId);
    return { projectId, runId };
  }

  it("redraws only the requested character and leaves the others untouched", async () => {
    const { edb, shared, runner } = boot();
    const { projectId, runId } = seed(edb);
    const characters = shared.charactersForProject(projectId);
    const target = characters[0]!;
    const untouched = characters[1]!;

    const outcome = await runner.run({
      projectId,
      runId,
      autoMode: true,
      userFeedback: "",
      startStage: "render_characters",
      targetCharacterIds: [target.id],
    });

    expect(outcome.status, outcome.error ?? "targeted run failed").toBe("completed");
    const after = shared.charactersForProject(projectId);
    // The targeted character got a fresh image; the other kept its existing one.
    expect(after.find((c) => c.id === target.id)?.image_url).toContain("/static/images/");
    expect(after.find((c) => c.id === untouched.id)?.image_url).toBe(untouched.image_url);
    edb.close();
  });

  it("skips a target whose output already exists", async () => {
    const { edb, shared, runner } = boot();
    const { projectId, runId } = seed(edb);
    const alreadyDrawn = shared.charactersForProject(projectId)[1]!;
    const before = alreadyDrawn.image_url;

    const outcome = await runner.run({
      projectId,
      runId,
      autoMode: true,
      userFeedback: "",
      startStage: "render_characters",
      targetCharacterIds: [alreadyDrawn.id],
    });

    // Nothing to do: the run completes without rewriting the existing image.
    expect(outcome.status, outcome.error ?? "targeted run failed").toBe("completed");
    expect(shared.charactersForProject(projectId).find((c) => c.id === alreadyDrawn.id)?.image_url).toBe(before);
    edb.close();
  });

  it("renders only the requested shot in a scoped run", async () => {
    const { edb, shared, runner } = boot();
    const { projectId, runId } = seed(edb);
    const shots = shared.shotsForProject(projectId);
    const target = shots[0]!;

    const outcome = await runner.run({
      projectId,
      runId,
      autoMode: true,
      userFeedback: "",
      startStage: "render_shots",
      targetShotIds: [target.id],
    });

    expect(outcome.status, outcome.error ?? "targeted run failed").toBe("completed");
    const after = shared.shotsForProject(projectId);
    const types = edb.eventsForRun(runId).map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
    // Only one shot_updated should exist: the scoped one.
    expect(types.filter((t) => t === "shot_updated")).toHaveLength(1);
    expect(after.find((s) => s.id === target.id)?.image_url).toContain("/static/images/");
    edb.close();
  }, 60000);
});
