/**
 * Style + character-quality prompt locks, ported from the Python render agent.
 *
 * These are the quality features that previously existed ONLY on the Python
 * side (`app/services/style_prompts.py`, `character_bible.py`, `agents/utils.py`).
 * ADR 0008 makes porting them a hard precondition for deleting the Python agent
 * implementations — deleting first would be a functional regression, not a
 * refactor.
 *
 * SQLite remains owned by backend Alembic (`styletemplate` is a product
 * table); this module only READS it.
 */
import type { EngineDatabase } from "./db.js";
import { parseJsonColumn, type CharacterRow, type ProjectRow } from "./shared-db.js";

const COMIC_NEGATIVE_LOCK =
  "photorealistic, hyperrealistic, live action, real footage, DSLR photo, 35mm photo, " +
  "documentary look, realistic skin pores, uncanny realistic face, 3D realistic render, " +
  "style drift, inconsistent outfit, changed character identity, extra characters";

/** Python: `CHARACTER_IDENTITY_LOCK` — reused verbatim for prompt parity. */
export const CHARACTER_IDENTITY_LOCK =
  "canonical character design sheet, stable face geometry, stable hairstyle, stable outfit, " +
  "stable color palette, clear full character identity, reusable reference for later panels";

/** Python: `SHOT_CONTINUITY_LOCK`. */
export const SHOT_CONTINUITY_LOCK =
  "use the provided character reference as identity anchor, preserve exact face, hairstyle, " +
  "outfit, body proportions, signature accessories, and character color palette, no redesign";

/**
 * Python keeps the comic lock in `_lock_prompt`; the literal is inlined here
 * because the engine must not diverge from the Python prompt text.
 */
const COMIC_STYLE_LOCK =
  "stylized 2D comic/anime frame, clean ink line art, cel shading or ink shading, " +
  "expressive manga faces, readable silhouettes, consistent character design, " +
  "coherent comic panel composition, non-photorealistic rendering";

/** Python: `BUILTIN_STYLE_PROMPTS` (identical keys and text). */
const BUILTIN_STYLE_PROMPTS: Record<string, string> = {
  anime:
    "anime comic style, 2D illustration, clean line art, cel shading, vibrant colors, " +
    "Japanese animation look",
  shonen:
    "shonen manga/anime style, bold ink lines, high contrast, dynamic composition, " +
    "dramatic cel-shaded lighting",
  "slice-of-life":
    "slice-of-life anime comic style, soft pastel colors, warm lighting, rounded lines, " +
    "cozy hand-drawn atmosphere",
  manga: "manga style, ink line art, halftone dots, speed lines, high contrast comic panels",
  donghua:
    "Chinese animation comic style, flowing ink lines, oriental color palette, " +
    "watercolor texture, stylized 2D rendering",
  cinematic:
    "cinematic anime comic style, storyboard keyframe, clean ink line art, cel shading, " +
    "dramatic lighting, filmic composition without photorealism",
  pixar:
    "3D cartoon style, rounded shapes, expressive stylized characters, colorful animation look",
  lowpoly:
    "low poly stylized animation, geometric shapes, faceted surfaces, minimalist palette",
  watercolor:
    "watercolor comic illustration, soft bleeding edges, transparent layering, " +
    "hand-painted 2D texture",
  sketch:
    "pencil sketch comic style, cross-hatching, monochrome shading, rough hand-drawn lines",
  realistic:
    "semi-realistic comic illustration, grounded proportions, clean line art, painted cel shading, " +
    "not photographic",
  "guofeng-manga":
    "guofeng manga, Chinese traditional art, fine ink lines, watercolor coloring, " +
    "classical oriental comic atmosphere",
  cyberpunk:
    "cyberpunk anime comic style, neon lights, dark urban atmosphere, rain-slicked streets, " +
    "holographic accents, clean line art",
  "fairy-tale":
    "fairy tale comic illustration, soft rounded shapes, warm colors, hand-painted texture, " +
    "dreamy storybook atmosphere",
};

/** Python: `_sanitize_photorealism` — keeps generated art from drifting to photos. */
const PHOTOREALISM_REPLACEMENTS: Record<string, string> = {
  photorealistic: "stylized comic",
  hyperrealistic: "stylized comic",
  "35mm film grain": "subtle comic texture",
  "35mm photo": "comic keyframe",
  "DSLR photo": "comic keyframe",
  "natural lighting": "stylized comic lighting",
  "shallow depth of field": "layered comic depth",
  "detailed textures": "clean illustrated textures",
  "real-world proportions": "grounded comic proportions",
};

export interface ResolvedStylePrompt {
  stylePrompt: string;
  negativePrompt: string;
}

function styleKey(style: string | null | undefined): string {
  // Python: `(style or "").strip().lower()` — it does NOT normalise separators.
  return (style ?? "").trim().toLowerCase();
}

function sanitizePhotorealism(prompt: string): string {
  let result = prompt;
  for (const [from, to] of Object.entries(PHOTOREALISM_REPLACEMENTS)) {
    result = result.split(from).join(to);
  }
  return result;
}

export function lockPrompt(base: string): string {
  const cleaned = sanitizePhotorealism(base.trim());
  // Python falls back to the anime prompt for an empty style (`_lock_prompt`).
  return `${cleaned || BUILTIN_STYLE_PROMPTS["anime"]!}, ${COMIC_STYLE_LOCK}`;
}

function mergeNegative(negative: string | null | undefined): string {
  if (!negative || !negative.trim()) return COMIC_NEGATIVE_LOCK;
  return `${negative.trim()}, ${COMIC_NEGATIVE_LOCK}`;
}

interface StyleTemplateRow {
  slug: string;
  style_prompt: string;
  negative_prompt: string | null;
  color_palette: string | null;
}

/**
 * Resolve the style prompt from built-ins, then the active `styletemplate` row —
 * the same precedence the Python service uses.
 */
export function resolveStylePrompt(
  db: EngineDatabase,
  style: string | null | undefined,
): ResolvedStylePrompt {
  const key = styleKey(style);
  const builtin = BUILTIN_STYLE_PROMPTS[key];
  if (builtin !== undefined) {
    return { stylePrompt: lockPrompt(builtin), negativePrompt: COMIC_NEGATIVE_LOCK };
  }

  if (key) {
    const template = readStyleTemplate(db, key);
    if (template) {
      return {
        stylePrompt: lockPrompt(withColorPalette(template.style_prompt, template.color_palette)),
        negativePrompt: mergeNegative(template.negative_prompt),
      };
    }
  }

  const fallback =
    typeof style === "string" && style.trim()
      ? style.trim()
      : BUILTIN_STYLE_PROMPTS["anime"]!;
  return { stylePrompt: lockPrompt(fallback), negativePrompt: COMIC_NEGATIVE_LOCK };
}

function readStyleTemplate(db: EngineDatabase, key: string): StyleTemplateRow | null {
  try {
    const row = db.db
      .prepare(
        "SELECT slug, style_prompt, negative_prompt, color_palette FROM styletemplate " +
          "WHERE slug = ? AND is_active = 1",
      )
      .get(key) as StyleTemplateRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function withColorPalette(prompt: string, colorPalette: string | null): string {
  if (!colorPalette) return prompt;
  const palette = parseJsonColumn<string[] | null>(colorPalette, null);
  if (!palette || palette.length === 0) return prompt;
  const colors = palette.join(", ");
  // Python: `f"{prompt}, {colors}"` — no label prefix.
  return colors ? `${prompt}, ${colors}` : prompt;
}

/**
 * Python: `build_character_bible` — merges description + visual notes into the
 * per-character bible text injected into shot prompts.
 */
export function buildCharacterBible(character: CharacterRow): string {
  const parts: string[] = [];
  if (character.description) parts.push(character.description);
  if (character.visual_notes) parts.push(`Visual notes: ${character.visual_notes}`);
  if (parts.length === 0) return character.name;
  return parts.join(" | ");
}

/**
 * Python: `agents/utils.build_character_context` —
 * `"Characters: Alice: red hair; Bob: tall"`.
 */
export function buildCharacterContext(characters: CharacterRow[]): string {
  if (characters.length === 0) return "";
  const descriptions = characters.map((character) =>
    character.description ? `${character.name}: ${character.description}` : character.name,
  );
  if (descriptions.length === 0) return "";
  return `Characters: ${descriptions.join("; ")}`;
}

/**
 * Python: `universe_style_appendix` — compact IP-universe style lock.
 * Reads the project's universe row directly; absent universe yields "".
 */
export function universeStyleAppendix(db: EngineDatabase, project: ProjectRow | null): string {
  if (!project) return "";
  const universeId = (project as unknown as { universe_id?: number | null }).universe_id;
  if (!universeId) return "";
  try {
    const row = db.db
      .prepare("SELECT name, style_rules, is_active FROM universe WHERE id = ?")
      .get(universeId) as
      | { name: string | null; style_rules: string | null; is_active: number | null }
      | undefined;
    if (!row || row.is_active === 0) return "";
    const parts: string[] = [];
    if (row.name) parts.push(`IP universe: ${row.name}`);
    if (row.style_rules && row.style_rules.trim()) {
      parts.push(`Universe style rules: ${row.style_rules.trim().slice(0, 400)}`);
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

/**
 * The character prompt the Python render agent builds:
 * `{desc}, {IDENTITY_LOCK}, {face_anchor}, {style}, {universe}, {feedback}`
 */
export function buildCharacterPrompt(args: {
  character: CharacterRow;
  style: ResolvedStylePrompt;
  universeStyle?: string;
  userFeedback?: string | null;
}): string {
  const { character, style, universeStyle, userFeedback } = args;
  let desc = character.description || character.name;
  if (character.visual_notes) desc = `${desc}, ${character.visual_notes}`;
  const faceAnchor = "detailed face, clear facial features, sharp eyes";
  let prompt = `${desc}, ${CHARACTER_IDENTITY_LOCK}, ${faceAnchor}, ${style.stylePrompt}`;
  if (universeStyle) prompt += `, ${universeStyle}`;
  const feedback = stripFocusPrefix(userFeedback);
  if (feedback) prompt += `, 用户反馈：${feedback}`;
  if (style.negativePrompt) prompt += ` || negative: ${style.negativePrompt}`;
  return prompt;
}

/**
 * The shot prompt the Python render agent builds: description, then each
 * character's bible text, then character context, continuity lock, style.
 */
export function buildShotPrompt(args: {
  shot: { image_prompt: string | null; description: string };
  characters: CharacterRow[];
  style: ResolvedStylePrompt;
  universeStyle?: string;
  userFeedback?: string | null;
}): string {
  const { shot, characters, style, universeStyle, userFeedback } = args;
  const parts: string[] = [(shot.image_prompt || shot.description).trim()];
  for (const character of characters) {
    const bible = buildCharacterBible(character);
    if (bible) parts.push(`Character ${character.name}: ${bible}`);
  }
  const charContext = buildCharacterContext(characters);
  if (charContext) parts.push(charContext);
  if (characters.length > 0) parts.push(SHOT_CONTINUITY_LOCK);
  parts.push(style.stylePrompt);
  if (universeStyle) parts.push(universeStyle);
  const feedback = stripFocusPrefix(userFeedback);
  if (feedback) parts.push(`用户反馈：${feedback}`);
  const prompt = parts.filter(Boolean).join(", ");
  return style.negativePrompt ? `${prompt} || negative: ${style.negativePrompt}` : prompt;
}

/** Python strips a leading `[focus:...]` marker before appending feedback. */
function stripFocusPrefix(userFeedback: string | null | undefined): string {
  if (!userFeedback || !userFeedback.trim()) return "";
  let feedback = userFeedback.trim();
  if (feedback.startsWith("[focus:")) {
    const closing = feedback.indexOf("] ");
    if (closing !== -1) feedback = feedback.slice(closing + 2).trim();
  }
  return feedback;
}

/**
 * Style context resolved once per run: the project style lock plus the IP
 * universe appendix. Read from the live project row at run start.
 */
export interface StageStyleContext {
  style: ResolvedStylePrompt;
  universeStyle: string;
}

export function resolveStageStyleContext(
  db: EngineDatabase,
  project: ProjectRow | null,
): StageStyleContext {
  const style = resolveStylePrompt(db, project?.style ?? null);
  return { style, universeStyle: universeStyleAppendix(db, project) };
}
