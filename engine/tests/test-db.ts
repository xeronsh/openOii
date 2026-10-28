import type SqliteDatabase from "better-sqlite3";
import type { SharedDb } from "../src/shared-db.js";

/**
 * Test-only equivalent of the latest Alembic runtime schema.
 * Production code never creates schema from the engine process.
 */
export function installEngineRuntimeSchema(db: SqliteDatabase.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_run_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_engine_run_events_run
      ON engine_run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_engine_run_events_project
      ON engine_run_events(project_id, seq);

    CREATE TABLE IF NOT EXISTS engine_checkpoints (
      run_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (run_id, stage)
    );

    CREATE TABLE IF NOT EXISTS engine_stage_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_attempt_id TEXT NOT NULL UNIQUE,
      run_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      execution_attempt INTEGER NOT NULL DEFAULT 0,
      input_hash TEXT NOT NULL,
      input_snapshot TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      provider_request_id TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(run_id, stage, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_engine_stage_attempts_run_stage
      ON engine_stage_attempts(run_id, stage, attempt);
    CREATE INDEX IF NOT EXISTS idx_engine_stage_attempts_status
      ON engine_stage_attempts(status);

    -- Migration 0028: managed media registry.
    CREATE TABLE IF NOT EXISTS media_object (
      id TEXT PRIMARY KEY NOT NULL,
      namespace TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CONSTRAINT ck_media_object_namespace CHECK (namespace = 'managed-v1'),
      CONSTRAINT ck_media_object_relative_path CHECK (
        substr(relative_path, 1, 11) = 'managed-v1/'
        AND length(relative_path) > 11
        AND substr(relative_path, 12) <> '.'
        AND instr(substr(relative_path, 12), '/') = 0
        AND instr(relative_path, '..') = 0
        AND instr(relative_path, char(92)) = 0
      )
    );
    CREATE INDEX IF NOT EXISTS ix_media_object_namespace_created_at
      ON media_object (namespace, created_at);
  `);
}

/** Bring the historical app-schema fixture up to migration 0026. */
export function installExecutionLeaseColumns(db: SqliteDatabase.Database): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(agentrun)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const additions: Array<[string, string]> = [
    ["workflow_version", "INTEGER NOT NULL DEFAULT 1"],
    ["execution_attempt", "INTEGER NOT NULL DEFAULT 0"],
    ["lease_owner", "VARCHAR"],
    ["lease_token", "VARCHAR"],
    ["lease_expires_at", "DATETIME"],
    ["cancel_requested_at", "DATETIME"],
    ["context_snapshot", "JSON"],
  ];
  for (const [name, ddl] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE agentrun ADD COLUMN ${name} ${ddl}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS ix_agentrun_lease_token ON agentrun(lease_token)");

  // Migration 0026: optimistic concurrency on the product entities.
  for (const table of ["project", "character", "shot"]) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("revision")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
    }
  }
}

/**
 * Take the execution lease for a run the way the sidecar does before it starts a
 * runner, and return the fenced view. Production never hands an unfenced SharedDb
 * to a PipelineRunner, so tests must not either.
 */
export function leaseRun(shared: SharedDb, runId: number): SharedDb {
  const token = `test-lease-${runId}`;
  if (!shared.acquireRunLease(runId, "test-engine", token, 600)) {
    throw new Error(`test could not acquire the execution lease for run ${runId}`);
  }
  return shared.fenced(runId, token);
}
