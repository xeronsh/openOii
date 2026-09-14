import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { SharedDb } from "../src/shared-db.js";
import { PipelineEmitter } from "../src/pipeline/emitter.js";
import { installEngineRuntimeSchema, installExecutionLeaseColumns } from "./test-db.js";

/**
 * "DB = truth, event = notification". That only holds if the state write and
 * its durable event commit together: a crash in between would leave the
 * database new while no client ever receives the event, or the reverse.
 */
describe("atomic state + event commit", () => {
  let dir: string;
  let path: string;
  let edb: EngineDatabase;
  let shared: SharedDb;
  let emitter: PipelineEmitter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-atomic-"));
    path = join(dir, "test.db");
    const raw = new SqliteDatabase(path);
    raw.exec(`
      CREATE TABLE agentrun (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL);
      CREATE TABLE project (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, status TEXT, video_url TEXT, updated_at TEXT, created_at TEXT
      );
      CREATE TABLE character (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, image_url TEXT
      );
      CREATE TABLE shot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL, "order" INTEGER NOT NULL, description TEXT,
        image_url TEXT, video_url TEXT
      );
    `);
    installExecutionLeaseColumns(raw);
    installEngineRuntimeSchema(raw);
    raw.close();
    edb = new EngineDatabase(path);
    shared = new SharedDb(edb.db);
    emitter = new PipelineEmitter(edb, shared, 1, 1, {
      thinkingChainEnabled: false,
      thinkingDetailLevel: "normal",
    });
    edb.db.prepare("INSERT INTO character (project_id, name) VALUES (1, 'Mika')").run();
  });

  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("commits the state write and its event together", () => {
    emitter.commit("character_updated", () => {
      shared.updateCharacter(1, { image_url: "/static/images/mika.png" });
      return { character: { id: 1, image_url: "/static/images/mika.png" } };
    });

    expect(shared.getCharacter(1)?.image_url).toBe("/static/images/mika.png");
    const events = edb.eventsForRun(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("character_updated");
  });

  it("rolls the state write back when the event payload cannot be produced", () => {
    expect(() =>
      emitter.commit("character_updated", () => {
        shared.updateCharacter(1, { image_url: "/static/images/mika.png" });
        throw new Error("payload serialisation failed");
      }),
    ).toThrow(/payload serialisation failed/);

    // Neither half may survive: the write is rolled back with the event.
    expect(shared.getCharacter(1)?.image_url).toBeNull();
    expect(edb.eventsForRun(1)).toHaveLength(0);
  });

  it("rolls back both halves when the event append itself fails", () => {
    // A cancelled executor must not be able to mutate rows either.
    const noFence = new PipelineEmitter(edb, shared, 1, 1, {
      thinkingChainEnabled: false,
      thinkingDetailLevel: "normal",
    });
    edb.db.prepare("DROP TABLE engine_run_events").run();

    expect(() =>
      noFence.commit("character_updated", () => {
        shared.updateCharacter(1, { image_url: "/static/images/mika.png" });
        return { character: { id: 1 } };
      }),
    ).toThrow();

    expect(shared.getCharacter(1)?.image_url).toBeNull();
  });

  it("keeps the event sequence gapless when commits interleave", () => {
    emitter.commit("character_updated", () => {
      shared.updateCharacter(1, { image_url: "/a.png" });
      return { character: { id: 1, image_url: "/a.png" } };
    });
    emitter.commit("character_updated", () => {
      shared.updateCharacter(1, { image_url: "/b.png" });
      return { character: { id: 1, image_url: "/b.png" } };
    });

    const seqs = edb.eventsForRun(1).map((event) => event.seq);
    expect(seqs).toEqual([1, 2]);
    expect(shared.getCharacter(1)?.image_url).toBe("/b.png");
  });
});
