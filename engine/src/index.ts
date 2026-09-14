/** Workflow engine sidecar HTTP entry (loopback only). */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EngineDatabase } from "./db.js";
import {
  TextLlmService,
  type RunCreativeContext,
  type TextProviderSnapshot,
} from "./llm.js";
import { SharedDb, parseJsonColumn } from "./shared-db.js";
import { PipelineRunner } from "./pipeline/runner.js";
import {
  applyInvalidationPlan,
  type InvalidationPlan,
} from "./invalidation.js";
import { PRODUCTION_STAGE_SEQUENCE, type StageId, WORKFLOW_VERSION } from "./contract.js";

const LEASE_TTL_SECONDS = 120;
const LEASE_HEARTBEAT_MS = 30_000;
const INVALIDATION_CHECKPOINT = "__invalidation__";

export function createEngineApp(dbPath: string) {
  const db = new EngineDatabase(dbPath);
  const llm = new TextLlmService(db);
  const shared = new SharedDb(db.db);
  const pipelines = new Map<number, PipelineRunner>();
  const ownerId = `engine-${process.pid}-${randomUUID()}`;

  function runContext(runId: number): RunCreativeContext {
    const row = shared.getRun(runId);
    return parseJsonColumn(row?.context_snapshot, {} as RunCreativeContext);
  }

  function runInvalidationPlan(runId: number): InvalidationPlan | undefined {
    const row = db.db
      .prepare("SELECT patch_plan FROM agentrun WHERE id = ?")
      .get(runId) as { patch_plan: string | null } | undefined;
    const plan = parseJsonColumn(row?.patch_plan, null as InvalidationPlan | null);
    return plan ?? undefined;
  }

  function runScopedLlm(context: RunCreativeContext): TextLlmService {
    const providers =
      typeof context.providers === "object" && context.providers !== null
        ? (context.providers as Record<string, unknown>)
        : {};
    const text =
      typeof providers.text === "object" && providers.text !== null
        ? (providers.text as TextProviderSnapshot)
        : undefined;
    return llm.forSnapshot(text, context);
  }

  function startPipeline(
    runId: number,
    request: Parameters<PipelineRunner["run"]>[0],
    mode: "run" | "resume",
  ): boolean {
    if (pipelines.has(runId)) return false;

    const run = shared.getRun(runId);
    if (!run || run.project_id !== request.projectId) return false;
    if (run.workflow_version !== WORKFLOW_VERSION) {
      throw new Error(
        `run ${runId} workflow version ${run.workflow_version} is incompatible with engine ${WORKFLOW_VERSION}`,
      );
    }

    const leaseToken = randomUUID();
    if (!shared.acquireRunLease(runId, ownerId, leaseToken, LEASE_TTL_SECONDS)) {
      return false;
    }

    const context = runContext(runId);
    const fencedShared = shared.fenced(runId, leaseToken);
    const plan = runInvalidationPlan(runId);
    if (plan && !db.checkpointStages(runId).includes(INVALIDATION_CHECKPOINT)) {
      // Artifact invalidation is part of execution ownership, so it must happen
      // only after the fencing lease is acquired. The marker makes replay safe:
      // crash before marker -> idempotently reapply; crash after marker -> skip.
      applyInvalidationPlan(fencedShared, request.projectId, plan);
      db.saveCheckpoint(runId, INVALIDATION_CHECKPOINT, {
        applied_at: new Date().toISOString(),
        version: plan.version,
        start_stage: plan.start_stage,
        scope: plan.scope,
      });
    }

    const runner = new PipelineRunner(db, fencedShared, runScopedLlm(context), context);
    pipelines.set(runId, runner);

    const heartbeat = setInterval(() => {
      const renewed = shared.renewRunLease(runId, ownerId, leaseToken, LEASE_TTL_SECONDS);
      if (!renewed) {
        clearInterval(heartbeat);
        runner.requestCancel();
      }
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref();

    void runner[mode](request).finally(() => {
      clearInterval(heartbeat);
      shared.releaseRunLease(runId, ownerId, leaseToken);
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
          message: `run ${runId} already has an active executor lease`,
          details: { run_id: runId },
        },
      });
    };

    if (req.method === "GET" && url.pathname === "/health") {
      send(200, {
        status: "ok",
        runs: pipelines.size,
        provider: llm.resolveProvider().key,
        workflow_version: WORKFLOW_VERSION,
        owner_id: ownerId,
      });
      return;
    }

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
      const numberArray = (value: unknown): number[] | undefined =>
        Array.isArray(value) && value.every((item) => typeof item === "number")
          ? (value as number[])
          : undefined;
      const started = startPipeline(
        runId,
        {
          projectId,
          runId,
          autoMode: Boolean(body.auto_mode),
          userFeedback: typeof body.user_feedback === "string" ? body.user_feedback : "",
          startStage: isStageId(rawStage) ? rawStage : undefined,
          // Targeted redraw / fill scope; the engine decides which stages run.
          targetCharacterIds: numberArray(body.target_character_ids),
          targetShotIds: numberArray(body.target_shot_ids),
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
      shared.requestRunCancel(runId);
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
          event_id: r.seq,
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

  return { server, db, llm, shared, pipelines, ownerId };
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
