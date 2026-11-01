/**
 * PipelineRunner outcomes outside the happy path, on the fake providers:
 * how a failed provider call is classified for the UI, what a targeted run
 * does when its targets are done or gone, and how resume finishes a run whose
 * stages are all checkpointed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { ConcurrentModificationError, SharedDb } from "../src/shared-db.js";
import { TextLlmService } from "../src/llm.js";
import { PipelineRunner } from "../src/pipeline/runner.js";
import { MediaService } from "../src/media/media.js";
import { AiOperationError } from "../src/ai-operation.js";
import { STAGE_ORDER } from "../src/contract.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns, leaseRun } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");

let dir: string;
let dbFile: string;

beforeEach(() => {
  vi.stubEnv("TEXT_PROVIDER", "fake");
  vi.stubEnv("IMAGE_PROVIDER", "fake");
  vi.stubEnv("VIDEO_PROVIDER", "fake");
  vi.stubEnv("TTS_ENABLED", "false");
  vi.stubEnv("BGM_ENABLED", "false");
  vi.stubEnv("CRITIQUE_ENABLED", "false");
  dir = mkdtempSync(join(tmpdir(), "openoii-runner-"));
  vi.stubEnv("ENGINE_STATIC_DIR", join(dir, "static"));
  dbFile = join(dir, "openoii.db");
  const raw = new SqliteDatabase(dbFile);
  raw.exec(SCHEMA);
  installExecutionLeaseColumns(raw);
  installEngineRuntimeSchema(raw);
  raw.close();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const edb = new EngineDatabase(dbFile);
  const shared = new SharedDb(edb.db);
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  edb.db
    .prepare(
      `INSERT INTO project (title, story, style, status, story_outline, outline_approved, updated_at, created_at)
       VALUES ('测试项目', '一句话故事', 'anime', 'ready',
               '{"logline":"","genre":[],"themes":[],"setting":"","tone":"","acts":[],"emotional_arc":""}', 0, ${now}, ${now})`,
    )
    .run();
  const projectId = Number((edb.db.prepare("SELECT MAX(id) AS id FROM project").get() as { id: number }).id);
  edb.db
    .prepare(
      `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
       VALUES (?, 'queued', 'render', 0, 0, ${now}, ${now})`,
    )
    .run(projectId);
  const runId = Number((edb.db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number }).id);
  edb.db
    .prepare(
      `INSERT INTO shot (project_id, "order", description, character_ids, image_url, video_url)
       VALUES (?, 1, '乌鸦看见水瓶', '[]', '/static/images/done.png', NULL), (?, 2, '乌鸦衔石子', '[]', NULL, NULL)`,
    )
    .run(projectId, projectId);
  const shots = shared.shotsForProject(projectId);
  const fenced = leaseRun(shared, runId);
  const runner = new PipelineRunner(edb, fenced, new TextLlmService(edb));
  const events = (type: string) =>
    edb
      .eventsForRun(runId)
      .filter((event) => event.type === type)
      .map((event) => JSON.parse(String(event.payload)) as Record<string, unknown>);
  const run = () => edb.db.prepare("SELECT status, error FROM agentrun WHERE id = ?").get(runId) as { status: string; error: string | null };
  const project = () => shared.getProject(projectId)!;
  return { edb, shared, projectId, runId, shots, runner, events, run, project };
}

const timeoutError = () => {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
};

describe("a failed provider call is classified for the UI", () => {
  it.each([
    ["timeout", () => new AiOperationError("timeout", "op", "deadline passed"), "PROVIDER_TIMEOUT", true],
    ["abort", () => new AiOperationError("aborted", "op", "aborted"), "OPERATION_ABORTED", true],
    ["bad reply", () => new AiOperationError("invalid_response", "op", "no image"), "INVALID_PROVIDER_RESPONSE", false],
    ["provider", () => new AiOperationError("provider", "op", "HTTP 400"), "PROVIDER_ERROR", false],
    ["fetch timeout", timeoutError, "PROVIDER_TIMEOUT", true],
    ["concurrent edit", () => new ConcurrentModificationError("shot", 1, 1), "CONCURRENT_MODIFICATION", false],
    ["anything else", () => new Error("boom"), "GENERATION_FAILED", false],
  ])("%s", async (_label, makeError, code, retryable) => {
    vi.spyOn(MediaService.prototype, "generateImageUrl").mockRejectedValue(makeError());
    const { edb, shots, runner, runId, projectId, events, run, project } = boot();

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "", targetShotIds: [shots[1]!.id] });

    expect(outcome.status).toBe("failed");
    expect(run().status).toBe("failed");
    expect(events("run_failed")[0]).toMatchObject({ error_code: code, retryable });
    // A failed redraw of one shot does not fail the whole project.
    expect(project().status).toBe("ready");
    const attempt = edb.db.prepare("SELECT status FROM engine_stage_attempts WHERE run_id = ?").get(runId) as { status: string };
    expect(attempt.status).toBe("failed");
    expect(edb.eventsForRun(runId).some((event) => String(event.payload).includes("失败 · "))).toBe(true);
    edb.close();
  }, 60_000);
});

describe("targeted runs whose targets need nothing", () => {
  it("completes without running a stage when the shot already has its keyframe", async () => {
    const draw = vi.spyOn(MediaService.prototype, "generateImageUrl");
    const { edb, shots, runner, runId, projectId, events, run } = boot();

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "", targetShotIds: [shots[0]!.id] });

    expect(outcome.status).toBe("completed");
    expect(run().status).toBe("succeeded");
    expect(events("run_completed")[0]).toMatchObject({ current_stage: null });
    expect(draw).not.toHaveBeenCalled();
    edb.close();
  });

  it("fails with TARGET_NOT_FOUND when the shot was deleted", async () => {
    const { edb, runner, runId, projectId, events, run } = boot();

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "", targetShotIds: [9999] });

    expect(outcome).toEqual({ status: "failed", error: `target IDs no longer exist in project ${projectId}: 9999` });
    expect(run().status).toBe("failed");
    expect(events("run_failed")[0]).toMatchObject({ error_code: "TARGET_NOT_FOUND", retryable: false });
    edb.close();
  });

  it("ends cancelled when the stop came first", async () => {
    const { edb, shared, shots, runner, runId, projectId, events, run } = boot();
    shared.requestRunCancel(runId);

    const outcome = await runner.run({ projectId, runId, autoMode: true, userFeedback: "", targetShotIds: [shots[0]!.id] });

    expect(outcome.status).toBe("cancelled");
    expect(run().status).toBe("cancelled");
    expect(events("run_cancelled")).toHaveLength(1);
    edb.close();
  });
});

describe("resume of a run with every stage checkpointed", () => {
  function checkpointAll(edb: EngineDatabase, runId: number) {
    for (const stage of STAGE_ORDER) edb.saveCheckpoint(runId, stage, { completed_at: "2026-11-01T00:00:00Z" });
  }

  it("marks the run succeeded and the project ready when the film exists", async () => {
    const { edb, shared, runner, runId, projectId, events, run, project } = boot();
    shared.updateProject(projectId, { video_url: "/static/videos/final.mp4", status: "generating" });
    checkpointAll(edb, runId);

    const outcome = await runner.resume({ projectId, runId, autoMode: true, userFeedback: "" });

    expect(outcome.status).toBe("completed");
    expect(run().status).toBe("succeeded");
    expect(project().status).toBe("ready");
    expect(events("run_completed")[0]).toMatchObject({ current_stage: STAGE_ORDER.at(-1) });
    edb.close();
  });

  it("records the cancel instead when the run was stopped meanwhile", async () => {
    const { edb, shared, runner, runId, projectId, events, run } = boot();
    shared.updateProject(projectId, { video_url: "/static/videos/final.mp4" });
    checkpointAll(edb, runId);
    shared.requestRunCancel(runId);

    const outcome = await runner.resume({ projectId, runId, autoMode: true, userFeedback: "" });

    expect(outcome.status).toBe("cancelled");
    expect(run().status).toBe("cancelled");
    expect(events("run_cancelled")).toHaveLength(1);
    expect(events("run_completed")).toHaveLength(0);
    edb.close();
  });
});
