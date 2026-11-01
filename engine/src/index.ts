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
  type RerunIntent,
} from "./invalidation.js";
import { PRODUCTION_STAGE_SEQUENCE, WORKFLOW_VERSION } from "./contract.js";

const LEASE_TTL_SECONDS = 120;
const LEASE_HEARTBEAT_MS = 30_000;
const INVALIDATION_CHECKPOINT = "__invalidation__";
type ExecutionCommand = {
  version: 1;
  stage: NonNullable<Parameters<PipelineRunner["run"]>[0]["startStage"]> | "full";
  auto_mode: boolean;
  user_feedback: string;
  target_character_ids: number[];
  target_shot_ids: number[];
  force_regenerate?: boolean;
};
type LegacyFullCommand = ExecutionCommand & {
  stage: "full";
  auto_mode: false;
  user_feedback: "";
  target_character_ids: [];
  target_shot_ids: [];
};

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

  function runRerunIntent(runId: number): RerunIntent | undefined {
    const row = db.db
      .prepare("SELECT patch_plan FROM agentrun WHERE id = ?")
      .get(runId) as { patch_plan: string | null } | undefined;
    const plan = parseJsonColumn(row?.patch_plan, null as RerunIntent | null);
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
    recoveredCommand?: LegacyFullCommand,
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
      db.transaction(() => {
        const info = db.db
          .prepare(
            `UPDATE agentrun
             SET status = 'cancelled', awaiting_payload = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ? AND cancel_requested_at IS NOT NULL
               AND status IN ('queued','running','waiting_for_approval','cancelling')
               AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= datetime('now'))`,
          )
          .run(runId);
        if (info.changes === 1) {
          db.appendEvent(runId, request.projectId, "run_cancelled", {
            run_id: runId,
            project_id: request.projectId,
            cancelled_count: 1,
            run_ids: [runId],
          });
        }
      });
      return false;
    }

    try {
      if (recoveredCommand) persistRecoveredCommand(db, runId, leaseToken, recoveredCommand);
      const context = runContext(runId);
      const fencedShared = shared.fenced(runId, leaseToken);
      const plan = runRerunIntent(runId);
      const targetIds = Array.isArray(plan?.scope?.entity_ids)
        ? plan.scope.entity_ids.filter((id) => Number.isSafeInteger(id) && id > 0)
        : [];
      const scopedRequest =
        request.targetCharacterIds?.length || request.targetShotIds?.length || !targetIds.length
          ? request
          : plan?.scope.entity_type === "character"
            ? { ...request, targetCharacterIds: targetIds }
            : plan?.scope.entity_type === "shot"
              ? { ...request, targetShotIds: targetIds }
              : request;
      if (plan && !db.checkpointStages(runId).includes(INVALIDATION_CHECKPOINT)) {
        // Persist the resolved rerun stage under the fencing lease; artifact references
        // are invalidated only in the transaction that commits their replacements.
        const appliedStage = applyInvalidationPlan(fencedShared, request.projectId, plan);
        db.saveCheckpoint(runId, INVALIDATION_CHECKPOINT, {
          applied_at: new Date().toISOString(),
          version: plan.version,
          start_stage: appliedStage,
          scope: plan.scope,
        });
      }

      const runner = new PipelineRunner(db, fencedShared, runScopedLlm(context), context);
      pipelines.set(runId, runner);

      const heartbeat = setInterval(() => {
        const renewed =
          shared.renewRunLease(runId, ownerId, leaseToken, LEASE_TTL_SECONDS) ||
          reclaimLease(runId, request.projectId, leaseToken);
        if (!renewed) {
          clearInterval(heartbeat);
          runner.requestCancel();
        }
      }, LEASE_HEARTBEAT_MS);
      heartbeat.unref();

      void runner[mode](scopedRequest)
        .catch((error: unknown) => {
          // A runner that rejects (lease lost while committing a failure) must not
          // take the whole sidecar down as an unhandled rejection.
          console.error(`run ${runId}: executor stopped with an uncaught error`, error);
        })
        .finally(() => {
          clearInterval(heartbeat);
          shared.releaseRunLease(runId, ownerId, leaseToken);
          if (pipelines.get(runId) === runner) pipelines.delete(runId);
        });
      return true;
    } catch (error) {
      shared.releaseRunLease(runId, ownerId, leaseToken);
      throw error;
    }
  }

  /** A missed heartbeat (suspended box) is not a dead executor: take the lease back if it is free. */
  function reclaimLease(runId: number, projectId: number, leaseToken: string): boolean {
    if (!shared.reclaimRunLease(runId, ownerId, leaseToken, LEASE_TTL_SECONDS)) return false;
    console.warn(`run ${runId}: lease renewal missed; reclaimed the free lease and kept running`);
    const run = shared.getRun(runId);
    db.appendEvent(runId, projectId, "run_progress", {
      run_id: runId,
      project_id: projectId,
      current_agent: run?.current_agent ?? null,
      progress: run?.progress ?? 0,
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
      if (
        (Array.isArray(body.target_character_ids) && body.target_character_ids.length === 0) ||
        (Array.isArray(body.target_shot_ids) && body.target_shot_ids.length === 0)
      ) {
        send(400, { error: "target arrays must be omitted when no targets are requested" });
        return;
      }
      const targetCharacterIds = numberArray(body.target_character_ids);
      const targetShotIds = numberArray(body.target_shot_ids);
      const command = {
        version: 1,
        stage: rawStage,
        auto_mode: body.auto_mode,
        user_feedback: body.user_feedback,
        target_character_ids: targetCharacterIds ?? [],
        target_shot_ids: targetShotIds ?? [],
        force_regenerate: body.force_regenerate,
      };
      if (
        ("target_character_ids" in body && !targetCharacterIds) ||
        ("target_shot_ids" in body && !targetShotIds) ||
        !isExecutionCommand(command)
      ) {
        send(400, {
          error: {
            code: "RUN_COMMAND_INVALID",
            message: "Run stage, target scope, or command fields are invalid",
          },
        });
        return;
      }
      if (targetCharacterIds?.length && targetShotIds?.length) {
        send(400, { error: "target_character_ids and target_shot_ids cannot both be provided" });
        return;
      }
      const invalidTargets = invalidTargetIds(shared, projectId, targetCharacterIds, targetShotIds);
      if (invalidTargets.length) {
        send(400, { error: `target IDs not found in project ${projectId}: ${invalidTargets.join(", ")}` });
        return;
      }
      const started = startPipeline(
        runId,
        {
          projectId,
          runId,
          autoMode: command.auto_mode,
          userFeedback: command.user_feedback,
          startStage: command.stage === "full" ? undefined : command.stage,
          // Targeted redraw / fill scope; the engine decides which stages run.
          targetCharacterIds: command.target_character_ids.length
            ? command.target_character_ids
            : undefined,
          targetShotIds: command.target_shot_ids.length ? command.target_shot_ids : undefined,
          forceRegenerate: command.force_regenerate === true,
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
      const row = shared.getRun(runId);
      if (!row || row.project_id !== projectId) {
        send(404, { error: "run not found" });
        return;
      }
      if (row.workflow_version !== WORKFLOW_VERSION) {
        send(409, {
          error: {
            code: "RUN_WORKFLOW_INCOMPATIBLE",
            message: `Run workflow version ${row.workflow_version} is incompatible with engine ${WORKFLOW_VERSION}`,
          },
        });
        return;
      }
      const context = runContext(runId);
      if (typeof context !== "object" || context === null || Array.isArray(context)) {
        send(409, {
          error: {
            code: "RUN_COMMAND_UNRECOVERABLE",
            message: "Run context is malformed; safe recovery is unavailable",
          },
        });
        return;
      }
      const command = context.execution_command;
      const hasCommand = Object.hasOwn(context, "execution_command");
      let recoveryCommand: ExecutionCommand | undefined;
      if (!hasCommand) {
        recoveryCommand = legacyFullCommand(db, runId);
        if (!recoveryCommand) {
          send(409, {
            error: {
              code: "RUN_COMMAND_UNRECOVERABLE",
              message: "Run command is missing and its original scope cannot be proven; safe recovery is unavailable",
            },
          });
          return;
        }
      } else if (isExecutionCommand(command)) {
        recoveryCommand = command;
      } else {
        send(409, {
          error: {
            code: "RUN_COMMAND_UNRECOVERABLE",
            message: "Run command is malformed; safe recovery is unavailable",
          },
        });
        return;
      }
      const invalidTargets = invalidTargetIds(
        shared,
        projectId,
        recoveryCommand.target_character_ids,
        recoveryCommand.target_shot_ids,
      );
      if (invalidTargets.length) {
        send(409, {
          error: {
            code: "TARGET_NOT_FOUND",
            message: `target IDs no longer exist in project ${projectId}: ${invalidTargets.join(", ")}`,
            details: { project_id: projectId, target_ids: invalidTargets },
          },
        });
        return;
      }
      const started = startPipeline(
        runId,
        {
          projectId,
          runId,
          autoMode: recoveryCommand.auto_mode,
          userFeedback: recoveryCommand.user_feedback,
          startStage: recoveryCommand.stage === "full" ? undefined : recoveryCommand.stage,
          targetCharacterIds: recoveryCommand.target_character_ids.length
            ? recoveryCommand.target_character_ids
            : undefined,
          targetShotIds: recoveryCommand.target_shot_ids.length
            ? recoveryCommand.target_shot_ids
            : undefined,
          forceRegenerate: recoveryCommand.force_regenerate === true,
        },
        "resume",
        !hasCommand ? recoveryCommand as LegacyFullCommand : undefined,
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
      if (err instanceof InvalidJsonError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INVALID_JSON", message: err.message } }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  return { server, db, llm, shared, pipelines, ownerId };
}

function legacyFullCommand(
  db: EngineDatabase,
  runId: number,
): LegacyFullCommand | undefined {
  const row = db.db
    .prepare(
      "SELECT patch_plan, current_agent, resource_type, context_snapshot FROM agentrun WHERE id = ?",
    )
    .get(runId) as
    | {
        patch_plan: string | null;
        current_agent: string | null;
        resource_type: string | null;
        context_snapshot: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (row.context_snapshot === null) return undefined;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(row.context_snapshot);
  } catch {
    return undefined;
  }
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    Object.hasOwn(snapshot, "execution_command")
  ) return undefined;
  let started: unknown;
  let checkpoint: unknown;
  let hasUserMessage: unknown;
  try {
    started = db.db
      .prepare("SELECT 1 FROM engine_run_events WHERE run_id = ? LIMIT 1")
      .get(runId);
    checkpoint = db.db
      .prepare("SELECT 1 FROM engine_checkpoints WHERE run_id = ? LIMIT 1")
      .get(runId);
    hasUserMessage = db.db
      .prepare("SELECT 1 FROM agentmessage WHERE run_id = ? AND role = 'user' LIMIT 1")
      .get(runId);
  } catch {
    return undefined;
  }
  if (
    row.current_agent !== "orchestrator" ||
    row.resource_type !== null ||
    row.patch_plan !== null ||
    started ||
    checkpoint ||
    hasUserMessage
  ) return undefined;
  return {
    version: 1,
    stage: "full",
    auto_mode: false,
    user_feedback: "",
    target_character_ids: [],
    target_shot_ids: [],
  };
}

function persistRecoveredCommand(
  db: EngineDatabase,
  runId: number,
  leaseToken: string,
  command: NonNullable<ReturnType<typeof legacyFullCommand>>,
): void {
  db.transaction(() => {
    const row = db.db
      .prepare("SELECT context_snapshot FROM agentrun WHERE id = ? AND lease_token = ?")
      .get(runId, leaseToken) as { context_snapshot: string | null } | undefined;
    if (!row) throw new Error(`execution lease lost for run ${runId}`);
    const snapshot = parseJsonColumn(row.context_snapshot, {} as Record<string, unknown>);
    const existing = snapshot.execution_command;
    if (existing !== undefined && existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(command)) {
        throw new Error(`execution command changed during recovery for run ${runId}`);
      }
      return;
    }
    const result = db.db
      .prepare(
        `UPDATE agentrun SET context_snapshot = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND lease_token = ? AND lease_expires_at > datetime('now')
           AND cancel_requested_at IS NULL AND context_snapshot IS ?`,
      )
      .run(
        JSON.stringify({ ...snapshot, execution_command: command }),
        runId,
        leaseToken,
        row.context_snapshot,
      );
    if (result.changes !== 1) throw new Error(`execution lease lost for run ${runId}`);
  });
}

function invalidTargetIds(
  shared: SharedDb,
  projectId: number,
  characterIds: number[] | undefined,
  shotIds: number[] | undefined,
): number[] {
  const characters = new Set(shared.charactersForProject(projectId).map((row) => row.id));
  const shots = new Set(shared.shotsForProject(projectId).map((row) => row.id));
  return [
    ...(characterIds ?? []).filter((id) => !characters.has(id)),
    ...(shotIds ?? []).filter((id) => !shots.has(id)),
  ];
}

function isStageId(
  value: string,
): value is NonNullable<Parameters<PipelineRunner["run"]>[0]["startStage"]> {
  return (PRODUCTION_STAGE_SEQUENCE as readonly string[]).includes(value);
}

function isExecutionCommand(value: unknown): value is ExecutionCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const validIds = (ids: unknown): ids is number[] =>
    Array.isArray(ids) && ids.every((id) => Number.isSafeInteger(id) && id > 0);
  return (
    command.version === 1 &&
    typeof command.stage === "string" &&
    (command.stage === "full" || isStageId(command.stage)) &&
    typeof command.auto_mode === "boolean" &&
    typeof command.user_feedback === "string" &&
    (command.force_regenerate === undefined || typeof command.force_regenerate === "boolean") &&
    validIds(command.target_character_ids) &&
    validIds(command.target_shot_ids) &&
    new Set(command.target_character_ids).size === command.target_character_ids.length &&
    new Set(command.target_shot_ids).size === command.target_shot_ids.length &&
    !(command.target_character_ids.length && command.target_shot_ids.length) &&
    (!command.target_character_ids.length || command.stage === "render_characters") &&
    (!command.target_shot_ids.length ||
      command.stage === "render_shots" ||
      command.stage === "compose_videos") &&
    (!(command.target_character_ids.length || command.target_shot_ids.length) ||
      typeof command.force_regenerate === "boolean")
  );
}

class InvalidJsonError extends Error {}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(new InvalidJsonError(err instanceof Error ? err.message : "bad json"));
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
