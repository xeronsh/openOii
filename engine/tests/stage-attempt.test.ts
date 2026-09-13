import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { installEngineRuntimeSchema } from "./test-db.js";

describe("durable stage attempts", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-stage-attempt-"));
    path = join(dir, "test.db");
    const raw = new SqliteDatabase(path);
    installEngineRuntimeSchema(raw);
    raw.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses an interrupted operation identity for the same stage input", () => {
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt(7, "render_shots", "input-a", 1);

    // Simulate process death after the provider request but before either the
    // stage checkpoint or attempt terminal status was committed.
    const resumed = db.beginStageAttempt(7, "render_shots", "input-a", 2);

    expect(resumed.stage_attempt_id).toBe(first.stage_attempt_id);
    expect(resumed.idempotency_key).toBe(first.idempotency_key);
    expect(resumed.attempt).toBe(1);
    db.close();
  });

  it("creates a new operation identity after an explicit terminal failure", () => {
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt(7, "render_shots", "input-a", 1);
    db.completeStageAttempt(first.stage_attempt_id, "failed", { error: "provider 503" });

    const retry = db.beginStageAttempt(7, "render_shots", "input-a", 2);

    expect(retry.attempt).toBe(2);
    expect(retry.stage_attempt_id).not.toBe(first.stage_attempt_id);
    expect(retry.idempotency_key).not.toBe(first.idempotency_key);
    db.close();
  });

  it("does not reuse an interrupted identity when authoritative inputs changed", () => {
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt(7, "render_shots", "input-a", 1);
    const changed = db.beginStageAttempt(7, "render_shots", "input-b", 2);

    expect(changed.attempt).toBe(2);
    expect(changed.stage_attempt_id).not.toBe(first.stage_attempt_id);
    expect(changed.idempotency_key).not.toBe(first.idempotency_key);
    db.close();
  });
});
