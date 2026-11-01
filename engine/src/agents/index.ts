/**
 * Pipeline stage implementations (outline / plan / render / critic / compose).
 *
 * Each stage mutates the shared DB and emits contract events through the
 * PipelineEmitter. LLM text flows through the prompts in prompts.ts.
 */
import { PROMPTS } from "../prompts.js";
import type { PipelineEmitter } from "../pipeline/emitter.js";
import {
  parseJsonColumn,
  SharedDb,
  characterReadPayload,
  shotReadPayload,
  type CharacterRow,
  type ShotRow,
} from "../shared-db.js";
import {
  DEFAULT_MAX_TOKENS,
  type LlmImageInput,
  type LlmRequest,
  type TextLlmService,
} from "../llm.js";
import { normalizeVideoDuration, sniffImageMime, type MediaService } from "../media/media.js";
import type { MediaSettings } from "../media/media.js";
import { estimatedSpeechSeconds, type SubtitleSegment } from "../media/subtitles.js";
import {
  buildCharacterPrompt,
  buildShotPrompt,
  buildVideoPrompt,
  videoNegativePrompt,
  VIDEO_STYLE_FRONT_LOCK,
  type ResolvedStylePrompt,
} from "../style.js";
import type { AiOperation } from "../ai-operation.js";
import { BackendWorker } from "../backend-worker.js";
import { progressForStage, type StageId } from "../contract.js";

export function targetCheckpointStage(
  kind: "character_image" | "shot_image" | "shot_video",
  id: number,
): string {
  return `target:${kind}:${id}`;
}

export interface CompletionInfo {
  completed: string;
  details: string;
  next: string;
  question: string;
}

export interface StageContext {
  shared: SharedDb;
  emitter: PipelineEmitter;
  llm: TextLlmService;
  media: MediaService;
  mediaSettings: MediaSettings;
  projectId: number;
  runId: number;
  userFeedback: string;
  /** Run cancellation signal; every provider call must observe it. */
  signal: AbortSignal;
  /** Entity scope for this run; absent means all entities in the project. */
  targetCharacterIds?: number[];
  targetShotIds?: number[];
  forceCharacterRedraw?: boolean;
  completedTargets: Set<string>;
  checkpointTarget: (kind: "character_image" | "shot_image" | "shot_video", id: number) => void;
  /**
   * Operation identity for the stage attempt currently running. Text, image and
   * video all read identity, deadline and cancellation from this one object.
   */
  operation?: AiOperation | null;
  /**
   * Style locks + character-quality prompts ported from the Python render
   * agent (ADR 0008 precondition). Resolved once per run from the project
   * style and its universe.
   */
  style: ResolvedStylePrompt | null;
  universeStyle: string;
  critiqueRounds: { characters: number; shots: number };
  critiqueEnabled: boolean;
  critiqueScoreThreshold: number;
  critiqueMaxRounds: number;
  /** Set by agents when a stage completes (mirrors Python completion_info). */
  completionInfo: CompletionInfo | null;
  /** Whether the previous critique decided to regenerate (route handling). */
  willRegenerate: boolean;
  /** Why the critic rejected a shot's keyframe; folded into its next render. */
  critiqueNotes?: Map<number, string>;
  /** Production stage being run; live LLM output advances its progress. */
  stage?: StageId;
}

export function extractJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = (fenced ? (fenced[1] ?? trimmed) : trimmed).trim();
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    // find the outermost JSON object like app.agents.utils.extract_json
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
    return {};
  }
}

interface CallLlmOptions {
  validate?: LlmRequest["validate"];
  images?: LlmImageInput[];
}

async function callLlm(
  ctx: StageContext,
  agent: string,
  system: string,
  prompt: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  options: CallLlmOptions = {},
): Promise<Record<string, unknown>> {
  const stage = ctx.stage;
  // Rough within-stage estimate from output length; the client only moves it forward.
  const live = ctx.emitter.llmStream(
    agent,
    stage ? (chars) => progressForStage(stage, Math.min(0.9, chars / (maxTokens * 1.5))) : undefined,
  );
  let res: Awaited<ReturnType<typeof ctx.llm.generate>>;
  try {
    res = await ctx.llm.generate({
      system,
      prompt,
      maxTokens,
      signal: ctx.signal,
      operation: ctx.operation ?? undefined,
      onStream: live.update,
      validate: options.validate,
      images: options.images,
    });
  } catch (error) {
    // A cancelled run is cleared by run_cancelled; only real failures show.
    if (!ctx.signal?.aborted) {
      try {
        live.end("error", error instanceof Error ? error.message : String(error));
      } catch {
        // lost the execution fence; the original error is what matters
      }
    }
    throw error;
  }
  live.end("done");
  ctx.shared.insertAgentMessage(ctx.runId, agent, "assistant", res.text);
  return extractJson(res.text);
}

// ---------------------------------------------------------------------------
// Structured output shapes (checked before a repair is accepted)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const OUTPUT_SHAPES = {
  outline: (data: Record<string, unknown>): string | null =>
    isRecord(data.story_outline) ? null : "expected a story_outline object",
  planCharacters: (data: Record<string, unknown>): string | null =>
    Array.isArray(data.characters) || isRecord(data.preserve_ids)
      ? null
      : "expected a characters array",
  planShots: (data: Record<string, unknown>): string | null =>
    Array.isArray(data.shots) || isRecord(data.preserve_ids) ? null : "expected a shots array",
  visualNotes: (data: Record<string, unknown>): string | null =>
    typeof data.visual_notes === "string" ? null : "expected a visual_notes string",
  /** A critic may decline to score; a score it does give has to be a 0–10 number. */
  critique: (data: Record<string, unknown>): string | null => {
    const raw = data.score ?? data.total_score;
    if (raw === undefined || raw === null) return null;
    return critiqueScore(data) === null ? "score must be a number between 0 and 10" : null;
  },
};

/** The critic's 0–10 verdict, or null when it gave none (never a silent 0). */
export function critiqueScore(data: Record<string, unknown>): number | null {
  const raw = data.score ?? data.total_score;
  if (raw === undefined || raw === null || raw === "") return null;
  const score = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
}

// ---------------------------------------------------------------------------
// Outline agent (outline.py port)
// ---------------------------------------------------------------------------

interface OutlineAct {
  act: number;
  title: string;
  summary: string;
}

export interface CleanOutline {
  logline: string;
  genre: string[];
  themes: string[];
  setting: string;
  tone: string;
  acts: OutlineAct[];
  emotional_arc: string;
}

export function cleanOutline(data: Record<string, unknown>): CleanOutline {
  const raw = (data.story_outline ?? {}) as Record<string, unknown>;
  const actsRaw = Array.isArray(raw.acts) ? raw.acts : [];
  const normalizedActs: OutlineAct[] = [];
  actsRaw.slice(0, 3).forEach((item, idx) => {
    if (typeof item !== "object" || item === null) return;
    const act = item as Record<string, unknown>;
    normalizedActs.push({
      act: typeof act.act === "number" ? act.act : idx + 1,
      title: String(act.title ?? `第${idx + 1}幕`),
      summary: String(act.summary ?? ""),
    });
  });
  return {
    logline: String(raw.logline ?? ""),
    genre: (Array.isArray(raw.genre) ? raw.genre : []).filter((x): x is string => typeof x === "string"),
    themes: (Array.isArray(raw.themes) ? raw.themes : []).filter((x): x is string => typeof x === "string"),
    setting: String(raw.setting ?? ""),
    tone: String(raw.tone ?? ""),
    acts: normalizedActs,
    emotional_arc: String(raw.emotional_arc ?? ""),
  };
}

export async function runOutline(ctx: StageContext): Promise<void> {
  await ctx.emitter.sendMessage("outline", "正在生成故事大纲…", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("outline", "planning", "正在提炼故事核心、三幕结构和视觉方向…");

  const project = ctx.shared.getProject(ctx.projectId);
  if (!project) throw new Error(`project ${ctx.projectId} not found`);

  const payload: Record<string, unknown> = {
    project: {
      id: project.id,
      title: project.title,
      story: project.story,
      style: project.style,
      skill_id: project.skill_id ?? null,
      target_shot_count: project.target_shot_count ?? null,
    },
  };
  if (ctx.userFeedback) payload.user_feedback = ctx.userFeedback;

  const system = PROMPTS["outline.SYSTEM_PROMPT"];
  const data = await callLlm(ctx, "outline", system, JSON.stringify(payload), 2048, {
    validate: OUTPUT_SHAPES.outline,
  });

  const outline = cleanOutline(data);
  const visualBible = typeof data.visual_bible === "string" ? data.visual_bible : "";
  const userMessage = typeof data.user_message === "string" ? data.user_message : "";
  const projectUpdate =
    typeof data.project_update === "object" && data.project_update !== null
      ? (data.project_update as Record<string, unknown>)
      : {};

  const updatedFields: Record<string, unknown> = {
    story_outline: outline as unknown,
    visual_bible: visualBible.trim() || null,
    outline_approved: 0,
  };
  for (const key of ["title", "summary"] as const) {
    const value = projectUpdate[key];
    if (typeof value === "string" && value.trim()) {
      updatedFields[key] = value.trim();
    }
  }
  const current = ctx.shared.getProject(ctx.projectId);
  if (current && !current.summary && outline.logline) updatedFields.summary = outline.logline;
  updatedFields.status = "planning";
  ctx.emitter.commit("project_updated", () => {
    ctx.shared.updateProject(ctx.projectId, updatedFields);
    ctx.emitter.projectUpdated(updatedFields);
    return null;
  });

  await ctx.emitter.sendThinking(
    "outline",
    "decision",
    `大纲已形成：${outline.logline.slice(0, 80)}`,
    `三幕数量：${outline.acts.length}，风格：${current?.style ?? "未指定"}`,
  );
  ctx.completionInfo = {
    completed: userMessage || "故事大纲已生成",
    details: `一句话故事：${outline.logline || "已完成"}`,
    next: "确认后将进入角色设计",
    question: "大纲方向是否满意？",
  };
  await ctx.emitter.sendMessage(
    "outline",
    userMessage || outline.logline || "大纲已生成",
    { summary: outline.logline || "故事大纲", progress: 1 },
  );
}

// ---------------------------------------------------------------------------
// Plan agent (plan.py port: characters + shots)
// ---------------------------------------------------------------------------

interface PlanCharacter {
  id?: number;
  name: string;
  description?: string;
  visual_notes?: string;
}

interface PlanShot {
  id?: number;
  scene?: string;
  description?: string;
  action?: string;
  expression?: string;
  camera?: string;
  lighting?: string;
  dialogue?: string;
  sfx?: string;
  motion_note?: string;
  duration?: number;
  character_names?: string[];
  /** Characters actually visible in the frame; `[]` means nobody is. */
  characters_in_frame?: string[];
  /** Visible end state (prop counts, levels, positions) the next shot starts from. */
  continuity?: string;
  /** The shot's opening frame (the previous end state), for the keyframe. */
  image_prompt?: string;
  /** Start-to-end motion of this one shot, for the clip. */
  video_prompt?: string;
}

function planBasePayload(ctx: StageContext, task: "characters" | "shots"): Record<string, unknown> {
  const project = ctx.shared.getProject(ctx.projectId);
  if (!project) throw new Error("project missing");
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const shots = ctx.shared.shotsForProject(ctx.projectId);
  return {
    project: {
      id: project.id,
      title: project.title,
      story: project.story,
      style: project.style,
      status: project.status,
      summary: project.summary,
      target_shot_count: project.target_shot_count ?? null,
      character_hints: parseJsonColumn(project.character_hints, [] as string[]),
      skill_id: project.skill_id ?? null,
    },
    task,
    mode: "full",
    approved_outline: parseJsonColumn(project.story_outline, null as unknown),
    approved_characters: characters.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    existing_state: {
      characters: characters.map((c) => ({ id: c.id, name: c.name, description: c.description })),
      shots: shots.map((s) => ({ id: s.id, order: s.order, description: s.description })),
    },
    ...(ctx.userFeedback ? { user_feedback: ctx.userFeedback } : {}),
  };
}

export async function runPlanCharacters(ctx: StageContext): Promise<void> {
  await ctx.emitter.sendMessage("plan", "正在规划角色设定…", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("plan", "planning", "正在设计角色设定与人物关系…");

  const payload = planBasePayload(ctx, "characters");
  const data = await callLlm(ctx, "plan", PROMPTS["plan.SYSTEM_PROMPT"], JSON.stringify(payload), 4096, {
    validate: OUTPUT_SHAPES.planCharacters,
  });
  await applyCharacterPlan(ctx, data);

  await ctx.emitter.sendThinking("plan", "decision", "角色设定完成，等待分镜脚本…");
  ctx.completionInfo = {
    completed: "角色设定已生成",
    details: "共 3 个角色",
    next: "接下来生成分镜脚本",
    question: "角色设定是否满意？",
  };
}

export async function runPlanShots(ctx: StageContext): Promise<void> {
  await ctx.emitter.sendMessage("plan", "正在生成分镜脚本…", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("plan", "planning", "正在分镜与节奏设计…");

  const payload = planBasePayload(ctx, "shots");
  const data = await callLlm(ctx, "plan", PROMPTS["plan.SYSTEM_PROMPT"], JSON.stringify(payload), 4096, {
    validate: OUTPUT_SHAPES.planShots,
  });
  await applyShotPlan(ctx, data);

  await ctx.emitter.sendThinking("plan", "decision", "分镜脚本完成…");
  ctx.completionInfo = {
    completed: "分镜脚本已生成",
    details: "分镜与节奏已确定",
    next: "确认后进入渲染阶段",
    question: "分镜是否符合预期？",
  };
}

async function applyCharacterPlan(ctx: StageContext, data: Record<string, unknown>): Promise<void> {
  ctx.emitter.commit("character_updated", () => {
  const rawCharacters = Array.isArray(data.characters) ? data.characters : [];
  const preserve = (data.preserve_ids as { characters?: number[] } | undefined)?.characters ?? [];

  // delete characters not preserved/mentioned
  const mentionedIds = new Set<number>(
    rawCharacters
      .map((c) => (typeof c === "object" && c !== null ? (c as PlanCharacter).id : undefined))
      .filter((x): x is number => typeof x === "number"),
  );
  for (const existing of ctx.shared.charactersForProject(ctx.projectId)) {
    if (mentionedIds.has(existing.id)) continue;
    if (preserve.includes(existing.id)) continue;
    ctx.shared.deleteCharacter(existing.id);
    ctx.emitter.characterDeleted(existing.id);
  }

  for (const item of rawCharacters) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as PlanCharacter;
    if (!c.name || !c.name.trim()) continue;
    if (c.id === undefined || c.id === null) {
      const id = ctx.shared.insertCharacter(
        ctx.projectId,
        c.name.trim(),
        c.description ?? null,
        c.visual_notes ?? null,
      );
      const row = ctx.shared.getCharacter(id);
      if (row) ctx.emitter.characterCreated(characterReadPayload(row));
    } else {
      const existing = ctx.shared.getCharacter(c.id);
      if (!existing || existing.project_id !== ctx.projectId) continue;
      const version = ctx.shared.createVersion(ctx.projectId, "character", existing.id, existing, ctx.runId, "generation");
      ctx.emitter.versionCreated("character", existing.id, version, "generation");
      ctx.shared.updateCharacter(existing.id, {
        name: c.name.trim(),
        description: c.description ?? existing.description,
        visual_notes: c.visual_notes ?? existing.visual_notes,
      });
      const updated = ctx.shared.getCharacter(existing.id);
      if (updated) ctx.emitter.characterUpdated(characterReadPayload(updated));
    }
  }
  return null;
  });
}

function nextVersion(ctx: StageContext, entityType: "character" | "shot", entityId: number): number {
  const q = ctx.shared as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => { v: number | null } | undefined } } };
  const row = q.db
    .prepare("SELECT MAX(version) AS v FROM artifactversion WHERE entity_type = ? AND entity_id = ?")
    .get(entityType, entityId);
  return (row?.v ?? 0) + 1;
}

/**
 * 把一格分镜绑定到角色。模型给的 character_names 常和角色名差一点（多了空格、
 * 「老渔夫陈望海」这种带称呼的写法），或者干脆漏填；精确匹配不到时退回到
 * 包含匹配，再退回到在画面描述 / 动作 / 台词里找角色名。
 */
export function bindShotCharacters(
  shot: Pick<PlanShot, "character_names" | "characters_in_frame" | "description" | "action" | "dialogue">,
  characters: ReadonlyArray<{ id: number; name: string }>,
): number[] {
  const named = characters.filter((c) => c.name.trim().length > 0);
  const ids = new Set<number>();
  // characters_in_frame is the planner's explicit answer to "who is visible";
  // an empty list means nobody, so a name mentioned in the text (someone
  // missed or searched for) must not pull that character's reference in.
  const inFrame = Array.isArray(shot.characters_in_frame) ? shot.characters_in_frame : null;
  for (const raw of inFrame ?? shot.character_names ?? []) {
    const n = typeof raw === "string" ? raw.trim() : "";
    if (!n) continue;
    const exact = named.find((c) => c.name.trim() === n);
    const loose = exact ?? named.find((c) => n.includes(c.name.trim()) || c.name.trim().includes(n));
    if (loose) ids.add(loose.id);
  }
  if (ids.size === 0 && inFrame === null) {
    const text = [shot.description, shot.action, shot.dialogue].filter(Boolean).join("\n");
    for (const c of named) if (text.includes(c.name.trim())) ids.add(c.id);
  }
  // 保持角色表顺序，渲染时主角在前
  return named.filter((c) => ids.has(c.id)).map((c) => c.id);
}

async function applyShotPlan(ctx: StageContext, data: Record<string, unknown>): Promise<void> {
  ctx.emitter.commit("shot_updated", () => {
  const rawShots = Array.isArray(data.shots) ? data.shots : [];
  const characters = ctx.shared.charactersForProject(ctx.projectId);

  // wipe-and-recreate shots (full mode parity with plan.py full re-plan)
  for (const existing of ctx.shared.shotsForProject(ctx.projectId)) {
    ctx.shared.deleteShot(existing.id);
    ctx.emitter.emit("shot_deleted", { shot_id: existing.id });
  }

  rawShots.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const s = item as PlanShot;
    const characterIds = bindShotCharacters(s, characters);
    const base = s.description ?? s.action ?? `分镜 ${index + 1}`;
    // The end state rides in the description so it reaches image and video
    // prompts and stays editable with the rest of the shot text.
    const continuity = typeof s.continuity === "string" ? s.continuity.trim() : "";
    const description = continuity ? `${base}\n画面状态：${continuity}` : base;
    // The planner writes a start-state keyframe prompt and a start-to-end
    // video prompt; dropping them drew every keyframe at the END state, so
    // each shot showed its own result (and the next beat) before it happened.
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() ? value.trim() : null;
    const id = ctx.shared.insertShot(ctx.projectId, index + 1, {
      description,
      character_ids: characterIds,
      image_prompt: text(s.image_prompt),
      prompt: text(s.video_prompt),
    });
    ctx.shared.updateShot(id, {
      scene: s.scene ?? null,
      action: s.action ?? null,
      expression: s.expression ?? null,
      camera: s.camera ?? null,
      lighting: s.lighting ?? null,
      dialogue: s.dialogue ?? null,
      sfx: s.sfx ?? null,
      motion_note: s.motion_note ?? null,
      duration: typeof s.duration === "number" ? s.duration : null,
    });
    const row = ctx.shared.getShot(id);
    if (row) ctx.emitter.shotCreated(shotReadPayload(row));
  });
  return null;
  });
}

// ---------------------------------------------------------------------------
// Render agent (render.py port)
// ---------------------------------------------------------------------------

export async function runRenderCharacters(ctx: StageContext): Promise<void> {
  const all = ctx.shared.charactersForProject(ctx.projectId);
  // Targeted redraw scope: FastAPI no longer builds an agent plan + target ids,
  // the engine owns entity selection (ADR 0008).
  const characters = ctx.targetCharacterIds
    ? all.filter((character) => ctx.targetCharacterIds!.includes(character.id))
    : all;
  const forced = new Set(ctx.targetCharacterIds ?? []);
  const pending = characters.filter(
    (character) =>
      !ctx.completedTargets.has(targetCheckpointStage("character_image", character.id)) &&
      (forced.has(character.id) ||
        ctx.forceCharacterRedraw ||
        !ctx.shared.hasCharacterImage(character.id)),
  );
  if (pending.length === 0) {
    await ctx.emitter.sendMessage("render", "所有角色已有形象图。");
    return;
  }
  await ctx.emitter.sendMessage("render", "开始生成角色形象图…", { progress: 0, isLoading: true });
  const total = pending.length;
  let index = 0;
  const worker = new BackendWorker(ctx.signal);
  try {
    for (const character of pending) {
      index += 1;
      ctx.emitter.sendProgress("render", "render_characters", "character_images_approval", index / total);
      await ctx.emitter.sendMessage("render", `正在绘制：${character.name} (${index}/${total})`);
      let characterForRender = character;
      if (!character.visual_notes && character.description) {
        try {
          const notes = await callLlm(
            ctx,
            "render",
            "You are a character visual design assistant. Extract only observable visual traits: hair color and style, eye color, skin tone, body type, height, distinguishing features, clothing, colors, and signature items. Reply as JSON with one string field named visual_notes. Use the same language as the description; omit personality and backstory.",
            `Character name: ${character.name}\nDescription: ${character.description}\n\nExtract the key visual traits.`,
            512,
            { validate: OUTPUT_SHAPES.visualNotes },
          );
          const visualNotes = typeof notes.visual_notes === "string" ? notes.visual_notes.trim() : "";
          if (visualNotes) characterForRender = { ...character, visual_notes: visualNotes };
        } catch (error) {
          if (ctx.signal.aborted) throw error;
        }
      }
      // Identity lock + style lock + universe style: parity with the Python
      // render agent, which is a precondition for deleting it (ADR 0008).
      const prompt = ctx.style
        ? buildCharacterPrompt({
            character: characterForRender,
            style: ctx.style,
            universeStyle: ctx.universeStyle,
            userFeedback: ctx.userFeedback,
          })
        : `角色立绘：${character.name}。${character.description ?? ""} ${characterForRender.visual_notes ?? ""} ${ctx.shared.getProject(ctx.projectId)?.visual_bible ?? ""}${ctx.userFeedback ? ` 修改要求：${ctx.userFeedback}` : ""}`.trim();
      const imageUrl = await ctx.media.generateImageUrl({ prompt });
      let faceEmbedding: string | null = null;
      try {
        const embedding = await worker.faceEmbedding(await ctx.media.readImageBytes(imageUrl));
        if (embedding) faceEmbedding = JSON.stringify(embedding);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        console.warn(`Face embedding skipped (character ${character.id})`);
        await ctx.emitter.sendMessage("render", `⚠️ ${character.name} 的面部特征没算出来（${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}），之后的分镜无法用它核对长相。`);
      }
      const before = ctx.shared.getCharacter(character.id);
      if (!before) continue;
      // Snapshot, CAS write, and both durable events share one transaction.
      ctx.emitter.commit("character_updated", () => {
        const version = ctx.shared.createVersion(
          ctx.projectId,
          "character",
          character.id,
          before,
          ctx.runId,
          "generation",
        );
        ctx.emitter.versionCreated("character", character.id, version, "generation");
        ctx.shared.updateCharacter(
          character.id,
          {
            image_url: imageUrl,
            face_embedding: faceEmbedding,
            ...(!character.visual_notes && characterForRender.visual_notes
              ? { visual_notes: characterForRender.visual_notes }
              : {}),
          },
          character.revision,
        );
        ctx.checkpointTarget("character_image", character.id);
        const affectedShots = ctx.shared
          .getLiveShotsForProject(ctx.projectId)
          .filter((shot) =>
            parseJsonColumn(shot.character_ids, [] as number[]).includes(character.id),
          );
        for (const shot of affectedShots) {
          const shotVersion = ctx.shared.createVersion(
            ctx.projectId,
            "shot",
            shot.id,
            shot,
            ctx.runId,
            "generation",
          );
          ctx.emitter.versionCreated("shot", shot.id, shotVersion, "generation");
          ctx.shared.updateShot(
            shot.id,
            { image_url: null, video_url: null, tts_url: null, bgm_type: null },
            shot.revision,
          );
          ctx.emitter.emit("shot_updated", {
            shot: shotReadPayload({
              ...shot,
              image_url: null,
              video_url: null,
              tts_url: null,
              bgm_type: null,
              revision: shot.revision + 1,
            }),
          });
        }
        const project = ctx.shared.getProject(ctx.projectId);
        if (project?.video_url && project.status !== "superseded") {
          ctx.shared.updateProject(ctx.projectId, { status: "superseded" });
          ctx.emitter.projectUpdated({ status: "superseded" });
        }
        return {
          character: characterReadPayload({
            ...character,
            image_url: imageUrl,
            face_embedding: faceEmbedding,
            visual_notes: characterForRender.visual_notes,
            revision: character.revision + 1,
          }),
        };
      });
    }
  } finally {
    await worker.close();
  }
  await ctx.emitter.sendMessage("render", `已为 ${total} 个角色生成形象图。`);
  ctx.completionInfo = {
    completed: "角色形象图已渲染完成",
    details: `已生成 ${total} 个角色形象图`,
    next: "接下来渲染分镜画面",
    question: "角色形象是否满意？如果需要重新生成，请告诉我。",
  };
}

function characterReferenceUrls(characters: CharacterRow[]): string[] {
  return characters.flatMap((character) => [
    ...(character.image_url ? [character.image_url] : []),
    ...parseJsonColumn(character.reference_images, [] as string[]),
  ]);
}

export async function runRenderShots(ctx: StageContext): Promise<void> {
  const allShots = ctx.shared.shotsForProject(ctx.projectId);
  const scopedShots = ctx.targetShotIds
    ? allShots.filter((shot) => ctx.targetShotIds!.includes(shot.id))
    : allShots;
  const forced = new Set(ctx.targetShotIds ?? []);
  const shots = scopedShots.filter(
    (shot) =>
      !ctx.completedTargets.has(targetCheckpointStage("shot_image", shot.id)) &&
      (forced.has(shot.id) || !ctx.shared.hasShotImage(shot.id)),
  );
  if (shots.length === 0) {
    await ctx.emitter.sendMessage("render", "所有分镜已有首帧图片。");
    return;
  }
  await ctx.emitter.sendMessage("render", "开始生成分镜首帧图…", { progress: 0, isLoading: true });
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const idToName = new Map(characters.map((c) => [c.id, c.name]));
  const byId = new Map(characters.map((c) => [c.id, c]));
  const visualBible = ctx.shared.getProject(ctx.projectId)?.visual_bible ?? null;
  let index = 0;
  const worker = new BackendWorker(ctx.signal);
  try {
    for (const shot of shots) {
      index += 1;
      ctx.emitter.sendProgress("render", "render_shots", "shot_images_approval", index / shots.length);
      // Keyframes chain: shot N is drawn from shot N-1's keyframe (read live,
      // so a keyframe redrawn earlier in this loop is the one carried on).
      const order = allShots.findIndex((item) => item.id === shot.id);
      // getShot returns the stage's frozen input, where a keyframe drawn
      // earlier in this loop is still empty; only the live row has it.
      const previous = order > 0 ? ctx.shared.getLiveShot(allShots[order - 1]!.id) : null;
      const previousImage = previous?.image_url ?? null;
      const ids = parseJsonColumn(shot.character_ids, [] as number[]);
      const boundCharacters = ids
        .map((id) => byId.get(id))
        .filter((character): character is CharacterRow => character !== undefined);
      const names = ids.map((id) => idToName.get(id) ?? `#${id}`);
      const critiqueNote = ctx.critiqueNotes?.get(shot.id);
      ctx.critiqueNotes?.delete(shot.id);
      const feedback = [ctx.userFeedback, critiqueNote ? `上一版审查未通过，这次必须修正：${critiqueNote}` : ""]
        .filter(Boolean)
        .join("\n");
      // Character bible + continuity lock + style lock (Python render parity).
      const prompt = ctx.style
        ? buildShotPrompt({
            shot,
            characters: boundCharacters,
            style: ctx.style,
            universeStyle: ctx.universeStyle,
            userFeedback: feedback || undefined,
            visualBible,
            neighbors: { previous: allShots[order - 1]?.description, next: allShots[order + 1]?.description },
          })
        : [
            `分镜首帧：${shot.description}`,
            shot.scene ? `场景：${shot.scene}` : "",
            shot.lighting ? `光线：${shot.lighting}` : "",
            names.length ? `角色：${names.join("、")}` : "",
            feedback ? `修改要求：${feedback}` : "",
          ]
            .filter(Boolean)
            .join("。");
      await ctx.emitter.sendMessage("render", `正在绘制分镜 (${index}/${shots.length})`);
      let imageBytes: Buffer | null = null;
      let chained = false;
      if (ctx.mediaSettings.enableImageToImage) {
        const references = characterReferenceUrls(boundCharacters);
        if (references.length > 0) {
          try {
            imageBytes = await worker.characterReference(references);
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            console.warn(`Character references skipped (shot ${shot.id}): ${error instanceof Error ? error.message : String(error)}`);
            await ctx.emitter.sendMessage("render", `⚠️ ${shotLabel(shot)} 没拿到角色设定图，这一镜只按文字描述画角色。`);
          }
        }
        if (previousImage) {
          try {
            const previousBytes = await ctx.media.readImageBytes(previousImage);
            imageBytes = imageBytes
              ? await ctx.media.stackImages([imageBytes, previousBytes])
              : previousBytes;
            chained = true;
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            console.warn(`Previous keyframe skipped (shot ${shot.id})`);
            await ctx.emitter.sendMessage("render", `⚠️ ${shotLabel(shot)} 读不到上一镜画面（${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}），这一镜没有沿用上一镜的场景和道具。`);
          }
        }
      }
      const imagePrompt = chained
        ? `参考图${boundCharacters.length > 0 ? "左边是角色设定，最右边" : ""}是上一个镜头的画面：沿用同一地点、机位方向、光线和画风，关键道具（材质、大小、透明度、里面的状态）保持一致，只画本镜头开始那一刻；不要把参考图拼贴进画面。${prompt}`
        : prompt;
      const imageUrl = await ctx.media.generateImageUrl({ prompt: imagePrompt, imageBytes });
      const before = ctx.shared.getShot(shot.id);
      if (!before) continue;
      ctx.emitter.commit("shot_updated", () => {
        const version = ctx.shared.createVersion(
          ctx.projectId,
          "shot",
          shot.id,
          before,
          ctx.runId,
          "generation",
        );
        ctx.emitter.versionCreated("shot", shot.id, version, "generation");
        ctx.shared.updateShot(
          shot.id,
          {
            image_url: imageUrl,
            video_url: null,
            tts_url: null,
            bgm_type: null,
            review_status: null,
            review_note: null,
          },
          shot.revision,
        );
        ctx.checkpointTarget("shot_image", shot.id);
        const project = ctx.shared.getProject(ctx.projectId);
        if (project?.video_url && project.status !== "superseded") {
          ctx.shared.updateProject(ctx.projectId, { status: "superseded" });
          ctx.emitter.projectUpdated({ status: "superseded" });
        }
        return {
          shot: shotReadPayload({
            ...shot,
            image_url: imageUrl,
            video_url: null,
            tts_url: null,
            bgm_type: null,
            review_status: null,
            review_note: null,
            revision: shot.revision + 1,
          }),
        };
      });
    }
  } finally {
    await worker.close();
  }
  ctx.completionInfo = {
    completed: "分镜画面已渲染完成",
    details: `已生成 ${shots.length} 个分镜首帧图`,
    next: "接下来将根据分镜生成视频片段并合成",
    question: "分镜画面是否满意？如果需要重新生成，请告诉我。",
  };
}

// ---------------------------------------------------------------------------
// Critic agent
// ---------------------------------------------------------------------------

export interface CritiqueOutcome {
  willRegenerate: boolean;
  minScore: number;
  regenerateEntityIds: number[];
}

async function critiqueImage(ctx: StageContext, url: string | null): Promise<LlmImageInput | null> {
  if (!url) return null;
  try {
    const bytes = await ctx.media.readImageBytes(url);
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) return null;
    return { data: bytes.toString("base64"), mimeType };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    console.warn(`critic: image unavailable (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

const SHOT_STATE_MARK = "\n画面状态：";

/** A planned shot's description is "<action>\n画面状态：<end state>". */
export function splitShotState(description: string | null): { action: string; end: string } {
  const text = description ?? "";
  const at = text.indexOf(SHOT_STATE_MARK);
  return at < 0
    ? { action: text.trim(), end: "" }
    : { action: text.slice(0, at).trim(), end: text.slice(at + SHOT_STATE_MARK.length).trim() };
}

const CHECK_LABELS: Record<string, string> = {
  characters: "画面内角色不对",
  state: "画面状态不对",
  props: "道具前后不一致",
  look: "角色画风或外观和设定图不一致",
  no_future_beat: "提前出现了后面镜头的情节",
};

const SHOT_CHECK_OUTPUT = `逐项检查后只输出一个 JSON 对象（不要 markdown）：
{"score": 0-10, "checks": {"characters": true/false, "state": true/false, "props": true/false, "look": true/false, "no_future_beat": true/false}, "issues": ["简短中文问题"], "suggestions": ["简短中文修改建议"]}
characters=画面里只有「画面内角色」；state=画面符合上面的状态要求；props=关键道具的材质、大小、透明度符合设定且前后一致；look=角色外观和画风与角色设定图一致；no_future_beat=没有出现「后续镜头情节」。`;

/** The story facts one shot has to show, for the critic to check pixels against. */
export function shotChecklist(
  ctx: StageContext,
  shot: ShotRow,
  allShots: ShotRow[],
  kind: "keyframe" | "clip",
): string {
  const index = allShots.findIndex((item) => item.id === shot.id);
  const { action, end } = splitShotState(shot.description);
  const start = index > 0 ? splitShotState(allShots[index - 1]!.description).end : "";
  const names = new Map(ctx.shared.charactersForProject(ctx.projectId).map((c) => [c.id, c.name]));
  const cast = parseJsonColumn(shot.character_ids, [] as number[]).map((id) => names.get(id) ?? `#${id}`);
  const later = allShots
    .slice(index + 1)
    .map((item, offset) => `${offset + 1}. ${splitShotState(item.description).action.slice(0, 80)}`);
  const bible = (ctx.shared.getProject(ctx.projectId)?.visual_bible ?? "").trim().slice(0, 500);
  return [
    kind === "keyframe"
      ? "附图第 1 张是这个镜头的首帧图，后面是角色设定图。首帧应表现开始状态或动作刚开始，不能超过结束状态。"
      : "附图第 1 张是这个镜头视频的首帧、中间帧、末帧横向拼接，后面是角色设定图。末帧必须符合结束状态。",
    `画面内角色：${cast.length ? cast.join("、") : "无角色"}`,
    `本镜头动作：${action}`,
    start ? `开始状态：${start}` : "",
    end ? `结束状态：${end}` : "",
    bible ? `全局视觉与道具设定：${bible}` : "",
    later.length ? `后续镜头情节（本镜头绝不能出现）：\n${later.join("\n")}` : "",
    SHOT_CHECK_OUTPUT,
  ]
    .filter(Boolean)
    .join("\n");
}

interface CriticVerdict {
  score: number;
  dimensions: Record<string, number>;
  issues: string[];
  suggestions: string[];
  failedChecks: string[];
  passed: boolean;
}

/** One critic call; null (with the reason) when it gave no usable verdict. */
async function askCritic(
  ctx: StageContext,
  systemPrompt: string,
  prompt: string,
  images: LlmImageInput[],
): Promise<{ verdict: CriticVerdict | null; failure: string }> {
  let data: Record<string, unknown> | null = null;
  // A shot review passes only on its story checks; a reply that skips them
  // (small vision models often fall back to the bare score format) is asked
  // once more instead of passing on the score alone.
  const wantsChecks = prompt.includes(SHOT_CHECK_OUTPUT);
  for (let ask = 0; ask < (wantsChecks ? 2 : 1); ask += 1) {
    try {
      data = await callLlm(
        ctx,
        "critic",
        systemPrompt,
        ask === 0 ? prompt : `${prompt}\n上一次回答缺少 checks。必须给出 checks 里全部 5 项的 true/false。`,
        1024,
        { validate: OUTPUT_SHAPES.critique, images },
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return { verdict: null, failure: error instanceof Error ? error.message : String(error) };
    }
    if (isRecord(data.checks)) break;
  }
  if (!data) return { verdict: null, failure: "" };
  const score = critiqueScore(data);
  if (score === null) return { verdict: null, failure: "" };
  const rawDimensions = isRecord(data.dimensions) ? data.dimensions : {};
  const dimension = (key: string): number => {
    const value = Number(rawDimensions[key] ?? data![key]);
    return Number.isFinite(value) ? value : 0;
  };
  const checks = isRecord(data.checks) ? data.checks : {};
  const failedChecks = Object.keys(CHECK_LABELS).filter(
    (key) => checks[key] === false || checks[key] === "false",
  );
  return {
    verdict: {
      score,
      dimensions: {
        consistency: dimension("consistency"),
        quality: dimension("quality"),
        composition: dimension("composition"),
      },
      issues: Array.isArray(data.issues) ? data.issues.map(String) : [],
      suggestions: Array.isArray(data.suggestions) ? data.suggestions.map(String) : [],
      failedChecks,
      // Without checks, a reported issue is the only story signal left.
      passed:
        score >= ctx.critiqueScoreThreshold &&
        failedChecks.length === 0 &&
        !(wantsChecks && !isRecord(data.checks) && Array.isArray(data.issues) && data.issues.length > 0),
    },
    failure: "",
  };
}

/** The reason a shot failed, short enough to fold into the next prompt. */
function critiqueNote(verdict: CriticVerdict): string {
  return [...verdict.failedChecks.map((key) => CHECK_LABELS[key]), ...verdict.issues, ...verdict.suggestions]
    .filter(Boolean)
    .join("；")
    .slice(0, 300);
}

/** Up to two sheets of the characters in frame, so the critic can compare looks. */
async function castSheets(ctx: StageContext, shot: ShotRow): Promise<LlmImageInput[]> {
  const byId = new Map(ctx.shared.charactersForProject(ctx.projectId).map((c) => [c.id, c]));
  const sheets: LlmImageInput[] = [];
  for (const id of parseJsonColumn(shot.character_ids, [] as number[]).slice(0, 2)) {
    const sheet = await critiqueImage(ctx, byId.get(id)?.image_url ?? null);
    if (sheet) sheets.push(sheet);
  }
  return sheets;
}

function shotLabel(shot: ShotRow): string {
  return `S${String(shot.order).padStart(2, "0")}`;
}

type ReviewStatus = "passed" | "failed" | "unchecked";

/**
 * Keep the critic's outcome on the shot so a shot nobody looked at shows
 * 「未检查」 on the canvas instead of passing silently.
 */
function markReview(ctx: StageContext, shotId: number, status: ReviewStatus | null, note = ""): void {
  const live = ctx.shared.getLiveShot(shotId);
  if (!live) return;
  const reviewNote = status === "passed" || status === null ? null : note.slice(0, 300) || null;
  if ((live.review_status ?? null) === status && (live.review_note ?? null) === reviewNote) return;
  ctx.emitter.commit("shot_updated", () => {
    ctx.shared.updateShot(shotId, { review_status: status, review_note: reviewNote }, live.revision);
    return {
      shot: shotReadPayload({ ...live, review_status: status, review_note: reviewNote, revision: live.revision + 1 }),
    };
  });
}

/** Null when the critic can look at images; otherwise why it cannot. */
async function visionUnavailable(ctx: StageContext): Promise<string | null> {
  const status = await ctx.llm.visionStatus?.();
  return status && !status.ok ? status.reason : null;
}

export async function runCritique(
  ctx: StageContext,
  entityType: "character" | "shot",
): Promise<CritiqueOutcome> {
  const allShots = entityType === "shot" ? ctx.shared.shotsForProject(ctx.projectId) : [];
  // A targeted redraw (or a critique redo) reviews only the entities it drew.
  const targets = entityType === "character" ? ctx.targetCharacterIds : ctx.targetShotIds;
  const entities: Array<CharacterRow | ShotRow> = (
    entityType === "character" ? ctx.shared.charactersForProject(ctx.projectId) : allShots
  ).filter((entity) => !targets?.length || targets.includes(entity.id));
  const rounds = entityType === "character" ? ctx.critiqueRounds.characters : ctx.critiqueRounds.shots;
  const down = entities.length > 0 ? await visionUnavailable(ctx) : null;
  if (down) {
    // Nothing looked at these images: say so on every shot rather than pass them.
    if (entityType === "shot") for (const entity of entities) markReview(ctx, entity.id, "unchecked", down);
    await ctx.emitter.sendMessage(
      "critic",
      `⚠️ ${down}，${entities.length} 张${entityType === "character" ? "角色形象图" : "分镜图"}标为「未检查」，保留当前画面继续。`,
    );
    return { willRegenerate: false, minScore: 10, regenerateEntityIds: [] };
  }
  await ctx.emitter.sendMessage("critic", `开始审查 ${entities.length} 张${entityType === "character" ? "角色形象图" : "分镜图"}…`);

  let minScore = 10;
  let judged = 0;
  let willRegenerate = false;
  const regenerateEntityIds: number[] = [];
  // key 现在受字面量类型约束，拼错会编译失败（见 prompts.ts 注释）。
  // 这里不再写 `?? ""` —— 正是那种兜底让空 prompt 的 bug 静默上线。
  const systemPrompt =
    entityType === "character"
      ? PROMPTS["critic.CHARACTER_REVIEW_SYSTEM_PROMPT"]
      : PROMPTS["critic.SHOT_REVIEW_SYSTEM_PROMPT"];
  for (const entity of entities) {
    const label =
      entityType === "character" ? ((entity as CharacterRow).name ?? "角色") : shotLabel(entity as ShotRow);
    // The model has to see the pixels: the render goes in as image content,
    // never as a URL in the prompt text (a text model cannot open it).
    const image = await critiqueImage(ctx, entity.image_url);
    const prompt = !image
      ? `No image is available to review for ${label}. Do not guess a score: return JSON with "score": null and one issue explaining that the image could not be reviewed.`
      : entityType === "shot"
        ? `审查分镜 ${label} 的首帧图。\n${shotChecklist(ctx, entity as ShotRow, allShots, "keyframe")}`
        : // No "return null if you cannot see it" escape hatch: a small local
          // vision model takes it even when it sees the image fine.
          `附图是角色 ${label} 的角色设定图（多角度造型图），请看图评审。\n角色描述：${entity.description ?? ""}\n只评角色造型：与描述是否一致、各角度是否同一个角色、画面质量；这是设定图，不需要表现剧情。\n输出 JSON：score、dimensions (consistency, quality, composition)、issues、suggestions。`;
    const images = image
      ? [image, ...(entityType === "shot" ? await castSheets(ctx, entity as ShotRow) : [])]
      : [];
    const { verdict, failure } = image
      ? await askCritic(ctx, systemPrompt, prompt, images)
      : { verdict: null, failure: "" };
    if (!verdict) {
      // No verdict is not a failing grade: regenerating on a missing score
      // only burns provider time (the old `?? 0` redrew every image twice).
      const reason = !image
        ? "没有可审查的图片"
        : failure
          ? "审查模型调用失败"
          : ctx.llm.resolveVisionProvider?.()
            ? "审查模型没有给出有效评分"
            : "当前文本模型看不到图片，请在设置里配置审查视觉模型";
      console.warn(`critic: no verdict for ${entityType} ${entity.id}: ${failure || reason}`);
      if (entityType === "shot") markReview(ctx, entity.id, "unchecked", reason);
      await ctx.emitter.sendMessage(
        "critic",
        `⚠️ ${label} 未能完成审查（${reason}），标为「未检查」，保留当前画面，不重新生成。`,
      );
      continue;
    }
    judged += 1;
    const { score } = verdict;
    if (score < minScore) minScore = score;
    const willRegen = !verdict.passed && rounds < ctx.critiqueMaxRounds;
    const note = critiqueNote(verdict);
    if (entityType === "shot" && !willRegen) {
      markReview(ctx, entity.id, verdict.passed ? "passed" : "failed", note || "低于分数线");
    }
    if (willRegen) {
      willRegenerate = true;
      regenerateEntityIds.push(entity.id);
      if (entityType === "shot") (ctx.critiqueNotes ??= new Map()).set(entity.id, note);
    }
    ctx.emitter.critiqueResult({
      score,
      dimensions: verdict.dimensions,
      issues: [...verdict.failedChecks.map((key) => CHECK_LABELS[key]!), ...verdict.issues],
      suggestions: verdict.suggestions,
      entity_type: entityType,
      entity_id: entity.id,
      will_regenerate: willRegen,
    });
    await ctx.emitter.sendMessage(
      "critic",
      verdict.passed
        ? `${label} 审查结果：总分 ${score.toFixed(1)}/10，质量达标`
        : willRegen
          ? `${label} 审查结果：总分 ${score.toFixed(1)}/10，未通过（${note || "低于分数线"}），将重新生成`
          : `⚠️ ${label} 已自动重新生成 ${rounds} 次仍未通过检查（${note || "低于分数线"}）。请修改这个${entityType === "shot" ? "分镜" : "角色"}的描述后手动重新生成。`,
    );
  }
  if (entityType === "character" && !willRegenerate && judged > 0) {
    // consistency_eval service parity: overall score over the judged critiques
    const overall = Math.min(100, Math.round((minScore / 10) * 100));
    ctx.emitter.consistencyEvalCompleted(overall, judged);
  }
  return { willRegenerate, minScore, regenerateEntityIds };
}

interface ClipReview {
  verdict: CriticVerdict | null;
  /** null when review is off; "unchecked" when the critic could not look */
  status: ReviewStatus | null;
  note: string;
}

/**
 * Checks a fresh clip's first, middle and last frames against the shot's story
 * state. A missing verdict never blocks the clip; it is kept as 「未检查」.
 */
async function reviewClip(
  ctx: StageContext,
  shot: ShotRow,
  allShots: ShotRow[],
  videoUrl: string,
): Promise<ClipReview> {
  if (!ctx.critiqueEnabled) return { verdict: null, status: null, note: "" };
  const down = await visionUnavailable(ctx);
  if (down) return { verdict: null, status: "unchecked", note: down };
  let strip: Buffer | null = null;
  try {
    strip = await ctx.media.videoFrameStrip(videoUrl);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    console.warn(`clip check: frames unavailable (shot ${shot.id})`);
  }
  if (!strip) return { verdict: null, status: "unchecked", note: "取不到视频帧" };
  const prompt = `审查分镜 ${shotLabel(shot)} 的视频片段。\n${shotChecklist(ctx, shot, allShots, "clip")}`;
  const { verdict, failure } = await askCritic(
    ctx,
    PROMPTS["critic.SHOT_REVIEW_SYSTEM_PROMPT"],
    prompt,
    [{ data: strip.toString("base64"), mimeType: "image/png" }, ...(await castSheets(ctx, shot))],
  );
  if (!verdict) {
    console.warn(`clip check: no verdict for shot ${shot.id}: ${failure || "no score"}`);
    return { verdict: null, status: "unchecked", note: failure ? "审查模型调用失败" : "审查模型没有给出有效评分" };
  }
  ctx.emitter.critiqueResult({
    score: verdict.score,
    dimensions: verdict.dimensions,
    issues: [...verdict.failedChecks.map((key) => CHECK_LABELS[key]!), ...verdict.issues],
    suggestions: verdict.suggestions,
    entity_type: "shot",
    entity_id: shot.id,
    will_regenerate: false,
  });
  return { verdict, status: verdict.passed ? "passed" : "failed", note: critiqueNote(verdict) || "低于分数线" };
}

// ---------------------------------------------------------------------------
// Compose agent (compose.py port: videos, merge, audio)
// ---------------------------------------------------------------------------

export async function runComposeVideos(ctx: StageContext): Promise<void> {
  const allShots = ctx.shared.shotsForProject(ctx.projectId);
  const scopedShots = ctx.targetShotIds
    ? allShots.filter((shot) => ctx.targetShotIds!.includes(shot.id))
    : allShots;
  const forced = new Set(ctx.targetShotIds ?? []);
  const shots = scopedShots.filter(
    (shot) =>
      !ctx.completedTargets.has(targetCheckpointStage("shot_video", shot.id)) &&
      (forced.has(shot.id) || !ctx.shared.hasShotVideo(shot.id)),
  );
  if (shots.length === 0) {
    await ctx.emitter.sendMessage("compose", "所有分镜已有视频。");
    return;
  }
  await ctx.emitter.sendMessage("compose", `开始生成 ${shots.length} 个分镜视频…`, { progress: 0, isLoading: true });
  const useI2V = ctx.mediaSettings.enableImageToVideo;
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const byId = new Map(characters.map((character) => [character.id, character]));
  const visualBible = ctx.shared.getProject(ctx.projectId)?.visual_bible ?? null;
  const defaultDuration =
    ctx.mediaSettings.videoProvider === "doubao" ? ctx.mediaSettings.doubaoVideoDuration : 5;
  let index = 0;
  const worker = new BackendWorker(ctx.signal);
  try {
    for (const shot of shots) {
      index += 1;
      ctx.emitter.sendProgress("compose", "compose_videos", "compose_merge", index / shots.length);
      await ctx.emitter.sendMessage("compose", `正在生成视频 (${index}/${shots.length})`);
      const boundCharacters = parseJsonColumn(shot.character_ids, [] as number[])
        .map((id) => byId.get(id))
        .filter((character): character is CharacterRow => character !== undefined);
      const shotOrder = allShots.findIndex((item) => item.id === shot.id);
      const basePrompt = (note: string): string => {
        const feedback = [ctx.userFeedback, note ? `上一版检查未通过，这次必须修正：${note}` : ""]
          .filter(Boolean)
          .join("\n");
        return ctx.style
          ? buildVideoPrompt({
              shot,
              characters: boundCharacters,
              style: ctx.style,
              userFeedback: feedback || undefined,
              visualBible,
              neighbors: {
                previous: allShots[shotOrder - 1]?.description,
                next: allShots[shotOrder + 1]?.description,
              },
            })
          : [shot.prompt || shot.description, feedback].filter(Boolean).join("\n");
      };
      let imageUrl = useI2V ? shot.image_url : null;
      const referenceMode = ctx.mediaSettings.videoImageMode === "reference";
      let useReferenceBoard = false;
      if (imageUrl && referenceMode) {
        const shotIndex = allShots.findIndex((item) => item.id === shot.id);
        try {
          const reference = await worker.nineGridReference({
            current: imageUrl,
            previous: allShots[shotIndex - 1]?.image_url,
            next: allShots[shotIndex + 1]?.image_url,
            characters: characterReferenceUrls(boundCharacters),
          });
          imageUrl = ctx.media.saveImageBytes(reference, "video-reference");
          useReferenceBoard = true;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          console.warn(`Nine-grid reference skipped (shot ${shot.id})`);
          await ctx.emitter.sendMessage("render", `⚠️ ${shotLabel(shot)} 的九宫格参考图没拼出来（${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}），改用这一镜的首帧生成视频。`);
        }
      }
      const videoPrompt = (prompt: string): string =>
        imageUrl
          ? `${VIDEO_STYLE_FRONT_LOCK} ` + (useReferenceBoard
            ? `The input is a 3x3 reference board. Use the top-center panel as the first frame and the other panels only for character identity and continuity. Generate one full-frame video; do not reproduce the grid. Preserve the comic/anime style and do not redesign characters. ${prompt}`
            : `Use the provided image as the first-frame visual anchor. Preserve visible characters, outfits, hair colors, scene layout, framing, camera distance, and the 2D comic/anime style. Do not convert it to live-action, photorealistic, hyperrealistic, or realistic 3D footage; do not redesign characters. ${prompt}`)
          : prompt;
      // Providers take whole seconds (doubao only 5 or 10); the stored shot
      // duration is the length of the clip that was actually requested.
      const duration = normalizeVideoDuration(
        ctx.mediaSettings.videoProvider,
        shot.duration && shot.duration > 0 ? shot.duration : defaultDuration,
        ctx.mediaSettings.videoModel,
      );
      // Each clip is checked against the shot's story state; a failed check
      // redoes only this clip with the reason in the prompt, up to the
      // critique round limit, then the user is told what is still wrong.
      let note = "";
      let videoUrl = "";
      let review: ClipReview = { verdict: null, status: null, note: "" };
      for (let attempt = 0; ; attempt += 1) {
        videoUrl = await ctx.media.generateVideoUrl({
          prompt: videoPrompt(basePrompt(note)),
          negativePrompt: ctx.style ? videoNegativePrompt(ctx.style) : undefined,
          imageUrl,
          duration,
        });
        review = await reviewClip(ctx, shot, allShots, videoUrl);
        const verdict = review.verdict;
        if (review.status === "unchecked") {
          await ctx.emitter.sendMessage("critic", `⚠️ ${shotLabel(shot)} 视频未检查（${review.note}），保留这段视频。`);
        }
        if (!verdict || verdict.passed) break;
        note = critiqueNote(verdict) || "低于分数线";
        if (attempt >= ctx.critiqueMaxRounds) {
          await ctx.emitter.sendMessage(
            "critic",
            `⚠️ ${shotLabel(shot)} 视频已自动重新生成 ${attempt} 次仍未通过检查（${note}）。请修改这个分镜的描述后手动重新生成视频。`,
          );
          break;
        }
        await ctx.emitter.sendMessage(
          "critic",
          `${shotLabel(shot)} 视频检查未通过（${note}），正在重新生成（第 ${attempt + 1} 次）…`,
        );
      }
      const before = ctx.shared.getLiveShot(shot.id);
      if (!before) continue;
      ctx.emitter.commit("shot_updated", () => {
        const version = ctx.shared.createVersion(
          ctx.projectId,
          "shot",
          shot.id,
          before,
          ctx.runId,
          "generation",
        );
        ctx.emitter.versionCreated("shot", shot.id, version, "generation");
        // A new clip invalidates the voice/BGM mixed into the old one, so merge
        // runs audio processing again instead of keeping a stale track.
        ctx.shared.updateShot(
          shot.id,
          {
            video_url: videoUrl,
            duration,
            tts_url: null,
            bgm_type: null,
            review_status: review.status,
            review_note: review.status === "passed" ? null : review.note || null,
          },
          before.revision,
        );
        ctx.checkpointTarget("shot_video", shot.id);
        const project = ctx.shared.getProject(ctx.projectId);
        if (project?.video_url && project.status !== "superseded") {
          ctx.shared.updateProject(ctx.projectId, { status: "superseded" });
          ctx.emitter.projectUpdated({ status: "superseded" });
        }
        const updated: ShotRow = {
          ...before,
          video_url: videoUrl,
          duration,
          tts_url: null,
          bgm_type: null,
          review_status: review.status,
          review_note: review.status === "passed" ? null : review.note || null,
          revision: before.revision + 1,
        };
        return { shot: shotReadPayload(updated) };
      });
    }
  } finally {
    await worker.close();
  }
}

const NARRATOR_LABELS = new Set(["旁白", "画外音", "叙述", "解说", "narrator"]);

/**
 * 「角色名：台词」由该角色配音，「旁白：…」用默认音色；没有前缀时沿用镜头里的
 * 第一个角色。前缀与引号不会被读出来。
 */
export function splitDialogueSpeaker(
  dialogue: string | null,
  shotCast: CharacterRow[],
  allCharacters: CharacterRow[],
): { text: string | null; speaker: CharacterRow | null } {
  if (!dialogue?.trim()) return { text: dialogue, speaker: shotCast[0] ?? null };
  let speaker: CharacterRow | null | undefined;
  const lines = dialogue
    .split(/\n+/)
    .map((raw) => {
      const match = /^\s*([^：:\n]{1,12}?)\s*[：:]\s*(.+)$/s.exec(raw);
      let text = raw.trim();
      if (match) {
        const label = (match[1] ?? "").trim();
        const narrator = NARRATOR_LABELS.has(label.toLowerCase());
        const named = narrator
          ? null
          : allCharacters.find((character) => character.name === label) ??
            allCharacters.find(
              (character) => character.name.includes(label) || label.includes(character.name),
            );
        if (narrator || named) {
          text = (match[2] ?? "").trim();
          if (speaker === undefined) speaker = named ?? null;
        }
      }
      return text.replace(/^[「“"『]+|[」”"』]+$/g, "").trim();
    })
    .filter(Boolean);
  return {
    text: lines.join("\n") || null,
    speaker: speaker === undefined ? shotCast[0] ?? null : speaker,
  };
}

export async function runComposeMerge(ctx: StageContext): Promise<void> {
  const allShots = ctx.shared.shotsForProject(ctx.projectId);
  const shots = allShots.filter((shot) => ctx.shared.getLiveShot(shot.id)?.video_url);
  if (shots.length === 0) {
    await ctx.emitter.sendMessage("compose", "没有可拼接的分镜视频。");
    return;
  }
  await ctx.emitter.sendMessage(
    "compose",
    ctx.media.audioEnabled
      ? `正在处理 ${shots.length} 个分镜音轨并拼接…`
      : `开始拼接 ${shots.length} 个分镜视频…`,
    { progress: 0, isLoading: true },
  );
  const project = ctx.shared.getProject(ctx.projectId);
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const byId = new Map(characters.map((character) => [character.id, character]));
  const videoUrls: string[] = [];
  const subtitles = ctx.mediaSettings.subtitleMode ?? "off";
  const bgm = ctx.mediaSettings.bgmEnabled;
  const segments: SubtitleSegment[] = [];
  const voices: Array<{ url: string; offset: number }> = [];
  const moodTexts: string[] = [];
  let filmOffset = 0;
  const worker = new BackendWorker(ctx.signal);
  try {
    for (const shot of shots) {
      const live = ctx.shared.getLiveShot(shot.id);
      if (!live?.video_url) continue;
      let videoUrl = live.video_url;
      let ttsUrl = live.tts_url;
      const shotCast = parseJsonColumn(live.character_ids, [] as number[])
        .map((id) => byId.get(id))
        .filter((character): character is CharacterRow => character !== undefined);
      const line = splitDialogueSpeaker(live.dialogue, shotCast, characters);
      // 背景音乐整部片一条（拼接后再铺），这里只处理每个镜头的配音
      if (ctx.mediaSettings.ttsEnabled && !live.tts_url && !live.bgm_type) {
        const speaker = line.speaker;
        let audio: Awaited<ReturnType<BackendWorker["processAudio"]>> | null = null;
        try {
          audio = await worker.processAudio({
            video_url: videoUrl,
            dialogue: line.text,
            speaker: speaker ? { name: speaker.name, description: speaker.description } : null,
            voice: speaker?.voice?.trim() || null,
            scene: live.scene,
            expression: live.expression,
            genre: project?.style ?? null,
            settings: {
              text_provider: ctx.mediaSettings.textProvider,
              image_provider: ctx.mediaSettings.imageProvider,
              video_provider: ctx.mediaSettings.videoProvider,
              tts_enabled: ctx.mediaSettings.ttsEnabled,
              tts_provider: ctx.mediaSettings.ttsProvider ?? "edge",
              tts_base_url: ctx.mediaSettings.ttsBaseUrl ?? null,
              tts_api_key: ctx.mediaSettings.ttsApiKey ?? null,
              tts_model: ctx.mediaSettings.ttsModel ?? null,
              tts_default_voice: ctx.mediaSettings.ttsDefaultVoice,
              tts_volume: ctx.mediaSettings.ttsVolume,
              bgm_enabled: false,
              bgm_volume: ctx.mediaSettings.bgmVolume,
              bgm_directory: ctx.mediaSettings.bgmDirectory,
            },
          });
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          console.warn(`Audio processing skipped (shot ${shot.id})`);
          await ctx.emitter.sendMessage("compose", `⚠️ ${shotLabel(live)} 的配音和音效处理失败（${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}），这一镜用原声拼接。`);
        }
        if (ctx.signal.aborted) throw new Error("run cancelled");
        const processedAudio = audio;
        if (processedAudio?.tts_error) {
          await ctx.emitter.sendMessage(
            "compose",
            `⚠️ ${shotLabel(live)} 配音失败（${processedAudio.tts_error}），这句台词先不配音。`,
          );
        }
        if (processedAudio) {
          videoUrl = processedAudio.video_url;
          ttsUrl = processedAudio.tts_url;
          if (videoUrl !== live.video_url || processedAudio.tts_url || processedAudio.bgm_type) {
            const updated = {
              ...live,
              video_url: videoUrl,
              tts_url: processedAudio.tts_url,
              bgm_type: processedAudio.bgm_type,
              revision: live.revision + 1,
            };
            ctx.emitter.commit("shot_updated", () => {
              const version = ctx.shared.createVersion(
                ctx.projectId,
                "shot",
                live.id,
                live,
                ctx.runId,
                "generation",
              );
              ctx.emitter.versionCreated("shot", live.id, version, "generation");
              ctx.shared.updateShot(
                live.id,
                {
                  video_url: videoUrl,
                  tts_url: processedAudio.tts_url,
                  bgm_type: processedAudio.bgm_type,
                },
                live.revision,
              );
              const project = ctx.shared.getProject(ctx.projectId);
              if (project?.video_url && project.status !== "superseded") {
                ctx.shared.updateProject(ctx.projectId, { status: "superseded" });
                ctx.emitter.projectUpdated({ status: "superseded" });
              }
              return { shot: shotReadPayload(updated) };
            });
          }
        }
      }
      videoUrls.push(videoUrl);
      moodTexts.push(live.scene ?? "", live.expression ?? "");
      if (subtitles !== "off" || bgm) {
        // 字幕跟着配音走：配音从镜头开头开始，时长取配音本身（被镜头截断的部分不算）
        const clip = (await ctx.media.mediaDuration(videoUrl)) ?? live.duration ?? 5;
        const spoken = line.text?.trim() ?? "";
        if (ctx.mediaSettings.ttsEnabled && ttsUrl) voices.push({ url: ttsUrl, offset: filmOffset });
        if (spoken && subtitles !== "off") {
          const voice = ctx.mediaSettings.ttsEnabled ? await ctx.media.mediaDuration(ttsUrl) : null;
          const window = Math.min(clip, voice ?? estimatedSpeechSeconds(spoken));
          segments.push({ offset: filmOffset, window, text: spoken });
        }
        filmOffset += clip;
      }
    }
  } finally {
    await worker.close();
  }
  let mergedUrl = await ctx.media.mergeVideos(videoUrls);
  if (bgm) {
    const bgmWorker = new BackendWorker(ctx.signal);
    try {
      const track = await bgmWorker.bgmTrack({
        texts: moodTexts.filter(Boolean),
        genre: project?.style ?? null,
        duration: filmOffset || 30,
        settings: {
          bgm_provider: ctx.mediaSettings.bgmProvider ?? "library",
          bgm_base_url: ctx.mediaSettings.bgmBaseUrl ?? null,
          bgm_api_key: ctx.mediaSettings.bgmApiKey ?? null,
          bgm_model: ctx.mediaSettings.bgmModel ?? null,
          bgm_directory: ctx.mediaSettings.bgmDirectory,
        },
      });
      if (!track.track_url) throw new Error(track.fallback_reason ?? "没有可用的曲子");
      if (track.fallback_reason) {
        await ctx.emitter.sendMessage(
          "compose",
          `⚠️ 背景音乐服务没生成出来（${track.fallback_reason.slice(0, 120)}），先用本地曲库。`,
        );
      }
      mergedUrl = await ctx.media.addBackgroundMusic(
        mergedUrl,
        track.track_url,
        voices,
        ctx.mediaSettings.bgmVolume,
        ctx.mediaSettings.bgmDucking ?? true,
      );
      const where = track.source === "library" ? "本地曲库" : track.source;
      await ctx.emitter.sendMessage(
        "compose",
        `已铺上背景音乐（${where}，${track.mood ?? "ambient"}）${ctx.mediaSettings.bgmDucking === false ? "" : "，台词处自动压低"}。`,
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.emitter.sendMessage("compose", `⚠️ 背景音乐没加上（${reason.slice(0, 120)}），成片先不带配乐。`);
    } finally {
      await bgmWorker.close();
    }
  }
  if (subtitles !== "off") {
    try {
      const subtitled = await ctx.media.addSubtitles(
        mergedUrl,
        segments,
        subtitles,
        ctx.mediaSettings.subtitleFont ?? "Smiley Sans",
      );
      if (subtitled) {
        mergedUrl = subtitled.videoUrl;
        await ctx.emitter.sendMessage(
          "compose",
          `已加上 ${subtitled.cues} 条${subtitles === "burn" ? "烧录" : "软"}字幕（按剧本台词生成）。字幕文件：${subtitled.srtUrl}`,
        );
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.emitter.sendMessage("compose", `⚠️ 字幕没加上（${reason.slice(0, 120)}），成片先不带字幕。`);
    }
  }
  ctx.emitter.commit("project_updated", () => {
    ctx.shared.updateProject(ctx.projectId, { video_url: mergedUrl, status: "ready" });
    return { project: { id: ctx.projectId, video_url: mergedUrl, status: "ready" } };
  });
  await ctx.emitter.sendMessage(
    "compose",
    "已将分镜拼接为完整视频\n您的漫剧已经准备就绪！可以下载或分享了。",
    { progress: 1 },
  );
}
