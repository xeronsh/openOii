import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { SharedDb } from "../src/shared-db.js";
import { TextLlmService } from "../src/llm.js";
import { PipelineRunner } from "../src/pipeline/runner.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

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
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
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
    return Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM project").get() as { id: number | null }).id ?? 0,
    );
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
    const runId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number | null }).id ?? 0,
    );

    const confirmer = setInterval(() => {
      shared.updateRun(runId, { confirm_requested: 1 });
    }, 100);

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "" });
    clearInterval(confirmer);

    expect(outcome.status, outcome.error ?? "pipeline failed without an error message").toBe("completed");

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

    const messageCount = Number(
      (edb.db.prepare("SELECT COUNT(*) AS n FROM message WHERE run_id = ?").get(runId) as {
        n: number;
      }).n,
    );
    expect(messageCount).toBeGreaterThan(0);
    edb.close();
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
    const runId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number | null }).id ?? 0,
    );

    const running = runner.run({ projectId, runId, autoMode: false, userFeedback: "" });

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
      expect(sawAwaiting, outcome.error ?? "pipeline exited before the first approval gate").toBe(true);
      expect(outcome.status, outcome.error ?? "pipeline failed without an error message").toBe("completed");
    } finally {
      clearInterval(confirmer);
      edb.close();
    }
  }, 60000);

  it("resume reuses interrupted stage attempt instead of re-calling the provider", async () => {
    const { runner, shared, edb } = boot();
    const projectId = seedProject(edb);
    edb.db
      .prepare(
        `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
         VALUES (?, 'queued', 'outline', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId);
    const runId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number | null }).id ?? 0,
    );

    const confirmer = setInterval(() => {
      shared.updateRun(runId, { confirm_requested: 1 });
    }, 100);
    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "" });
    clearInterval(confirmer);
    expect(outcome.status, outcome.error ?? "pipeline failed").toBe("completed");

    // Replay the last production stage the way a crash-after-side-effect would:
    // the stage left no checkpoint, but it already mutated shot rows. Resume
    // must adopt the persisted operation identity rather than mint a new one.
    const attempts = edb.db
      .prepare(
        `SELECT * FROM engine_stage_attempts WHERE run_id = ? AND stage = 'render_shots'
         ORDER BY attempt DESC LIMIT 1`,
      )
      .all(runId) as Array<{
      stage_attempt_id: string;
      idempotency_key: string;
      attempt: number;
      input_hash: string;
    }>;
    expect(attempts.length).toBe(1);
    const original = attempts[0]!;

    // Simulate the crash window: identity was persisted, work done, but the
    // process died before the attempt reached a terminal status.
    edb.db
      .prepare("UPDATE engine_stage_attempts SET status = 'started' WHERE stage_attempt_id = ?")
      .run(original.stage_attempt_id);

    const resumed = edb.beginStageAttempt({
      runId,
      stage: "render_shots",
      // The live rows are now mutated, so a recomputed input would differ.
      input: { shots: shared.shotsForProject(projectId) },
      executionAttempt: 2,
    });

    expect(resumed.stage_attempt_id).toBe(original.stage_attempt_id);
    expect(resumed.idempotency_key).toBe(original.idempotency_key);
    expect(resumed.input_hash).toBe(original.input_hash);
    expect(resumed.attempt).toBe(original.attempt);

    const attemptCount = Number(
      (
        edb.db
          .prepare(
            "SELECT COUNT(*) AS n FROM engine_stage_attempts WHERE run_id = ? AND stage = 'render_shots'",
          )
          .get(runId) as { n: number }
      ).n,
    );
    expect(attemptCount).toBe(1);
    edb.close();
  }, 60000);

  it("durable lease rejects a second owner and fences stale writers", () => {
    const { shared, edb } = boot();
    const projectId = seedProject(edb);
    edb.db
      .prepare(
        `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
         VALUES (?, 'queued', 'outline', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId);
    const runId = Number(
      (edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number | null }).id ?? 0,
    );

    expect(shared.acquireRunLease(runId, "owner-a", "token-a", 120)).toBe(true);
    expect(shared.acquireRunLease(runId, "owner-b", "token-b", 120)).toBe(false);

    const stale = shared.fenced(runId, "token-a");
    stale.updateRun(runId, { status: "running" });
    expect(shared.releaseRunLease(runId, "owner-a", "token-a")).toBe(true);
    expect(() => stale.updateRun(runId, { status: "failed" })).toThrow(/execution lease lost/);

    expect(shared.acquireRunLease(runId, "owner-b", "token-b", 120)).toBe(true);
    const current = shared.fenced(runId, "token-b");
    current.updateRun(runId, { status: "running" });
    expect(shared.getRun(runId)?.status).toBe("running");
    edb.close();
  });
});
