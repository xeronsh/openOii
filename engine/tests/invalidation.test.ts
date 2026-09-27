import { describe, expect, it, vi } from "vitest";
import { applyInvalidationPlan, type RerunIntent } from "../src/invalidation.js";
import type { SharedDb } from "../src/shared-db.js";

function fakeShared() {
  const updateCharacter = vi.fn();
  const updateShot = vi.fn();
  const updateProject = vi.fn();
  const shared = {
    charactersForProject: () => [
      { id: 1 },
      { id: 2 },
    ],
    shotsForProject: () => [
      { id: 10, character_ids: "[1]" },
      { id: 11, character_ids: "[2]" },
      { id: 12, character_ids: "[1,2]" },
    ],
    getProject: () => ({ video_url: null, status: "draft" }),
    updateCharacter,
    updateShot,
    updateProject,
  } as unknown as SharedDb;
  return { shared, updateCharacter, updateShot, updateProject };
}

function intent(overrides: Partial<RerunIntent> = {}): RerunIntent {
  return {
    version: 1,
    start_stage: "render_characters",
    scope: { entity_type: "character", entity_ids: [1] },
    ...overrides,
  };
}

describe("Engine-owned invalidation policy", () => {
  it("scopes a character rerender to that character and dependent shots", () => {
    const { shared, updateCharacter, updateShot, updateProject } = fakeShared();

    applyInvalidationPlan(shared, 99, intent());

    expect(updateCharacter).toHaveBeenCalledTimes(1);
    expect(updateCharacter).toHaveBeenCalledWith(1, { image_url: null });
    expect(updateShot).toHaveBeenCalledTimes(2);
    expect(updateShot).toHaveBeenCalledWith(10, { image_url: null, video_url: null });
    expect(updateShot).toHaveBeenCalledWith(12, { image_url: null, video_url: null });
    expect(updateProject).toHaveBeenCalledWith(99, { video_url: null, status: "planning" });
  });

  it("scopes direct shot feedback to the selected shots", () => {
    const { shared, updateShot } = fakeShared();
    applyInvalidationPlan(
      shared,
      99,
      intent({
        start_stage: "render_shots",
        scope: { entity_type: "shot", entity_ids: [11] },
      }),
    );

    expect(updateShot).toHaveBeenCalledTimes(1);
    expect(updateShot).toHaveBeenCalledWith(11, { image_url: null, video_url: null });
  });

  it("promotes definition changes to broad downstream invalidation", () => {
    const { shared, updateCharacter, updateShot } = fakeShared();
    applyInvalidationPlan(
      shared,
      99,
      intent({
        start_stage: "plan_characters",
      }),
    );

    expect(updateCharacter).toHaveBeenCalledTimes(2);
    expect(updateShot).toHaveBeenCalledTimes(3);
  });

  it("falls back to a full invalidation for an unknown stage", () => {
    const { shared, updateCharacter, updateShot } = fakeShared();
    applyInvalidationPlan(
      shared,
      99,
      intent({ start_stage: "unknown" }),
    );

    expect(updateCharacter).toHaveBeenCalledTimes(2);
    expect(updateShot).toHaveBeenCalledTimes(3);
  });
});
