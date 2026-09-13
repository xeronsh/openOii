/**
 * Phase 4 integration: full fake-provider pipeline over the real app schema.
 * Gates are confirmed by flipping agentrun.confirm_requested (the same
 * cross-process signal the Python WS handler sets).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { SharedDb } from "../src/shared-db.js";
import { TextLlmService } from "../src/llm.js";
import { PipelineRunner } from "../src/pipeline/runner.js";

const SCHEMA = readFileSync(
  resolve(import.meta.dirname, "fixtures/app-schema.sql"),
  "utf8",
);

describe("pipeline runner (fake providers, auto-mode)", () => {
  let cleanupDir: string;
  let dbFile: string;

  beforeEach(() => {
    process.env.TEXT_PROVIDER = "fake";
    process.env.IMAGE_PROVIDER = "fake";
    process.env.VIDEO_PROVIDER = "fake";
    process.env.TTS_ENABLED = "false";
    process.env.BGM_ENABLED = "false";
    cleanupDir = mkdtempSync(join(tmpdir(), "openoii-pipeline-"));
    dbFile = join(cleanupDir, "openoii.db");
    const raw = new SqliteDatabase(dbFile);
    raw.exec(SCHEMA);
    raw.close();
  });

  afterEach(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  function boot(): { runner: PipelineRunner; shared: SharedDb; edb: EngineDatabase } {
    const edb = new EngineDatabase(dbFile);
    const shared = new SharedDb(edb.db);
    const llm = new TextLlmService(edb);
    process.env.ENGINE_STATIC_DIR = join(cleanupDir, "static");
    const runner = new PipelineRunner(edb, shared, llm);
    return { runner, shared, edb };
  }

  function seedProject(edb: EngineDatabase): number {
    edb.db
      .prepare(
        `INSERT INTO project (title, story, style, status, story_outline, outline_approved, updated_at, created_at)
         VALUES ('测试项目', '主角在废弃灯塔中发现会说话的猫。', 'anime', 'draft',
                 '{"logline":"","genre":[],"themes":[],"setting":"","tone":"","acts":[],"emotional_arc":""}', 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    return Number(edb.db.prepare("SELECT MAX(id) AS id FROM project").get()!.id ?? 0) as number;
  }

  it("completes all stages, persists domain rows, emits contract events", async () => {
    const { runner, shared, edb } = boot();
    const projectId = seedProject(edb);
    edb.db
      .prepare(
        `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
         VALUES (?, 'queued', 'outline', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId);
    const runId = Number(edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get()!.id ?? 0) as number;

    // confirm gates asynchronously (auto-advance)
    const confirmer = setInterval(() => {
      shared.updateRun(runId, { confirm_requested: 1 });
    }, 100);

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "" });
    clearInterval(confirmer);

    expect(outcome.status).toBe("completed");

    const project = shared.getProject(projectId);
    expect(project?.status).toBe("ready");
    expect(project?.video_url ?? "").toContain("/static/videos/");
    expect((project?.story_outline ?? "").length).toBeGreaterThan(2);

    const characters = shared.charactersForProject(projectId);
    expect(characters.length).toBeGreaterThan(0);
    for (const c of characters) {
      expect(c.image_url).toContain("/static/images/");
    }

    const shots = shared.shotsForProject(projectId);
    expect(shots.length).toBeGreaterThan(0);
    for (const s of shots) {
      expect(s.image_url).toContain("/static/images/");
      expect(s.video_url).toContain("/static/videos/");
    }

    // contract event coverage on engine_run_events
    const types = edb.eventsForRun(runId).map((e) => e.type);
    for (const expected of [
      "run_started",
      "data_cleared",
      "run_message",
      "agent_thinking",
      "run_progress",
      "character_created",
      "shot_created",
      "version_created",
      "character_updated",
      "shot_updated",
      "project_updated",
      "run_awaiting_confirm",
      "run_confirmed",
      "run_completed",
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }

    // message rows persisted for chat replay
    const messageCount = Number(
      edb.db.prepare("SELECT COUNT(*) AS n FROM message WHERE run_id = ?").get(runId)!.n,
    );
    expect(messageCount).toBeGreaterThan(0);
  }, 60000);

  it("gate pause/resume: stops at awaiting, continues after confirm signal", async () => {
    const { runner, shared, edb } = boot();
    const projectId = seedProject(edb);
    edb.db
      .prepare(
        `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
         VALUES (?, 'queued', 'outline', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId);
    const runId = Number(edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get()!.id ?? 0) as number;

    const running = runner.run({ projectId, runId, autoMode: false, userFeedback: "" });

    // wait until the outline gate awaits, then keep consuming the confirm
    // signal (the runner clears it once per gate before waiting)
    let sawAwaiting = false;
    const confirmer = setInterval(() => {
      if (!sawAwaiting) {
        sawAwaiting = edb.eventsForRun(runId).some((e) => e.type === "run_awaiting_confirm");
        return;
      }
      shared.updateRun(runId, { confirm_requested: 1 });
    }, 100);
    try {
      const outcome = await running;
      expect(sawAwaiting).toBe(true);
      expect(outcome.status).toBe("completed");
    } finally {
      clearInterval(confirmer);
    }
  }, 60000);
});
