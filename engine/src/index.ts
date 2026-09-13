/**
 * Engine sidecar HTTP entry (loopback only).
 *
 * GET  /health
 * POST /runs                      {project_id, run_id, stage?, auto_mode?}
 * POST /runs/:id/cancel
 * GET  /runs/:id/events?after=N
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Database as SqliteDatabase } from "better-sqlite3";
import { EngineDatabase } from "./db.js";
import { TextLlmService } from "./llm.js";
import { RunManager } from "./runner.js";
import { SharedDb } from "./shared-db.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { PRODUCTION_STAGE_SEQUENCE, type StageId } from "./contract.js";

export function createEngineApp(dbPath: string) {
  const db = new EngineDatabase(dbPath);
  const llm = new TextLlmService(db);
  const runs = new RunManager(db, llm);
  const shared = new SharedDb(db.db);
  const pipelines = new Map<number, PipelineRunner>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/health") {
      send(200, { status: "ok", runs: runs.list().length, provider: llm.resolveProvider().key });
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
      const stage = typeof body.stage === "string" ? body.stage : "full";
      if (stage === "smoke") {
        const handle = await runs.start({ projectId, runId, stage, autoMode: Boolean(body.auto_mode) });
        send(202, { status: handle.phase, run_id: runId, project_id: projectId });
        return;
      }
      // full pipeline (phase 4 state machine)
      const runner = new PipelineRunner(db, shared, llm);
      pipelines.set(runId, runner);
      void runner
        .run({
          projectId,
          runId,
          autoMode: Boolean(body.auto_mode),
          userFeedback: typeof body.user_feedback === "string" ? body.user_feedback : "",
          startStage: isStageId(stage) ? stage : undefined,
        })
        .finally(() => pipelines.delete(runId));
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
      const runner = new PipelineRunner(db, shared, llm);
      pipelines.set(runId, runner);
      void runner
        .resume({ projectId, runId, autoMode: Boolean(body.auto_mode), userFeedback: "" })
        .finally(() => pipelines.delete(runId));
      send(202, { status: "running", run_id: runId, project_id: projectId });
      return;
    }

    if (runMatch && req.method === "POST" && runMatch[2] === "/cancel") {
      const runId = Number(runMatch[1]);
      const okSmoke = runs.cancel(runId);
      pipelines.get(runId)?.requestCancel();
      send(okSmoke ? 200 : 202, { status: "cancelling" });
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

  return { server, db, runs, llm, shared, pipelines };
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
