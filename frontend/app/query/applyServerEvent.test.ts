import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Character, Project, Shot, WsEvent } from "~/types";
import { applyServerEvent } from "./applyServerEvent";
import { projectQueryKeys } from "./queryKeys";

function character(id: number): Character {
  return {
    id,
    project_id: 7,
    name: `角色 ${id}`,
    description: null,
    image_url: null,
    approval_state: "draft",
    approval_version: 0,
    approved_at: null,
    approved_name: null,
    approved_description: null,
    approved_image_url: null,
  };
}

function shot(id: number, order: number): Shot {
  return {
    id,
    project_id: 7,
    order,
    description: `shot ${order}`,
    prompt: null,
    image_prompt: null,
    image_url: null,
    video_url: null,
    duration: null,
    camera: null,
    motion_note: null,
    scene: null,
    action: null,
    expression: null,
    lighting: null,
    dialogue: null,
    sfx: null,
    seed: null,
    character_ids: [],
    approval_state: "draft",
    approval_version: 0,
    approved_at: null,
    approved_description: null,
    approved_prompt: null,
    approved_image_prompt: null,
    approved_duration: null,
    approved_camera: null,
    approved_motion_note: null,
    approved_scene: null,
    approved_action: null,
    approved_expression: null,
    approved_lighting: null,
    approved_dialogue: null,
    approved_sfx: null,
    approved_character_ids: [],
  };
}

function event(type: WsEvent["type"], data: Record<string, unknown>): WsEvent {
  return { type, data };
}

describe("applyServerEvent", () => {
  it("upserts and deletes character server state in TanStack Query", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.characters(7), [character(1)]);

    const updated = { ...character(1), name: "新名字" };
    applyServerEvent(client, 7, event("character_updated", { character: updated }));
    applyServerEvent(client, 7, event("character_created", { character: character(2) }));

    expect(client.getQueryData<Character[]>(projectQueryKeys.characters(7))).toEqual([
      updated,
      character(2),
    ]);

    applyServerEvent(client, 7, event("character_deleted", { character_id: 1 }));
    expect(client.getQueryData<Character[]>(projectQueryKeys.characters(7))).toEqual([
      character(2),
    ]);
  });

  it("reorders shot cache without touching UI store", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.shots(7), [shot(1, 1), shot(2, 2)]);

    applyServerEvent(
      client,
      7,
      event("shots_reordered", { project_id: 7, shots: [shot(2, 1), shot(1, 2)] }),
    );

    expect(
      client.getQueryData<Shot[]>(projectQueryKeys.shots(7))?.map((item) => item.id),
    ).toEqual([2, 1]);
  });

  it("patches project cache and clears generated entity projections", () => {
    const client = new QueryClient();
    const project = {
      id: 7,
      title: "P",
      story: null,
      style: "anime",
      summary: null,
      video_url: "/static/final.mp4",
      status: "ready",
      target_shot_count: null,
      character_hints: [],
      creation_mode: null,
      reference_images: [],
      exports: [],
      created_at: "",
      updated_at: "",
      provider_settings: {} as Project["provider_settings"],
    } satisfies Project;
    client.setQueryData(projectQueryKeys.project(7), project);
    client.setQueryData(projectQueryKeys.characters(7), [character(1)]);
    client.setQueryData(projectQueryKeys.shots(7), [shot(1, 1)]);

    applyServerEvent(
      client,
      7,
      event("project_updated", { project: { id: 7, title: "Renamed", status: "planning" } }),
    );
    expect(client.getQueryData<Project>(projectQueryKeys.project(7))).toMatchObject({
      title: "Renamed",
      status: "planning",
    });

    applyServerEvent(
      client,
      7,
      event("data_cleared", { cleared_types: ["characters", "shots"] }),
    );
    expect(client.getQueryData(projectQueryKeys.characters(7))).toEqual([]);
    expect(client.getQueryData(projectQueryKeys.shots(7))).toEqual([]);
    expect(client.getQueryData<Project>(projectQueryKeys.project(7))?.video_url).toBeNull();
  });

  it("projects the outline gate payload before project_updated lands", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.project(7), {
      id: 7,
      story_outline: null,
      visual_bible: null,
    } as Partial<Project>);

    applyServerEvent(
      client,
      7,
      event("run_awaiting_confirm", {
        agent: "outline",
        story_outline: { acts: [] },
        visual_bible: "bible",
      }),
    );

    expect(client.getQueryData<Project>(projectQueryKeys.project(7))).toMatchObject({
      story_outline: { acts: [] },
      visual_bible: "bible",
    });
  });

  it("keeps blocking clips in the project cache and clears them on terminal runs", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.project(7), { id: 7 } as Project);

    applyServerEvent(
      client,
      7,
      event("project_updated", {
        project: { id: 7, blocking_clips: [{}], status: "superseded" },
      }),
    );
    expect(client.getQueryData<Project>(projectQueryKeys.project(7))?.blocking_clips).toEqual([
      {},
    ]);

    for (const type of ["run_completed", "run_failed", "run_cancelled"] as const) {
      client.setQueryData(projectQueryKeys.project(7), ({ id: 7, blocking_clips: [{}] } as unknown) as Project);
      applyServerEvent(client, 7, event(type, {}));
      expect(
        client.getQueryData<Project>(projectQueryKeys.project(7))?.blocking_clips,
      ).toBeNull();
    }
  });

  it("applies audio_generated to the shot cache", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.shots(7), [shot(1, 1), shot(2, 2)]);

    applyServerEvent(
      client,
      7,
      event("audio_generated", {
        shot_id: 2,
        tts_url: "/static/audio/2.mp3",
        bgm_type: "warm",
      }),
    );

    const shots = client.getQueryData<Shot[]>(projectQueryKeys.shots(7)) ?? [];
    expect(shots.find((item) => item.id === 2)).toMatchObject({
      tts_url: "/static/audio/2.mp3",
      bgm_type: "warm",
    });
    expect(shots.find((item) => item.id === 1)?.tts_url).toBeUndefined();
  });
});
