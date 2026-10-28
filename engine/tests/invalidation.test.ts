import { describe, expect, it, vi } from "vitest";
import { applyInvalidationPlan, type RerunIntent } from "../src/invalidation.js";
import type { SharedDb } from "../src/shared-db.js";

/**
 * Rerun intent only resolves the entry stage. Existing media stays visible until
 * the replacement commits, so resolving an intent must never clear artifacts.
 */
function fakeShared() {
  const updateCharacter = vi.fn();
  const updateShot = vi.fn();
  const updateProject = vi.fn();
  const shared = { updateCharacter, updateShot, updateProject } as unknown as SharedDb;
  return { shared, writes: [updateCharacter, updateShot, updateProject] };
}

function intent(overrides: Partial<RerunIntent> = {}): RerunIntent {
  return {
    version: 1,
    start_stage: "render_characters",
    scope: { entity_type: "character", entity_ids: [1] },
    ...overrides,
  };
}

describe("rerun intent resolution", () => {
  it("returns the requested stage without clearing existing media", () => {
    const { shared, writes } = fakeShared();

    expect(applyInvalidationPlan(shared, 99, intent())).toBe("render_characters");
    expect(
      applyInvalidationPlan(
        shared,
        99,
        intent({ start_stage: "render_shots", scope: { entity_type: "shot", entity_ids: [11] } }),
      ),
    ).toBe("render_shots");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("falls back to the first stage for an unknown stage", () => {
    const { shared, writes } = fakeShared();

    expect(applyInvalidationPlan(shared, 99, intent({ start_stage: "unknown" }))).toBe(
      "plan_outline",
    );
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("rejects an unsupported intent version", () => {
    const { shared } = fakeShared();

    expect(() => applyInvalidationPlan(shared, 99, intent({ version: 2 }))).toThrow(
      /unsupported rerun intent version 2/,
    );
  });
});
