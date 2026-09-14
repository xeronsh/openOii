import { describe, expect, it } from "vitest";
import {
  CHARACTER_IDENTITY_LOCK,
  SHOT_CONTINUITY_LOCK,
  buildCharacterBible,
  buildCharacterContext,
  buildCharacterPrompt,
  buildShotPrompt,
  resolveStylePrompt,
} from "../src/style.js";
import type { CharacterRow, ShotRow } from "../src/shared-db.js";

/**
 * These locks are the quality features that used to exist ONLY in the Python
 * render agent. Porting them is the hard precondition for deleting that agent
 * (ADR 0008), so the ported semantics are asserted here.
 */
function character(overrides: Partial<CharacterRow> = {}): CharacterRow {
  return {
    id: 1,
    project_id: 1,
    name: "Mika",
    description: "A cautious creator",
    image_url: null,
    reference_images: null,
    visual_notes: "short black hair, red scarf",
    approved_name: null,
    approved_description: null,
    approved_image_url: null,
    approved_at: null,
    approval_version: 0,
    revision: 1,
    ...overrides,
  };
}

function shot(overrides: Partial<ShotRow> = {}): ShotRow {
  return {
    id: 5,
    project_id: 1,
    order: 1,
    description: "Opening shot at dawn",
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
    tts_url: null,
    bgm_type: null,
    seed: null,
    character_ids: null,
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
    approved_character_ids: null,
    approved_at: null,
    approval_version: 0,
    revision: 1,
    ...overrides,
  };
}

/** Minimal fake: resolveStylePrompt only needs `db.db.prepare(...).get(...)`. */
function fakeDb(rows: { styleTemplate?: unknown; universe?: unknown } = {}) {
  return {
    db: {
      prepare(sql: string) {
        return {
          get() {
            if (sql.includes("styletemplate")) return rows.styleTemplate ?? undefined;
            if (sql.includes("universe")) return rows.universe ?? undefined;
            return undefined;
          },
        };
      },
    },
  } as never;
}

describe("style prompt resolution", () => {
  it("uses the builtin prompt for a known style and appends the comic lock", () => {
    const resolved = resolveStylePrompt(fakeDb(), "anime");
    expect(resolved.stylePrompt).toContain("anime comic style");
    expect(resolved.stylePrompt).toContain("non-photorealistic rendering");
    expect(resolved.negativePrompt).toContain("photorealistic");
  });

  it("strips photorealism words so generated art does not drift to photos", () => {
    const resolved = resolveStylePrompt(fakeDb(), "photorealistic");
    // The user's style token was rewritten before the comic lock was appended;
    // "non-photorealistic rendering" in the lock itself is expected.
    expect(resolved.stylePrompt.startsWith("stylized comic,")).toBe(true);
    expect(resolved.stylePrompt).not.toMatch(/^photorealistic/);
  });

  it("falls back to the anime prompt for an empty style", () => {
    const resolved = resolveStylePrompt(fakeDb(), null);
    expect(resolved.stylePrompt).toContain("anime comic style");
  });

  it("prefers an active style template row and merges its palette", () => {
    const resolved = resolveStylePrompt(
      fakeDb({
        styleTemplate: {
          slug: "noir",
          style_prompt: "high contrast noir ink",
          negative_prompt: "washed out",
          color_palette: JSON.stringify(["#111", "#eee"]),
        },
      }),
      "noir",
    );
    expect(resolved.stylePrompt).toContain("high contrast noir ink");
    expect(resolved.stylePrompt).toContain("#111, #eee");
    expect(resolved.negativePrompt).toContain("washed out");
    expect(resolved.negativePrompt).toContain("photorealistic");
  });
});

describe("character quality prompts", () => {
  it("builds the identity lock + face anchor + style character prompt", () => {
    const style = resolveStylePrompt(fakeDb(), "anime");
    const prompt = buildCharacterPrompt({ character: character(), style });

    expect(prompt).toContain(CHARACTER_IDENTITY_LOCK);
    expect(prompt).toContain("detailed face, clear facial features, sharp eyes");
    expect(prompt).toContain("A cautious creator, short black hair, red scarf");
    expect(prompt).toContain("anime comic style");
    expect(prompt).toContain("|| negative:");
  });

  it("appends user feedback after stripping the internal focus marker", () => {
    const style = resolveStylePrompt(fakeDb(), "anime");
    const prompt = buildCharacterPrompt({
      character: character(),
      style,
      userFeedback: "[focus:character:1] make the scarf blue",
    });
    expect(prompt).toContain("用户反馈：make the scarf blue");
    expect(prompt).not.toContain("[focus:");
  });

  it("includes the universe style appendix when present", () => {
    const style = resolveStylePrompt(fakeDb(), "anime");
    const prompt = buildCharacterPrompt({
      character: character(),
      style,
      universeStyle: "IP universe: Neon",
    });
    expect(prompt).toContain("IP universe: Neon");
  });

  it("merges description and visual notes into the character bible", () => {
    expect(buildCharacterBible(character())).toBe(
      "A cautious creator | Visual notes: short black hair, red scarf",
    );
    expect(buildCharacterBible(character({ description: null, visual_notes: null }))).toBe("Mika");
  });

  it("formats the character context list like the Python helper", () => {
    expect(buildCharacterContext([character()])).toBe(
      "Characters: Mika: A cautious creator",
    );
    expect(buildCharacterContext([])).toBe("");
  });

  it("builds the shot prompt with bible, continuity lock and style", () => {
    const style = resolveStylePrompt(fakeDb(), "anime");
    const prompt = buildShotPrompt({
      shot: shot(),
      characters: [character()],
      style,
    });

    expect(prompt).toContain("Opening shot at dawn");
    expect(prompt).toContain("Character Mika: A cautious creator");
    expect(prompt).toContain("Characters: Mika: A cautious creator");
    expect(prompt).toContain(SHOT_CONTINUITY_LOCK);
    expect(prompt).toContain("anime comic style");
  });

  it("omits the continuity lock when no character is bound to the shot", () => {
    const style = resolveStylePrompt(fakeDb(), "anime");
    const prompt = buildShotPrompt({ shot: shot(), characters: [], style });
    expect(prompt).not.toContain(SHOT_CONTINUITY_LOCK);
    expect(prompt).toContain("Opening shot at dawn");
  });
});
