/**
 * Render-stage regressions from #145–#147, run as targeted redraws on the fake
 * providers:
 * - keyframes chain from the live previous shot, so a keyframe drawn earlier
 *   in the same loop is the one carried on (getLiveShot, #145);
 * - a skipped character sheet or previous keyframe is posted to the run feed
 *   in Chinese, without the raw error (#146, #149);
 * - a targeted redraw is reviewed by the critic, only for the shots it drew (#147).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { SharedDb } from "../src/shared-db.js";
import { TextLlmService } from "../src/llm.js";
import { PipelineRunner } from "../src/pipeline/runner.js";
import { MediaService } from "../src/media/media.js";
import { BackendWorker } from "../src/backend-worker.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns, leaseRun } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let dir: string;
let dbFile: string;

beforeEach(() => {
  vi.stubEnv("TEXT_PROVIDER", "fake");
  vi.stubEnv("IMAGE_PROVIDER", "fake");
  vi.stubEnv("VIDEO_PROVIDER", "fake");
  vi.stubEnv("TTS_ENABLED", "false");
  vi.stubEnv("BGM_ENABLED", "false");
  vi.stubEnv("ENABLE_IMAGE_TO_IMAGE", "true");
  dir = mkdtempSync(join(tmpdir(), "openoii-render-"));
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

function boot(characterImage: string | null = null) {
  const edb = new EngineDatabase(dbFile);
  const shared = new SharedDb(edb.db);
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  edb.db
    .prepare(
      `INSERT INTO project (title, story, style, status, story_outline, outline_approved, updated_at, created_at)
       VALUES ('测试项目', '一句话故事', 'anime', 'draft',
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
  edb.db.prepare("INSERT INTO character (project_id, name, description, image_url) VALUES (?, '乌鸦', '黑色乌鸦', ?)").run(projectId, characterImage);
  const characterId = Number((edb.db.prepare("SELECT MAX(id) AS id FROM character").get() as { id: number }).id);
  edb.db
    .prepare(
      `INSERT INTO shot (project_id, "order", description, character_ids, image_url, video_url)
       VALUES (?, 1, '乌鸦看见水瓶', ?, NULL, NULL), (?, 2, '乌鸦衔石子', ?, NULL, NULL)`,
    )
    .run(projectId, `[${characterId}]`, projectId, `[${characterId}]`);
  const shots = shared.shotsForProject(projectId);
  const run = (targetShotIds: number[]) =>
    new PipelineRunner(edb, leaseRun(shared, runId), new TextLlmService(edb)).run({
      projectId,
      runId,
      autoMode: true,
      userFeedback: "",
      startStage: "render_shots",
      targetShotIds,
    });
  const messages = () =>
    edb
      .eventsForRun(runId)
      .map((event) => String(event.payload))
      .filter((payload) => payload.includes("⚠️"));
  return { edb, shared, projectId, runId, shots, run, messages };
}

describe("keyframe chaining", () => {
  it("draws shot 2 from the keyframe shot 1 got earlier in the same run", async () => {
    // No critic pass: a redraw round would start from a fresh snapshot that already has the keyframe.
    vi.stubEnv("CRITIQUE_ENABLED", "false");
    const read = vi.spyOn(MediaService.prototype, "readImageBytes").mockResolvedValue(PNG);
    const { edb, shared, shots, run } = boot();
    const outcome = await run(shots.map((shot) => shot.id));
    expect(outcome.status, outcome.error ?? "").toBe("completed");
    const first = shared.getLiveShot(shots[0]!.id)!;
    expect(first.image_url).toContain("/static/managed-v1/");
    // Shot 1 had no image when the stage started: only the live row has it.
    expect(read.mock.calls.map(([url]) => url)).toContain(first.image_url);
    edb.close();
  }, 60_000);
});

describe("skipped references are visible in the run feed", () => {
  it("says the character sheet was skipped, in Chinese and without the raw error", async () => {
    vi.spyOn(BackendWorker.prototype, "characterReference").mockRejectedValue(new Error("Traceback: onnx exploded"));
    const { edb, shots, run, messages } = boot("/static/images/crow.png");
    const outcome = await run([shots[0]!.id]);
    expect(outcome.status, outcome.error ?? "").toBe("completed");
    const warning = messages().find((text) => text.includes("没拿到角色设定图"));
    expect(warning).toBeDefined();
    expect(warning).toContain("这一镜只按文字描述画角色");
    expect(warning).not.toContain("onnx exploded");
    edb.close();
  }, 60_000);

  it("says the previous keyframe could not be read", async () => {
    vi.spyOn(MediaService.prototype, "readImageBytes").mockRejectedValue(new Error("ENOENT"));
    const { edb, shared, shots, run, messages } = boot();
    shared.updateShot(shots[0]!.id, { image_url: "/static/images/missing.png" });
    const outcome = await run([shots[1]!.id]);
    expect(outcome.status, outcome.error ?? "").toBe("completed");
    expect(messages().some((text) => text.includes("读不到上一镜画面"))).toBe(true);
    edb.close();
  }, 60_000);
});

describe("targeted redraws are critiqued", () => {
  it("reviews the redrawn shot after render, and only that shot", async () => {
    const { edb, shots, runId, run } = boot();
    const outcome = await run([shots[1]!.id]);
    expect(outcome.status, outcome.error ?? "").toBe("completed");
    const stages = (
      edb.db.prepare("SELECT stage FROM engine_stage_attempts WHERE run_id = ? ORDER BY id").all(runId) as Array<{ stage: string }>
    ).map((row) => row.stage);
    expect(stages).toEqual(["render_shots", "critique_shot_images"]);
    const reviewed = edb
      .eventsForRun(runId)
      .filter((event) => event.type === "shot_updated")
      .map((event) => (JSON.parse(String(event.payload)) as { shot: { id: number } }).shot.id);
    expect(new Set(reviewed)).toEqual(new Set([shots[1]!.id]));
    edb.close();
  }, 60_000);
});
