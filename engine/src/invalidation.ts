import { parseJsonColumn, type SharedDb } from "./shared-db.js";

export interface InvalidationPlan {
  version: number;
  start_stage: string;
  checkpoint_from: string;
  scope: {
    entity_type: "character" | "shot" | null;
    entity_ids: number[];
  };
  invalidates: string[];
}

/**
 * Apply a backend-authored invalidation plan under the run's fencing lease.
 *
 * This function is intentionally synchronous and idempotent. The caller writes
 * a durable `__invalidation__` checkpoint after it returns; if the process dies
 * between the DB writes and that marker, the next executor may safely reapply
 * exactly the same NULL projections.
 */
export function applyInvalidationPlan(
  shared: SharedDb,
  projectId: number,
  plan: InvalidationPlan,
): void {
  if (plan.version !== 1) throw new Error(`unsupported invalidation plan version ${plan.version}`);

  const invalidates = new Set(plan.invalidates);
  const requestedIds = new Set(
    Array.isArray(plan.scope?.entity_ids)
      ? plan.scope.entity_ids.filter((id): id is number => Number.isInteger(id) && id > 0)
      : [],
  );
  const broadDefinitions =
    invalidates.has("characters.definitions") || invalidates.has("shots.definitions");

  const characters = shared.charactersForProject(projectId);
  const shots = shared.shotsForProject(projectId);

  const characterIds =
    !broadDefinitions && plan.scope?.entity_type === "character" && requestedIds.size > 0
      ? requestedIds
      : new Set(characters.map((item) => item.id));

  let shotIds: Set<number>;
  if (!broadDefinitions && plan.scope?.entity_type === "shot" && requestedIds.size > 0) {
    shotIds = requestedIds;
  } else if (
    !broadDefinitions &&
    plan.scope?.entity_type === "character" &&
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
    shared.updateProject(projectId, { video_url: null, status: "planning" });
  }
}
