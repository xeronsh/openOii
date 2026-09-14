import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { ConcurrentModificationError, SharedDb } from "../src/shared-db.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

/**
 * The engine and the HTTP API both write project/character/shot. These tests
 * drive the engine side the way the pipeline does: a stage reads a revision,
 * another writer commits, and the engine's write must then fail instead of
 * silently overwriting the user's edit.
 */
describe("entity revision compare-and-set", () => {
  let dir: string;
  let path: string;
  let edb: EngineDatabase;
  let shared: SharedDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-revision-"));
    path = join(dir, "test.db");
    const raw = new SqliteDatabase(path);
    raw.exec(`
      CREATE TABLE agentrun (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL);
      CREATE TABLE project (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, story TEXT, style TEXT, summary TEXT, status TEXT, video_url TEXT,
        visual_bible TEXT, story_outline TEXT, outline_approved INTEGER DEFAULT 0,
        updated_at TEXT, created_at TEXT
      );
      CREATE TABLE character (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, image_url TEXT,
        reference_images TEXT, visual_notes TEXT, approval_version INTEGER DEFAULT 0
      );
      CREATE TABLE shot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL, "order" INTEGER NOT NULL, description TEXT,
        image_url TEXT, video_url TEXT, character_ids TEXT,
        approval_version INTEGER DEFAULT 0
      );
    `);
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
    raw.close();
    edb = new EngineDatabase(path);
    shared = new SharedDb(edb.db);
  });

  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("increments the revision on every successful write", () => {
    edb.db.prepare("INSERT INTO project (title, status) VALUES ('P', 'draft')").run();
    expect(shared.getProject(1)?.revision).toBe(1);

    shared.updateProject(1, { status: "ready" });
    expect(shared.getProject(1)?.revision).toBe(2);
  });

  it("rejects a project write based on a snapshot another writer replaced", () => {
    edb.db.prepare("INSERT INTO project (title, status) VALUES ('P', 'draft')").run();

    // The stage reads revision 1 and freezes it as its stage input.
    const frozen = shared.getProject(1)!;
    const stage = shared.withFrozenStageInput({
      project: frozen,
      characters: [],
      shots: [],
    });

    // The HTTP API commits a user edit first (revision 1 -> 2).
    edb.db.prepare("UPDATE project SET title = 'user edit', revision = 2 WHERE id = 1").run();

    expect(() => stage.updateProject(1, { status: "ready" })).toThrow(ConcurrentModificationError);
    expect(shared.getProject(1)?.title).toBe("user edit");
    expect(shared.getProject(1)?.status).toBe("draft");
  });

  it("rejects a character write based on a superseded snapshot", () => {
    edb.db
      .prepare("INSERT INTO character (project_id, name, description) VALUES (1, 'Mika', 'draft')")
      .run();
    const frozen = shared.getCharacter(1)!;
    const stage = shared.withFrozenStageInput({
      project: null,
      characters: [frozen],
      shots: [],
    });

    edb.db.prepare("UPDATE character SET description = 'user edit', revision = 2 WHERE id = 1").run();

    expect(() => stage.updateCharacter(1, { image_url: "/static/images/mika.png" })).toThrow(
      ConcurrentModificationError,
    );
    expect(shared.getCharacter(1)?.description).toBe("user edit");
    expect(shared.getCharacter(1)?.image_url).toBeNull();
  });

  it("rejects a shot write based on a superseded snapshot", () => {
    edb.db
      .prepare('INSERT INTO shot (project_id, "order", description) VALUES (1, 1, \'shot\')')
      .run();
    const frozen = shared.getShot(1)!;
    const stage = shared.withFrozenStageInput({
      project: null,
      characters: [],
      shots: [frozen],
    });

    edb.db.prepare("UPDATE shot SET description = 'user edit', revision = 5 WHERE id = 1").run();

    expect(() => stage.updateShot(1, { image_url: "/static/images/s.png" })).toThrow(
      ConcurrentModificationError,
    );
    expect(shared.getShot(1)?.description).toBe("user edit");
  });

  it("succeeds when the snapshot still owns the current revision", () => {
    edb.db
      .prepare("INSERT INTO character (project_id, name, description) VALUES (1, 'Mika', 'draft')")
      .run();
    const stage = shared.withFrozenStageInput({
      project: null,
      characters: [shared.getCharacter(1)!],
      shots: [],
    });

    stage.updateCharacter(1, { image_url: "/static/images/mika.png" });
    expect(shared.getCharacter(1)?.image_url).toBe("/static/images/mika.png");
    expect(shared.getCharacter(1)?.revision).toBe(2);
  });

  it("never lets a caller set the revision column directly", () => {
    edb.db.prepare("INSERT INTO project (title, status) VALUES ('P', 'draft')").run();
    shared.updateProject(1, { status: "ready", revision: 999 });
    expect(shared.getProject(1)?.revision).toBe(2);
  });
});
