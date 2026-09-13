/**
 * Engine-side SQLite access (better-sqlite3).
 *
 * The shared database schema is owned exclusively by backend Alembic. The
 * engine configures SQLite connection pragmas and validates the runtime tables,
 * but never CREATEs or ALTERs schema at startup.
 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface RunEventRow {
  seq: number;
  run_id: number;
  project_id: number;
  type: string;
  payload: string;
  created_at: string;
}

export interface StageAttemptRow {
  id: number;
  stage_attempt_id: string;
  run_id: number;
  stage: string;
  attempt: number;
  execution_attempt: number;
  input_hash: string;
  idempotency_key: string;
  status: "started" | "succeeded" | "failed" | "cancelled";
  provider_request_id: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
}

const REQUIRED_RUNTIME_TABLES = [
  "engine_run_events",
  "engine_checkpoints",
  "engine_stage_attempts",
] as const;

export class EngineDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.assertSchema();
  }

  private assertSchema(): void {
    const placeholders = REQUIRED_RUNTIME_TABLES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .all(...REQUIRED_RUNTIME_TABLES) as Array<{ name: string }>;
    const present = new Set(rows.map((row) => row.name));
    const missing = REQUIRED_RUNTIME_TABLES.filter((name) => !present.has(name));
    if (missing.length > 0) {
      this.db.close();
      throw new Error(
        `engine database schema is not migrated; missing ${missing.join(", ")}. ` +
          "Run backend Alembic migrations before starting the engine.",
      );
    }
  }

  appendEvent(runId: number, projectId: number, type: string, payload: unknown): number {
    const info = this.db
      .prepare(
        "INSERT INTO engine_run_events (run_id, project_id, type, payload) VALUES (?, ?, ?, ?)",
      )
      .run(runId, projectId, type, JSON.stringify(payload));
    return Number(info.lastInsertRowid);
  }

  eventsForRun(runId: number, afterSeq = 0): RunEventRow[] {
    return this.db
      .prepare(
        "SELECT seq, run_id, project_id, type, payload, created_at FROM engine_run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq) as RunEventRow[];
  }

  saveCheckpoint(runId: number, stage: string, state: unknown): void {
    this.db
      .prepare(
        `INSERT INTO engine_checkpoints (run_id, stage, state_json, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(run_id, stage) DO UPDATE SET state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(runId, stage, JSON.stringify(state));
  }

  latestCheckpoint(runId: number): { stage: string; state: unknown } | null {
    const row = this.db
      .prepare(
        "SELECT stage, state_json FROM engine_checkpoints WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(runId) as { stage: string; state_json: string } | undefined;
    if (!row) return null;
    return { stage: row.stage, state: JSON.parse(row.state_json) };
  }

  /**
   * Persist stage identity before side effects. An interrupted "started" row is
   * deliberately reused when the same input is resumed, keeping the same
   * idempotency key across at-least-once retries.
   */
  beginStageAttempt(
    runId: number,
    stage: string,
    inputHash: string,
    executionAttempt: number,
  ): StageAttemptRow {
    const interrupted = this.db
      .prepare(
        `SELECT * FROM engine_stage_attempts
         WHERE run_id = ? AND stage = ? AND input_hash = ? AND status = 'started'
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, stage, inputHash) as StageAttemptRow | undefined;
    if (interrupted) return interrupted;

    const latest = this.db
      .prepare(
        "SELECT COALESCE(MAX(attempt), 0) AS attempt FROM engine_stage_attempts WHERE run_id = ? AND stage = ?",
      )
      .get(runId, stage) as { attempt: number };
    const attempt = Number(latest.attempt ?? 0) + 1;
    const stageAttemptId = randomUUID();
    const idempotencyKey = createHash("sha256")
      .update(`${runId}:${stage}:${attempt}:${inputHash}`)
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO engine_stage_attempts
          (stage_attempt_id, run_id, stage, attempt, execution_attempt, input_hash,
           idempotency_key, status, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'started',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(
        stageAttemptId,
        runId,
        stage,
        attempt,
        executionAttempt,
        inputHash,
        idempotencyKey,
      );
    return this.stageAttemptById(stageAttemptId)!;
  }

  stageAttemptById(stageAttemptId: string): StageAttemptRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM engine_stage_attempts WHERE stage_attempt_id = ?")
        .get(stageAttemptId) as StageAttemptRow | undefined) ?? null
    );
  }

  completeStageAttempt(
    stageAttemptId: string,
    status: "succeeded" | "failed" | "cancelled",
    details: { providerRequestId?: string | null; result?: unknown; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE engine_stage_attempts
         SET status = ?, provider_request_id = COALESCE(?, provider_request_id),
             result_json = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE stage_attempt_id = ?`,
      )
      .run(
        status,
        details.providerRequestId ?? null,
        details.result === undefined ? null : JSON.stringify(details.result),
        details.error ?? null,
        stageAttemptId,
      );
  }

  /** Read a config value with DB > env > default precedence (mirrors the app). */
  configValue(key: string, envVar?: string): string | undefined;
  configValue(key: string, envVar: string | undefined, fallback: string): string;
  configValue(key: string, envVar?: string, fallback?: string): string | undefined {
    let row: { value: string } | undefined;
    try {
      row = this.db
        .prepare("SELECT value FROM configitem WHERE key = ?")
        .get(key) as { value: string } | undefined;
    } catch {
      row = undefined;
    }
    if (row && row.value !== "") return row.value;
    if (envVar) {
      const fromEnv = process.env[envVar];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    }
    return fallback;
  }

  close(): void {
    this.db.close();
  }
}
