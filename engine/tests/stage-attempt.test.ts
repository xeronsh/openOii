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
    const first = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 1,
    });

    // Process death after the provider request but before checkpoint/terminal
    // status. The stage had already mutated character/shot rows by then.
    const resumed = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 2,
    });

    expect(resumed.stage_attempt_id).toBe(first.stage_attempt_id);
    expect(resumed.idempotency_key).toBe(first.idempotency_key);
    expect(resumed.attempt).toBe(1);
    db.close();
  });

  it("keeps the original identity even though the stage mutated the database", () => {
    // Regression: identity used to be keyed on a hash recomputed from live
    // state, so a resume after partial writes created a SECOND attempt with a
    // new idempotency key and re-called the provider for one operation.
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt({
      runId: 7,
      stage: "render_characters",
      input: { characters: ["before"] },
      executionAttempt: 1,
    });

    // A resumed run now observes mutated state, so the recomputed input differs.
    const resumed = db.beginStageAttempt({
      runId: 7,
      stage: "render_characters",
      input: { characters: ["after"] },
      executionAttempt: 2,
    });

    expect(resumed.stage_attempt_id).toBe(first.stage_attempt_id);
    expect(resumed.idempotency_key).toBe(first.idempotency_key);
    expect(resumed.input_hash).toBe(first.input_hash);
    db.close();
  });

  it("freezes the stage input so a resume reads the same values", () => {
    const db = new EngineDatabase(path);
    const frozen = { characters: [{ id: 1, name: "Mika" }] };
    const first = db.beginStageAttempt({
      runId: 7,
      stage: "render_characters",
      input: frozen,
      executionAttempt: 1,
    });

    expect(db.stageAttemptInput(first.stage_attempt_id)).toEqual(frozen);

    // The second caller passes mutation-polluted state; identity is unchanged,
    // so the persisted snapshot keeps describing the operation that ran.
    db.beginStageAttempt({
      runId: 7,
      stage: "render_characters",
      input: { characters: [{ id: 1, name: "Mika (rewritten)" }] },
      executionAttempt: 2,
    });

    expect(db.stageAttemptInput(first.stage_attempt_id)).toEqual(frozen);
    db.close();
  });

  it("creates a new operation identity after an explicit terminal failure", () => {
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 1,
    });
    db.completeStageAttempt(first.stage_attempt_id, "failed", { error: "provider 503" });

    const retry = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 2,
    });

    expect(retry.attempt).toBe(2);
    expect(retry.stage_attempt_id).not.toBe(first.stage_attempt_id);
    expect(retry.idempotency_key).not.toBe(first.idempotency_key);
    db.close();
  });

  it("forces a new operation identity on explicit rerun", () => {
    const db = new EngineDatabase(path);
    const first = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 1,
    });

    const rerun = db.beginStageAttempt({
      runId: 7,
      stage: "render_shots",
      input: { shots: [] },
      executionAttempt: 1,
      forceNew: true,
    });

    expect(rerun.stage_attempt_id).not.toBe(first.stage_attempt_id);
    expect(rerun.idempotency_key).not.toBe(first.idempotency_key);
    db.close();
  });
});
