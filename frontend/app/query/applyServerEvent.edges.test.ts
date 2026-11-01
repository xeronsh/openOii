import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Character, Project, Shot, WsEvent } from "~/types";
import { applyServerEvent } from "./applyServerEvent";
import { projectQueryKeys as keys } from "./queryKeys";

const P = 7;
const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data }) as unknown as WsEvent;
const shot = (id: number, order = id) => ({ id, project_id: P, order, tts_url: null, bgm_type: null }) as unknown as Shot;
const char = (id: number) => ({ id, project_id: P, name: `c${id}` }) as unknown as Character;

let qc: QueryClient;
let invalidated: unknown[][];

beforeEach(() => {
  qc = new QueryClient();
  invalidated = [];
  vi.spyOn(qc, "invalidateQueries").mockImplementation(async (filters) => {
    invalidated.push([...((filters as { queryKey: unknown[] }).queryKey ?? [])]);
  });
});

describe("applyServerEvent edges", () => {
  it("ignores entity events without their payload", () => {
    qc.setQueryData(keys.shots(P), [shot(1)]);
    qc.setQueryData(keys.characters(P), [char(1)]);
    for (const type of ["character_updated", "character_deleted", "shot_updated", "shot_deleted", "project_updated"]) {
      applyServerEvent(qc, P, ev(type));
    }
    applyServerEvent(qc, P, ev("shots_reordered", { shots: "nope" }));
    applyServerEvent(qc, P, ev("something_new", { x: 1 }));

    expect(qc.getQueryData(keys.shots(P))).toEqual([shot(1)]);
    expect(qc.getQueryData(keys.characters(P))).toEqual([char(1)]);
    expect(invalidated).toEqual([]);
  });

  it("does not invent a list that was never loaded", () => {
    applyServerEvent(qc, P, ev("shot_created", { shot: shot(1) }));
    expect(qc.getQueryData(keys.shots(P))).toBeUndefined();
  });

  it("appends new entities and removes deleted ones", () => {
    qc.setQueryData(keys.shots(P), [shot(1)]);
    applyServerEvent(qc, P, ev("shot_created", { shot: shot(2) }));
    applyServerEvent(qc, P, ev("shot_deleted", { shot_id: 1 }));
    expect(qc.getQueryData<Shot[]>(keys.shots(P))?.map((s) => s.id)).toEqual([2]);
  });

  it("reorders by order then id", () => {
    applyServerEvent(qc, P, ev("shots_reordered", { shots: [shot(3, 1), shot(2, 2), shot(1, 1)] }));
    expect(qc.getQueryData<Shot[]>(keys.shots(P))?.map((s) => s.id)).toEqual([1, 3, 2]);
  });

  it("a project update with no cached project refetches it", () => {
    applyServerEvent(qc, P, ev("project_updated", { project: { id: P, status: "ready" } }));
    expect(invalidated).toEqual([["project", P], ["projects"]]);
  });

  it("only the outline gate patches the project", () => {
    qc.setQueryData(keys.project(P), { id: P, visual_bible: "keep" } as unknown as Project);
    applyServerEvent(qc, P, ev("run_awaiting_confirm", { agent: "render" }));
    expect(qc.getQueryData<Project>(keys.project(P))?.visual_bible).toBe("keep");

    applyServerEvent(qc, P, ev("run_awaiting_confirm", { agent: "outline" }));
    expect(qc.getQueryData<Project>(keys.project(P))).toMatchObject({ story_outline: null, visual_bible: null });
  });

  it("outline_updated carries the approval flag", () => {
    qc.setQueryData(keys.project(P), { id: P } as unknown as Project);
    applyServerEvent(qc, P, ev("outline_updated", { story_outline: { logline: "x" }, outline_approved: true }));
    expect(qc.getQueryData<Project>(keys.project(P))).toMatchObject({
      story_outline: { logline: "x" },
      visual_bible: null,
      outline_approved: true,
    });
  });

  it("audio for an unknown or missing shot changes nothing; a partial update keeps the rest", () => {
    qc.setQueryData(keys.shots(P), [{ ...shot(1), tts_url: "/a.mp3", bgm_type: "calm" }]);
    applyServerEvent(qc, P, ev("audio_generated", { tts_url: "/x.mp3" }));
    applyServerEvent(qc, P, ev("audio_generated", { shot_id: 1, bgm_type: "tense" }));
    expect(qc.getQueryData<Shot[]>(keys.shots(P))?.[0]).toMatchObject({ tts_url: "/a.mp3", bgm_type: "tense" });
  });

  it("data_cleared empties only what was cleared and drops the cut", () => {
    qc.setQueryData(keys.shots(P), [shot(1)]);
    qc.setQueryData(keys.characters(P), [char(1)]);
    qc.setQueryData(keys.project(P), { id: P, video_url: "/v.mp4" } as unknown as Project);

    applyServerEvent(qc, P, ev("data_cleared", { cleared_types: ["shots"] }));

    expect(qc.getQueryData(keys.shots(P))).toEqual([]);
    expect(qc.getQueryData(keys.characters(P))).toEqual([char(1)]);
    expect(qc.getQueryData<Project>(keys.project(P))?.video_url).toBeNull();
  });

  it("a cancelled run also rereads the cast and shots; a failed one does not", () => {
    applyServerEvent(qc, P, ev("run_failed"));
    expect(invalidated).toEqual([["run-state", P], ["project", P], ["regenerate-plan", P]]);
    invalidated = [];
    applyServerEvent(qc, P, ev("run_cancelled"));
    expect(invalidated).toEqual([
      ["run-state", P],
      ["project", P],
      ["regenerate-plan", P],
      ["characters", P],
      ["shots", P],
    ]);
  });

  it("a rollback rereads the cast and shots", () => {
    applyServerEvent(qc, P, ev("version_rollback", { entity_type: "shot", entity_id: 1 }));
    expect(invalidated).toEqual([["characters", P], ["shots", P]]);
  });
});
