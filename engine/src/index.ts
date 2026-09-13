/**
 * Engine sidecar HTTP entry (loopback only).
 *
 * GET  /health
 * GET  /runs                  → {runs: number[]} 当前活跃 run id
 * POST /runs                  {project_id, run_id, stage?, auto_mode?, user_feedback?}
 * POST /runs/:id/resume
 * POST /runs/:id/cancel
 * GET  /runs/:id/events?after=N
 *
 * The engine is the only orchestrator: every run goes through PipelineRunner
 * (the 17-stage machine in pipeline/runner.ts). There is no second, shorter
 * execution path to keep in sync.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EngineDatabase } from "./db.js";
import { TextLlmService } from "./llm.js";
import { SharedDb } from "./shared-db.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { PRODUCTION_STAGE_SEQUENCE, type StageId } from "./contract.js";

export function createEngineApp(dbPath: string) {
  const db = new EngineDatabase(dbPath);
  const llm = new TextLlmService(db);
  const shared = new SharedDb(db.db);
  const pipelines = new Map<number, PipelineRunner>();

  function startPipeline(
    runId: number,
    request: Parameters<PipelineRunner["run"]>[0],
    mode: "run" | "resume",
  ): boolean {
    // A run id is an execution identity, not merely a lookup key. Starting the
    // same run twice used to overwrite the Map entry while the old runner kept
    // executing, leaving two writers for one run and making cancel target only
    // the newest runner. Reject duplicates until the active execution exits.
    if (pipelines.has(runId)) return false;

    const runner = new PipelineRunner(db, shared, llm);
    pipelines.set(runId, runner);
    void runner[mode](request).finally(() => {
      // Defensive fencing: only the runner that still owns the slot may clear
      // it. This matters if execution ownership becomes durable in the future.
      if (pipelines.get(runId) === runner) pipelines.delete(runId);
    });
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const conflict = (runId: number): void => {
      send(409, {
        error: {
          code: "RUN_ALREADY_ACTIVE",
          message: `run ${runId} already has an active executor`,
          details: { run_id: runId },
        },
      });
    };

    if (req.method === "GET" && url.pathname === "/health") {
      send(200, { status: "ok", runs: pipelines.size, provider: llm.resolveProvider().key });
      return;
    }

    // Active run ids. The Python side cannot know what is executing (the engine
    // owns execution), so run-state hydration asks here instead of guessing.
    if (req.method === "GET" && url.pathname === "/runs") {
      send(200, { runs: [...pipelines.keys()] });
      return;
    }

    const runMatch = /^\/runs\/(\d+)(\/cancel|\/events|\/resume)?$/.exec(url.pathname);

    if (req.method === "POST" && url.pathname === "/runs") {
      const body = await readJson(req);
      const projectId = Number(body.project_id);
      const runId = Number(body.run_id ?? body.id);
      if (!Number.isFinite(projectId) || !Number.isFinite(runId)) {
        send(400, { error: "project_id and run_id are required" });
        return;
      }
      const rawStage = typeof body.stage === "string" ? body.stage : "";
      const started = startPipeline(
        runId,
        {
          projectId,
          runId,
          autoMode: Boolean(body.auto_mode),
          userFeedback: typeof body.user_feedback === "string" ? body.user_feedback : "",
          startStage: isStageId(rawStage) ? rawStage : undefined,
        },
        "run",
      );
      if (!started) {
        conflict(runId);
        return;
      }
      send(202, { status: "running", run_id: runId, project_id: projectId });
      return;
    }

    if (runMatch && req.method === "POST" && runMatch[2] === "/resume") {
      const runId = Number(runMatch[1]);
      const body = await readJson(req);
      const projectId = Number(body.project_id);
      if (!Number.isFinite(projectId)) {
        send(400, { error: "project_id is required" });
        return;
      }
      const started = startPipeline(
        runId,
        { projectId, runId, autoMode: Boolean(body.auto_mode), userFeedback: "" },
        "resume",
      );
      if (!started) {
        conflict(runId);
        return;
      }
      send(202, { status: "running", run_id: runId, project_id: projectId });
      return;
    }

    if (runMatch && req.method === "POST" && runMatch[2] === "/cancel") {
      const runId = Number(runMatch[1]);
      pipelines.get(runId)?.requestCancel();
      send(202, { status: "cancelling" });
      return;
    }

    if (runMatch && req.method === "GET" && runMatch[2] === "/events") {
      const runId = Number(runMatch[1]);
      const after = Number(url.searchParams.get("after") ?? 0);
      const rows = db.eventsForRun(runId, Number.isFinite(after) ? after : 0);
      send(200, {
        events: rows.map((r) => ({
          seq: r.seq,
          run_id: r.run_id,
          project_id: r.project_id,
          type: r.type,
          data: JSON.parse(r.payload) as unknown,
          created_at: r.created_at,
        })),
      });
      return;
    }

    send(404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  return { server, db, llm, shared, pipelines };
}

function isStageId(value: string): value is StageId {
  return (PRODUCTION_STAGE_SEQUENCE as readonly string[]).includes(value);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("index.ts");
if (isMain) {
  const dbPath = process.env.ENGINE_DB_PATH ?? "data/openoii.db";
  const port = Number(process.env.ENGINE_PORT ?? 18766);
  const app = createEngineApp(dbPath);
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`openoii-engine listening on 127.0.0.1:${port} (db: ${dbPath})`);
  });
}
