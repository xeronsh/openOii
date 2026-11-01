import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { createEngineApp } from "../src/index.js";
import { WORKFLOW_VERSION } from "../src/contract.js";
import { PipelineRunner, type PipelineRequest } from "../src/pipeline/runner.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");

type Call = { mode: "run" | "resume"; request: PipelineRequest; runner: PipelineRunner; finish: (error?: Error) => void };

/**
 * The sidecar HTTP layer: command validation, lease fencing, rerun-plan scoping,
 * resume recovery, cancel and the event tail. The pipeline itself is replaced by a
 * controllable stub so each test pins what the server hands the runner and what it
 * does when the runner settles.
 */
describe("engine sidecar server", () => {
  let dir: string;
  let app: ReturnType<typeof createEngineApp>;
  let base: string;
  let calls: Call[];
  let cancelled: PipelineRunner[];

  beforeEach(async () => {
    process.env.TEXT_PROVIDER = "fake";
    dir = mkdtempSync(join(tmpdir(), "openoii-server-"));
    const dbFile = join(dir, "test.db");
    const raw = new SqliteDatabase(dbFile);
    raw.exec(SCHEMA);
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
    raw.close();
    calls = [];
    cancelled = [];
    const stub = (mode: "run" | "resume") =>
      function (this: PipelineRunner, request: PipelineRequest) {
        return new Promise((resolveRun, rejectRun) => {
          calls.push({
            mode,
            request,
            runner: this,
            finish: (error) => (error ? rejectRun(error) : resolveRun({ status: "completed" })),
          });
        });
      };
    vi.spyOn(PipelineRunner.prototype, "run").mockImplementation(stub("run") as never);
    vi.spyOn(PipelineRunner.prototype, "resume").mockImplementation(stub("resume") as never);
    vi.spyOn(PipelineRunner.prototype, "requestCancel").mockImplementation(function (this: PipelineRunner) {
      cancelled.push(this);
    });
    app = createEngineApp(dbFile);
    await new Promise<void>((done) => app.server.listen(0, "127.0.0.1", () => done()));
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    for (const call of calls) call.finish();
    await new Promise<void>((done) => app.server.close(() => done()));
    app.db.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(opts: { workflowVersion?: number; context?: unknown; patchPlan?: unknown; currentAgent?: string } = {}) {
    const db = app.db.db;
    db.prepare(
      `INSERT INTO project (title, story, style, status, outline_approved, updated_at, created_at)
       VALUES ('P', 's', 'anime', 'draft', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run();
    const projectId = Number((db.prepare("SELECT MAX(id) AS id FROM project").get() as { id: number }).id);
    db.prepare(
      `INSERT INTO agentrun (project_id, status, current_agent, progress, confirm_requested, workflow_version,
                             context_snapshot, patch_plan, created_at, updated_at)
       VALUES (?, 'queued', ?, 0, 0, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      projectId,
      opts.currentAgent ?? "orchestrator",
      opts.workflowVersion ?? WORKFLOW_VERSION,
      opts.context === undefined ? "{}" : opts.context === null ? null : JSON.stringify(opts.context),
      opts.patchPlan === undefined ? null : JSON.stringify(opts.patchPlan),
    );
    const runId = Number((db.prepare("SELECT MAX(id) AS id FROM agentrun").get() as { id: number }).id);
    db.prepare("INSERT INTO character (project_id, name, description) VALUES (?, '甲', 'A')").run(projectId);
    db.prepare('INSERT INTO shot (project_id, "order", description) VALUES (?, 1, \'一\'), (?, 2, \'二\')').run(projectId, projectId);
    const characterId = Number((db.prepare("SELECT MAX(id) AS id FROM character").get() as { id: number }).id);
    const shotIds = (db.prepare("SELECT id FROM shot WHERE project_id = ? ORDER BY id").all(projectId) as Array<{ id: number }>).map(
      (row) => row.id,
    );
    return { projectId, runId, characterId, shotIds };
  }

  const run = (runId: number) =>
    app.db.db.prepare("SELECT * FROM agentrun WHERE id = ?").get(runId) as Record<string, string | number | null>;

  async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const fullCommand = { stage: "full", auto_mode: true, user_feedback: "更暗一点" };

  it("starts a full run under a lease, lists it, and releases the lease when the runner settles", async () => {
    const { projectId, runId } = seed();
    const res = await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    expect(res).toEqual({ status: 202, body: { status: "running", run_id: runId, project_id: projectId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mode).toBe("run");
    expect(calls[0]!.request).toEqual({
      projectId,
      runId,
      autoMode: true,
      userFeedback: "更暗一点",
      startStage: undefined,
      targetCharacterIds: undefined,
      targetShotIds: undefined,
      forceRegenerate: false,
    });
    expect(run(runId).lease_owner).toBe(app.ownerId);
    expect(run(runId).execution_attempt).toBe(1);
    expect(await (await fetch(`${base}/runs`)).json()).toEqual({ runs: [runId] });
    expect(((await (await fetch(`${base}/health`)).json()) as { runs: number }).runs).toBe(1);

    calls[0]!.finish();
    await vi.waitFor(() => expect(app.pipelines.size).toBe(0));
    expect(run(runId).lease_owner).toBeNull();
    expect(run(runId).lease_token).toBeNull();
  });

  it("hands a targeted shot redraw to the runner as shot scope with force flag (F11 path)", async () => {
    const { projectId, runId, shotIds } = seed();
    const res = await post("/runs", {
      project_id: projectId,
      run_id: runId,
      stage: "render_shots",
      auto_mode: false,
      user_feedback: "",
      target_shot_ids: [shotIds[1]],
      force_regenerate: true,
    });
    expect(res.status).toBe(202);
    expect(calls[0]!.request).toMatchObject({
      startStage: "render_shots",
      targetShotIds: [shotIds[1]],
      targetCharacterIds: undefined,
      forceRegenerate: true,
    });
  });

  it("rejects malformed commands and foreign targets before taking a lease", async () => {
    const { projectId, runId, characterId, shotIds } = seed();
    const other = seed();
    const base = { project_id: projectId, run_id: runId, auto_mode: false, user_feedback: "" };
    const cases: Array<[unknown, number, string]> = [
      [{ ...base, stage: "full", target_shot_ids: [] }, 400, "target arrays must be omitted"],
      [{ ...base, stage: "render_shots", target_shot_ids: ["1"], force_regenerate: true }, 400, "RUN_COMMAND_INVALID"],
      [{ ...base, stage: "render_shots", target_shot_ids: [shotIds[0]] }, 400, "RUN_COMMAND_INVALID"],
      [{ ...base, stage: "render_shots", target_character_ids: [characterId], force_regenerate: true }, 400, "RUN_COMMAND_INVALID"],
      [{ ...base, stage: "render_shots", target_shot_ids: [shotIds[0], shotIds[0]], force_regenerate: true }, 400, "RUN_COMMAND_INVALID"],
      [{ ...base, stage: "teleport" }, 400, "RUN_COMMAND_INVALID"],
      [
        { ...base, stage: "render_shots", target_character_ids: [characterId], target_shot_ids: [shotIds[0]], force_regenerate: true },
        400,
        "RUN_COMMAND_INVALID",
      ],
      [{ ...base, stage: "full", auto_mode: "yes" }, 400, "RUN_COMMAND_INVALID"],
      [
        { ...base, stage: "render_shots", target_shot_ids: [other.shotIds[0]], force_regenerate: true },
        400,
        `target IDs not found in project ${projectId}: ${other.shotIds[0]}`,
      ],
    ];
    for (const [body, status, text] of cases) {
      const res = await post("/runs", body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(JSON.stringify(res.body)).toContain(text);
    }
    expect(calls).toHaveLength(0);
    expect(run(runId).lease_owner).toBeNull();
  });

  it("refuses a second executor while another owner holds a live lease", async () => {
    const { projectId, runId } = seed();
    app.db.db
      .prepare("UPDATE agentrun SET lease_owner = 'other', lease_token = 't', lease_expires_at = datetime('now', '+60 seconds') WHERE id = ?")
      .run(runId);
    const res = await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RUN_ALREADY_ACTIVE");
    expect(calls).toHaveLength(0);
    expect(run(runId).lease_owner).toBe("other");
  });

  it("finalises a cancel that was requested while no executor held the run", async () => {
    const { projectId, runId } = seed();
    app.db.db
      .prepare("UPDATE agentrun SET status = 'cancelling', cancel_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(runId);
    const res = await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(run(runId).status).toBe("cancelled");
    const events = app.db.eventsForRun(runId);
    expect(events.map((e) => e.type)).toEqual(["run_cancelled"]);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ run_id: runId, run_ids: [runId] });
  });

  it("refuses a run whose workflow version the engine cannot execute with a readable 409", async () => {
    const { projectId, runId } = seed({ workflowVersion: 1 });
    const res = await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RUN_WORKFLOW_INCOMPATIBLE");
    expect(res.body.error.message).toContain("工作流版本 1");
    expect(res.body.error.details).toEqual({ run_id: runId, workflow_version: 1, engine_workflow_version: WORKFLOW_VERSION });
    expect(calls).toHaveLength(0);
    expect(run(runId).lease_owner).toBeNull();
  });

  it("answers a missing or foreign run with the same 404 as resume", async () => {
    const { projectId, runId } = seed();
    for (const body of [
      { project_id: projectId, run_id: runId + 999, ...fullCommand },
      { project_id: projectId + 1, run_id: runId, ...fullCommand },
    ]) {
      const start = await post("/runs", body);
      const resume = await post(`/runs/${body.run_id}/resume`, { project_id: body.project_id });
      expect(start.status, JSON.stringify(body)).toBe(404);
      expect(start.body).toEqual(resume.body);
      expect(start.body.error.code).toBe("RUN_NOT_FOUND");
      expect(start.body.error.message).toContain("不存在");
    }
    expect(calls).toHaveLength(0);
    expect(run(runId).lease_owner).toBeNull();
  });

  it("scopes a full run from the stored rerun plan and applies the plan only once", async () => {
    const shotPlan = (shotIds: number[]) => ({
      version: 1,
      start_stage: "render_shots",
      scope: { entity_type: "shot", entity_ids: [shotIds[0], -4] },
    });
    const first = seed();
    app.db.db.prepare("UPDATE agentrun SET patch_plan = ? WHERE id = ?").run(JSON.stringify(shotPlan(first.shotIds)), first.runId);
    expect((await post("/runs", { project_id: first.projectId, run_id: first.runId, ...fullCommand })).status).toBe(202);
    expect(calls[0]!.request.targetShotIds).toEqual([first.shotIds[0]]);
    const checkpoint = app.db.db
      .prepare("SELECT state_json FROM engine_checkpoints WHERE run_id = ? AND stage = '__invalidation__'")
      .get(first.runId) as { state_json: string };
    expect(JSON.parse(checkpoint.state_json)).toMatchObject({ version: 1, start_stage: "render_shots" });

    // A restart of the same run keeps the first application.
    calls[0]!.finish();
    await vi.waitFor(() => expect(app.pipelines.size).toBe(0));
    app.db.db.prepare("UPDATE engine_checkpoints SET state_json = '{\"kept\":true}' WHERE run_id = ?").run(first.runId);
    expect((await post("/runs", { project_id: first.projectId, run_id: first.runId, ...fullCommand })).status).toBe(202);
    expect(
      (app.db.db.prepare("SELECT state_json FROM engine_checkpoints WHERE run_id = ?").get(first.runId) as { state_json: string })
        .state_json,
    ).toBe('{"kept":true}');

    const chars = seed({ patchPlan: { version: 1, start_stage: "nope", scope: { entity_type: "character", entity_ids: [99] } } });
    expect((await post("/runs", { project_id: chars.projectId, run_id: chars.runId, ...fullCommand })).status).toBe(202);
    expect(calls.at(-1)!.request.targetCharacterIds).toEqual([99]);
  });

  it("cancel marks the run and aborts its live runner", async () => {
    const { projectId, runId } = seed();
    await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    const res = await post(`/runs/${runId}/cancel`, {});
    expect(res).toEqual({ status: 202, body: { status: "cancelling" } });
    expect(run(runId).status).toBe("cancelling");
    expect(run(runId).cancel_requested_at).not.toBeNull();
    expect(cancelled).toEqual([calls[0]!.runner]);
    // Cancelling a run with no executor only records the request.
    const idle = seed();
    expect((await post(`/runs/${idle.runId}/cancel`, {})).status).toBe(202);
    expect(run(idle.runId).status).toBe("cancelling");
  });

  it("serves the event tail after a sequence number", async () => {
    const { projectId, runId } = seed();
    app.db.appendEvent(runId, projectId, "run_started", { a: 1 });
    app.db.appendEvent(runId, projectId, "run_progress", { progress: 0.5 });
    const all = (await (await fetch(`${base}/runs/${runId}/events`)).json()) as { events: Array<Record<string, unknown>> };
    expect(all.events.map((e) => e.type)).toEqual(["run_started", "run_progress"]);
    expect(all.events[1]).toMatchObject({ run_id: runId, project_id: projectId, data: { progress: 0.5 } });
    expect(all.events[1]!.event_id).toBe(all.events[1]!.seq);
    const after = (await (await fetch(`${base}/runs/${runId}/events?after=${String(all.events[0]!.seq)}`)).json()) as {
      events: unknown[];
    };
    expect(after.events).toHaveLength(1);
    const junk = (await (await fetch(`${base}/runs/${runId}/events?after=abc`)).json()) as { events: unknown[] };
    expect(junk.events).toHaveLength(2);
  });

  describe("resume", () => {
    const command = (extra: Record<string, unknown> = {}) => ({
      version: 1,
      stage: "full",
      auto_mode: false,
      user_feedback: "",
      target_character_ids: [],
      target_shot_ids: [],
      ...extra,
    });

    it("validates the request against the stored run", async () => {
      const { projectId, runId } = seed();
      expect((await post(`/runs/${runId}/resume`, {})).status).toBe(400);
      expect((await post(`/runs/${runId}/resume`, { project_id: projectId + 1 })).status).toBe(404);
      const old = seed({ workflowVersion: 1 });
      const res = await post(`/runs/${old.runId}/resume`, { project_id: old.projectId });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("RUN_WORKFLOW_INCOMPATIBLE");
      // same body as POST /runs for the same run
      const start = await post("/runs", { project_id: old.projectId, run_id: old.runId, ...fullCommand });
      expect(start.body).toEqual(res.body);
    });

    it("resumes with the persisted execution command", async () => {
      const { projectId, runId, shotIds } = seed();
      app.db.db
        .prepare("UPDATE agentrun SET context_snapshot = ? WHERE id = ?")
        .run(
          JSON.stringify({ execution_command: command({ stage: "compose_videos", target_shot_ids: [shotIds[0]], force_regenerate: false }) }),
          runId,
        );
      const res = await post(`/runs/${runId}/resume`, { project_id: projectId });
      expect(res.status).toBe(202);
      expect(calls[0]!.mode).toBe("resume");
      expect(calls[0]!.request).toMatchObject({ startStage: "compose_videos", targetShotIds: [shotIds[0]], forceRegenerate: false });
    });

    it("refuses to guess a malformed or unprovable command", async () => {
      const malformedContext = seed({ context: [1, 2] });
      const badCommand = seed({ context: { execution_command: { version: 9 } } });
      const nullContext = seed({ context: null });
      const started = seed({ context: {} });
      app.db.appendEvent(started.runId, started.projectId, "run_started", {});
      const userMessage = seed({ context: {} });
      app.db.db
        .prepare("INSERT INTO agentmessage (run_id, agent, role, content, created_at) VALUES (?, 'x', 'user', 'hi', '2026-01-01')")
        .run(userMessage.runId);
      const notOrchestrator = seed({ context: {}, currentAgent: "render" });
      for (const [seeded, message] of [
        [malformedContext, "Run context is malformed"],
        [badCommand, "Run command is malformed"],
        [nullContext, "original scope cannot be proven"],
        [started, "original scope cannot be proven"],
        [userMessage, "original scope cannot be proven"],
        [notOrchestrator, "original scope cannot be proven"],
      ] as const) {
        const res = await post(`/runs/${seeded.runId}/resume`, { project_id: seeded.projectId });
        expect(res.status, message).toBe(409);
        expect(res.body.error.code).toBe("RUN_COMMAND_UNRECOVERABLE");
        expect(res.body.error.message).toContain(message);
      }
      expect(calls).toHaveLength(0);
    });

    it("recovers a never-started legacy run as a full run and persists the command", async () => {
      const { projectId, runId } = seed({ context: { providers: {} } });
      const res = await post(`/runs/${runId}/resume`, { project_id: projectId });
      expect(res.status).toBe(202);
      expect(calls[0]!.request).toMatchObject({ startStage: undefined, autoMode: false, userFeedback: "" });
      expect(JSON.parse(String(run(runId).context_snapshot))).toEqual({ providers: {}, execution_command: command() });
    });

    it("reports targets that were deleted since the run was queued", async () => {
      const { projectId, runId, characterId } = seed();
      app.db.db
        .prepare("UPDATE agentrun SET context_snapshot = ? WHERE id = ?")
        .run(
          JSON.stringify({
            execution_command: command({ stage: "render_characters", target_character_ids: [characterId], force_regenerate: true }),
          }),
          runId,
        );
      app.db.db.prepare("DELETE FROM character WHERE id = ?").run(characterId);
      const res = await post(`/runs/${runId}/resume`, { project_id: projectId });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "TARGET_NOT_FOUND", details: { target_ids: [characterId] } });
    });

    it("reports a conflict when the run already has an executor", async () => {
      const { projectId, runId } = seed({ context: { execution_command: command() } });
      expect((await post(`/runs/${runId}/resume`, { project_id: projectId })).status).toBe(202);
      const again = await post(`/runs/${runId}/resume`, { project_id: projectId });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("RUN_ALREADY_ACTIVE");
    });
  });

  describe("lease heartbeat", () => {
    function captureHeartbeat(): () => void {
      let tick: (() => void) | undefined;
      const real = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
        if (ms === 30_000) tick = fn;
        return real(() => undefined, 1 << 30);
      }) as never);
      return () => tick?.();
    }

    it("renews its own lease and keeps running", async () => {
      const tick = captureHeartbeat();
      const { projectId, runId } = seed();
      await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
      app.db.db.prepare("UPDATE agentrun SET lease_expires_at = datetime('now', '+1 seconds') WHERE id = ?").run(runId);
      tick();
      expect(String(run(runId).lease_expires_at) > new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19)).toBe(true);
      expect(cancelled).toHaveLength(0);
    });

    it("reclaims a free lease after a missed renewal and reports progress", async () => {
      const tick = captureHeartbeat();
      const { projectId, runId } = seed();
      await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
      // The gateway expired the lease while the box slept.
      app.db.db
        .prepare(
          "UPDATE agentrun SET lease_owner = NULL, status = 'failed', error = 'Execution lease missing or expired', progress = 0.4 WHERE id = ?",
        )
        .run(runId);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      tick();
      expect(run(runId)).toMatchObject({ status: "running", error: null, lease_owner: app.ownerId });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("reclaimed the free lease"));
      const progress = app.db.eventsForRun(runId).at(-1)!;
      expect(progress.type).toBe("run_progress");
      expect(JSON.parse(progress.payload)).toMatchObject({ progress: 0.4 });
      expect(cancelled).toHaveLength(0);
    });

    it("cancels its runner when another executor owns the run", async () => {
      const tick = captureHeartbeat();
      const { projectId, runId } = seed();
      await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
      app.db.db
        .prepare("UPDATE agentrun SET lease_owner = 'other', lease_token = 'theirs', lease_expires_at = datetime('now', '+60 seconds') WHERE id = ?")
        .run(runId);
      tick();
      expect(cancelled).toEqual([calls[0]!.runner]);
    });
  });

  it("keeps serving and frees the run when the runner rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { projectId, runId } = seed();
    await post("/runs", { project_id: projectId, run_id: runId, ...fullCommand });
    calls[0]!.finish(new Error("execution lease lost for run " + runId));
    await vi.waitFor(() => expect(app.pipelines.size).toBe(0));
    expect(run(runId).lease_owner).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`run ${runId}`), expect.any(Error));
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("answers a malformed JSON body with a 400 instead of a server error", async () => {
    const res = await post("/runs", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});
