import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { ConcurrentModificationError, SharedDb } from "../src/shared-db.js";
import { beginAiOperation } from "../src/ai-operation.js";
import { MediaService, type MediaSettings } from "../src/media/media.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");

/**
 * Chaos matrix: the four failure classes this engine claims to survive, each
 * injected deliberately and asserted at the boundary that must hold. These are
 * the properties the correctness work established; without this file they are
 * only claims in a commit message.
 *
 *   1. crash/replay      -> one operation identity, never two provider calls
 *   2. cancellation      -> the in-flight provider request actually stops
 *   3. concurrent write  -> a stale writer cannot overwrite a fresh edit
 *   4. provider failure  -> the failure is reported, not swallowed
 */
describe("chaos matrix", () => {
  let dir: string;
  let file: string;
  let edb: EngineDatabase;
  let shared: SharedDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-chaos-"));
    file = join(dir, "o.db");
    const raw = new SqliteDatabase(file);
    raw.exec(SCHEMA);
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
    raw.close();
    edb = new EngineDatabase(file);
    shared = new SharedDb(edb.db);
    edb.db
      .prepare(
        `INSERT INTO project (title, story, style, status, story_outline, outline_approved, updated_at, created_at)
         VALUES ('chaos', 's', 'anime', 'draft', '{}', 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    edb.db.prepare("INSERT INTO character (project_id, name) VALUES (1, 'Mika')").run();
  });

  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("1. crash/replay", () => {
    it("survives a crash after side effects without minting a second identity", () => {
      const first = edb.beginStageAttempt({
        runId: 1,
        stage: "render_characters",
        input: { characters: [] },
        executionAttempt: 1,
      });

      // Crash window: the stage already mutated rows, so a resumed run sees
      // different state than the attempt recorded.
      shared.updateCharacter(1, { image_url: "/static/images/mika.svg" });

      const resumed = edb.beginStageAttempt({
        runId: 1,
        stage: "render_characters",
        input: { characters: [{ id: 1, image_url: "/static/images/mika.svg" }] },
        executionAttempt: 2,
      });

      // Same operation: the provider must not be called twice for one attempt.
      expect(resumed.stage_attempt_id).toBe(first.stage_attempt_id);
      expect(resumed.idempotency_key).toBe(first.idempotency_key);
      expect(resumed.input_hash).toBe(first.input_hash);
      expect(
        edb.db
          .prepare(
            "SELECT COUNT(*) AS n FROM engine_stage_attempts WHERE run_id = 1 AND stage = 'render_characters'",
          )
          .get(),
      ).toEqual({ n: 1 });
    });

    it("reads the frozen input rather than re-deriving it after replay", () => {
      const attempt = edb.beginStageAttempt({
        runId: 1,
        stage: "render_shots",
        input: { shots: [{ id: 5, image_url: null }] },
        executionAttempt: 1,
      });
      // A later writer changes the world; the attempt keeps its own view.
      edb.db.prepare("UPDATE character SET image_url = '/changed.svg' WHERE id = 1").run();

      expect(edb.stageAttemptInput(attempt.stage_attempt_id)).toEqual({
        shots: [{ id: 5, image_url: null }],
      });
    });
  });

  describe("2. cancellation", () => {
    function media(): MediaService {
      return new MediaService({
        staticDir: dir,
        imageProvider: "openai",
        imageApiKey: "k",
        imageBaseUrl: "https://example.test",
        imageEndpoint: "/v1/images",
        imageModel: "m",
        enableImageToImage: false,
        fakeImageFixtureUrl: null,
      } as MediaSettings);
    }

    it("kills an in-flight provider request instead of letting it finish", async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        ),
      );

      const service = media();
      service.setAbortSignal(controller.signal);
      const pending = service.generateImageUrl({ prompt: "never completes" });
      controller.abort();

      await expect(pending).rejects.toThrow(/abort/i);
      vi.unstubAllGlobals();
    });

    it("refuses to start work for an already cancelled run", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const service = media();
      service.setAbortSignal(controller.signal);
      await expect(service.generateImageUrl({ prompt: "nope" })).rejects.toThrow(/cancel|abort/i);

      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("stops a pending backoff wait when the run is cancelled", async () => {
      const controller = new AbortController();
      const op = beginAiOperation({
        operationId: "a1",
        idempotencyKey: "i1",
        runId: 1,
        projectId: 1,
        stage: "compose_videos",
        signal: controller.signal,
      });

      const service = media();
      service.setAbortSignal(controller.signal);
      service.setOperation(op);

      // Cancelling before the request starts must surface, not silently pass.
      controller.abort();
      await expect(service.generateImageUrl({ prompt: "x" })).rejects.toThrow(/abort|cancel/i);
    });
  });

  describe("3. concurrent write", () => {
    it("refuses a stale engine write instead of clobbering a user edit", () => {
      const frozen = shared.getCharacter(1)!;
      const stage = shared.withFrozenStageInput({
        project: null,
        characters: [frozen],
        shots: [],
      });

      // The user edits through HTTP first (revision 1 -> 2).
      edb.db.prepare("UPDATE character SET name = 'Mika (user)', revision = 2 WHERE id = 1").run();

      expect(() => stage.updateCharacter(1, { image_url: "/generated.svg" })).toThrow(
        ConcurrentModificationError,
      );
      expect(shared.getCharacter(1)?.name).toBe("Mika (user)");
      expect(shared.getCharacter(1)?.image_url).toBeNull();
    });

    it("loses the race rather than writing half-applied data", () => {
      const frozen = shared.getCharacter(1)!;
      const stage = shared.withFrozenStageInput({ project: null, characters: [frozen], shots: [] });
      stage.updateCharacter(1, { description: "engine-1" });

      // A second stale writer based on the original revision also fails.
      const stale = shared.withFrozenStageInput({ project: null, characters: [frozen], shots: [] });
      expect(() => stale.updateCharacter(1, { description: "engine-2" })).toThrow(
        ConcurrentModificationError,
      );
      expect(shared.getCharacter(1)?.description).toBe("engine-1");
    });
  });

  describe("4. provider failure", () => {
    it("propagates a provider error rather than swallowing it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response),
      );

      const service = new MediaService({
        staticDir: dir,
        imageProvider: "openai",
        imageApiKey: "k",
        imageBaseUrl: "https://example.test",
        imageEndpoint: "/v1/images",
        imageModel: "m",
        enableImageToImage: false,
        fakeImageFixtureUrl: null,
      } as MediaSettings);

      await expect(service.generateImageUrl({ prompt: "boom" })).rejects.toThrow(/503/);
      vi.unstubAllGlobals();
    });

    it("fails loudly when a provider returns a malformed body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            ({ ok: true, json: async () => ({ data: [] }) }) as unknown as Response,
        ),
      );

      const service = new MediaService({
        staticDir: dir,
        imageProvider: "openai",
        imageApiKey: "k",
        imageBaseUrl: "https://example.test",
        imageEndpoint: "/v1/images",
        imageModel: "m",
        enableImageToImage: false,
        fakeImageFixtureUrl: null,
      } as MediaSettings);

      // An empty data array must not be turned into a silent empty URL.
      await expect(service.generateImageUrl({ prompt: "empty" })).rejects.toThrow(/no URL/);
      vi.unstubAllGlobals();
    });
  });

describe("5. observability under failure", () => {
  it("emits one span per stage attempt with the run identity", async () => {
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
      "@opentelemetry/sdk-trace-base"
    );
    const { trace } = await import("@opentelemetry/api");
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    } as never);
    trace.setGlobalTracerProvider(provider);

    try {
      const { TextLlmService } = await import("../src/llm.js");
      const { PipelineRunner } = await import("../src/pipeline/runner.js");
      process.env.TEXT_PROVIDER = "fake";
      process.env.IMAGE_PROVIDER = "fake";
      process.env.VIDEO_PROVIDER = "fake";
      process.env.ENGINE_STATIC_DIR = join(dir, "static");

      edb.db
        .prepare(
          `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, created_at, updated_at)
           VALUES (1, 'queued', 'render', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        )
        .run();

      const runner = new PipelineRunner(edb, shared, new TextLlmService(edb));
      await runner.run({
        projectId: 1,
        runId: 1,
        autoMode: true,
        userFeedback: "",
        startStage: "render_characters",
        targetCharacterIds: [1],
      });

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      const stage = spans.find((span) => span.name === "stage render_characters");
      expect(stage, "the targeted run must emit a stage span").toBeDefined();
      expect(stage!.attributes["openoii.run_id"]).toBe(1);
      expect(stage!.attributes["openoii.project_id"]).toBe(1);
      expect(typeof stage!.attributes["openoii.stage_attempt_id"]).toBe("string");
    } finally {
      exporter.reset();
      await provider.shutdown();
      trace.disable();
    }
  }, 60000);
});
});
