import type SqliteDatabase from "better-sqlite3";

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
  `);
}

/** Bring the historical app-schema fixture up to migration 0022. */
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
}
