/**
 * Engine-side SQLite access (better-sqlite3).
 *
 * Shares the app's SQLite file with the Python backend (WAL). The engine owns
 * two tables: run_events (WS-bridge source of truth) and checkpoints (gate
 * snapshots). Schema-compatible domain tables (projects/agentrun/...) are
 * read/written by the pipeline layer.
 */
import Database from "better-sqlite3";
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

export class EngineDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engine_run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_engine_run_events_run ON engine_run_events(run_id, seq);
      CREATE TABLE IF NOT EXISTS engine_checkpoints (
        run_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (run_id, stage)
      );
    `);
  }

  appendEvent(runId: number, projectId: number, type: string, payload: unknown): number {
    const stmt = this.db.prepare(
      "INSERT INTO engine_run_events (run_id, project_id, type, payload) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(runId, projectId, type, JSON.stringify(payload));
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
      // standalone engine DB without the app's configitem table
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
