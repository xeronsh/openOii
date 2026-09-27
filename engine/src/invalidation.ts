import { STAGE_ORDER, type StageId } from "./contract.js";
import { parseJsonColumn, type SharedDb } from "./shared-db.js";

export interface RerunIntent {
  version: number;
  start_stage: string;
  scope: {
    entity_type: "character" | "shot" | null;
    entity_ids: number[];
  };
}

const FULL_CHAIN = [
  "project.outline",
  "characters.definitions",
  "characters.images",
  "shots.definitions",
  "shots.images",
  "shots.videos",
  "project.final_video",
];
const CHARACTER_PLAN = [
  "characters.definitions",
  "characters.images",
  "shots.definitions",
  "shots.images",
  "shots.videos",
  "project.final_video",
];
const SHOT_PLAN = ["shots.definitions", "shots.images", "shots.videos", "project.final_video"];
const CHARACTER_MEDIA = ["characters.images", "shots.images", "shots.videos", "project.final_video"];
const SHOT_MEDIA = ["shots.images", "shots.videos", "project.final_video"];

const INVALIDATES_BY_STAGE: Partial<Record<StageId, readonly string[]>> = {
  plan_outline: FULL_CHAIN,
  outline_approval: CHARACTER_PLAN,
  plan_characters: CHARACTER_PLAN,
  characters_approval: CHARACTER_PLAN,
  plan_shots: SHOT_PLAN,
  shots_approval: SHOT_PLAN,
  render_characters: CHARACTER_MEDIA,
  critique_character_images: CHARACTER_MEDIA,
  character_images_approval: SHOT_MEDIA,
  render_shots: SHOT_MEDIA,
  critique_shot_images: SHOT_MEDIA,
  shot_images_approval: ["shots.videos", "project.final_video"],
  compose_videos: ["shots.videos", "project.final_video"],
  compose_merge: ["project.final_video"],
  compose_approval: ["project.final_video"],
};

/** Apply Engine-owned invalidation rules under the run's fencing lease. */
export function applyInvalidationPlan(
  shared: SharedDb,
  projectId: number,
  intent: RerunIntent,
): StageId {
  if (intent.version !== 1) throw new Error(`unsupported rerun intent version ${intent.version}`);

  const stage = (STAGE_ORDER as readonly string[]).includes(intent.start_stage)
    ? (intent.start_stage as StageId)
    : "plan_outline";
  const invalidates = new Set(INVALIDATES_BY_STAGE[stage] ?? FULL_CHAIN);
  const requestedIds = new Set(
    Array.isArray(intent.scope?.entity_ids)
      ? intent.scope.entity_ids.filter((id): id is number => Number.isInteger(id) && id > 0)
      : [],
  );
  const broadDefinitions =
    invalidates.has("characters.definitions") || invalidates.has("shots.definitions");

  const characters = shared.charactersForProject(projectId);
  const shots = shared.shotsForProject(projectId);
  const characterIds =
    !broadDefinitions && intent.scope?.entity_type === "character" && requestedIds.size > 0
      ? requestedIds
      : new Set(characters.map((item) => item.id));

  let shotIds: Set<number>;
  if (!broadDefinitions && intent.scope?.entity_type === "shot" && requestedIds.size > 0) {
    shotIds = requestedIds;
  } else if (
    !broadDefinitions &&
    intent.scope?.entity_type === "character" &&
    requestedIds.size > 0
  ) {
    shotIds = new Set(
      shots
        .filter((shot) =>
          parseJsonColumn(shot.character_ids, [] as number[]).some((id) => requestedIds.has(id)),
        )
        .map((shot) => shot.id),
    );
  } else {
    shotIds = new Set(shots.map((item) => item.id));
  }

  if (invalidates.has("characters.images")) {
    for (const character of characters) {
      if (characterIds.has(character.id)) shared.updateCharacter(character.id, { image_url: null });
    }
  }

  const clearShotImages = invalidates.has("shots.images");
  const clearShotVideos = invalidates.has("shots.videos");
  if (clearShotImages || clearShotVideos) {
    for (const shot of shots) {
      if (!shotIds.has(shot.id)) continue;
      shared.updateShot(shot.id, {
        ...(clearShotImages ? { image_url: null } : {}),
        ...(clearShotVideos ? { video_url: null } : {}),
      });
    }
  }

  if (invalidates.has("project.final_video")) {
    const project = shared.getProject(projectId);
    shared.updateProject(projectId, {
      video_url: null,
      status: project?.video_url || project?.status === "superseded" ? "superseded" : "planning",
    });
  }
  return stage;
}
