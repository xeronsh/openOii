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
import type { TextLlmService } from "../llm.js";
import type { MediaService } from "../media/media.js";
import type { MediaSettings } from "../media/media.js";
import {
  buildCharacterPrompt,
  buildShotPrompt,
  type ResolvedStylePrompt,
} from "../style.js";
import type { AiOperation } from "../ai-operation.js";

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

async function callLlm(
  ctx: StageContext,
  agent: string,
  system: string,
  prompt: string,
  maxTokens = 4096,
): Promise<Record<string, unknown>> {
  const res = await ctx.llm.generate({
    system,
    prompt,
    maxTokens,
    signal: ctx.signal,
    operation: ctx.operation ?? undefined,
  });
  ctx.shared.insertAgentMessage(ctx.runId, agent, "assistant", res.text);
  return extractJson(res.text);
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
  await ctx.emitter.sendMessage("outline", "正在生成故事大纲...", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("outline", "planning", "正在提炼故事核心、三幕结构和视觉方向...");

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
  const data = await callLlm(ctx, "outline", system, JSON.stringify(payload), 2048);

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
  ctx.shared.updateProject(ctx.projectId, updatedFields);
  ctx.emitter.projectUpdated(updatedFields);

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
  await ctx.emitter.sendMessage("plan", "正在规划角色设定...", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("plan", "planning", "正在设计角色设定与人物关系...");

  const payload = planBasePayload(ctx, "characters");
  const data = await callLlm(ctx, "plan", PROMPTS["plan.SYSTEM_PROMPT"], JSON.stringify(payload), 4096);
  await applyCharacterPlan(ctx, data);

  await ctx.emitter.sendThinking("plan", "decision", "角色设定完成，等待分镜脚本...");
  ctx.completionInfo = {
    completed: "角色设定已生成",
    details: "共 3 个角色",
    next: "接下来生成分镜脚本",
    question: "角色设定是否满意？",
  };
}

export async function runPlanShots(ctx: StageContext): Promise<void> {
  await ctx.emitter.sendMessage("plan", "正在生成分镜脚本...", { progress: 0, isLoading: true });
  await ctx.emitter.sendThinking("plan", "planning", "正在分镜与节奏设计...");

  const payload = planBasePayload(ctx, "shots");
  const data = await callLlm(ctx, "plan", PROMPTS["plan.SYSTEM_PROMPT"], JSON.stringify(payload), 4096);
  await applyShotPlan(ctx, data);

  await ctx.emitter.sendThinking("plan", "decision", "分镜脚本完成...");
  ctx.completionInfo = {
    completed: "分镜脚本已生成",
    details: "分镜与节奏已确定",
    next: "确认后进入渲染阶段",
    question: "分镜是否符合预期？",
  };
}

async function applyCharacterPlan(ctx: StageContext, data: Record<string, unknown>): Promise<void> {
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
}

function nextVersion(ctx: StageContext, entityType: "character" | "shot", entityId: number): number {
  const q = ctx.shared as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => { v: number | null } | undefined } } };
  const row = q.db
    .prepare("SELECT MAX(version) AS v FROM artifactversion WHERE entity_type = ? AND entity_id = ?")
    .get(entityType, entityId);
  return (row?.v ?? 0) + 1;
}

async function applyShotPlan(ctx: StageContext, data: Record<string, unknown>): Promise<void> {
  const rawShots = Array.isArray(data.shots) ? data.shots : [];
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const nameToId = new Map(characters.map((c) => [c.name, c.id]));

  // wipe-and-recreate shots (full mode parity with plan.py full re-plan)
  for (const existing of ctx.shared.shotsForProject(ctx.projectId)) {
    ctx.shared.deleteShot(existing.id);
    ctx.emitter.emit("shot_deleted", { shot_id: existing.id });
  }

  rawShots.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const s = item as PlanShot;
    const characterIds = (s.character_names ?? [])
      .map((n) => nameToId.get(n))
      .filter((x): x is number => typeof x === "number");
    const description = s.description ?? s.action ?? `分镜 ${index + 1}`;
    const id = ctx.shared.insertShot(ctx.projectId, index + 1, {
      description,
      character_ids: characterIds,
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
  await ctx.emitter.sendMessage("render", "开始生成角色形象图...", { progress: 0, isLoading: true });
  const total = characters.length;
  let index = 0;
  for (const character of characters) {
    index += 1;
    ctx.emitter.sendProgress("render", "render_characters", "character_images_approval", index / total);
    await ctx.emitter.sendMessage("render", `正在绘制：${character.name} (${index}/${total})`);
    // Identity lock + style lock + universe style: parity with the Python
    // render agent, which is a precondition for deleting it (ADR 0008).
    const prompt = ctx.style
      ? buildCharacterPrompt({
          character,
          style: ctx.style,
          universeStyle: ctx.universeStyle,
          userFeedback: ctx.userFeedback,
        })
      : `角色立绘：${character.name}。${character.description ?? ""} ${character.visual_notes ?? ""} ${ctx.shared.getProject(ctx.projectId)?.visual_bible ?? ""}`.trim();
    const imageUrl = await ctx.media.generateImageUrl({ prompt });
    const before = ctx.shared.getCharacter(character.id);
    if (!before) continue;
    const version = ctx.shared.createVersion(ctx.projectId, "character", character.id, before, ctx.runId, "generation");
    ctx.emitter.versionCreated("character", character.id, version, "generation");
    // State write and its event are one transaction: a crash in between must
    // not leave the row new while clients never learn about it.
    const updated = ctx.emitter.commit("character_updated", () => {
      ctx.shared.updateCharacter(character.id, { image_url: imageUrl });
      const after = ctx.shared.getCharacter(character.id);
      return { character: characterReadPayload(after ?? before) };
    });
    void updated;
  }
  await ctx.emitter.sendMessage("render", `已为 ${total} 个角色生成形象图，接下来生成分镜图。`);
  ctx.completionInfo = {
    completed: "角色形象图已渲染完成",
    details: `已生成 ${total} 个角色形象图`,
    next: "接下来渲染分镜画面",
    question: "角色形象是否满意？如果需要重新生成，请告诉我。",
  };
}

export async function runRenderShots(ctx: StageContext): Promise<void> {
  const allShots = ctx.shared.shotsForProject(ctx.projectId);
  const shots = ctx.targetShotIds
    ? allShots.filter((shot) => ctx.targetShotIds!.includes(shot.id))
    : allShots;
  await ctx.emitter.sendMessage("render", "开始生成分镜首帧图...", { progress: 0, isLoading: true });
  const characters = ctx.shared.charactersForProject(ctx.projectId);
  const idToName = new Map(characters.map((c) => [c.id, c.name]));
  const byId = new Map(characters.map((c) => [c.id, c]));
  let index = 0;
  for (const shot of shots) {
    index += 1;
    ctx.emitter.sendProgress("render", "render_shots", "shot_images_approval", index / shots.length);
    const ids = parseJsonColumn(shot.character_ids, [] as number[]);
    const names = ids.map((id) => idToName.get(id) ?? `#${id}`);
    // Character bible + continuity lock + style lock (Python render parity).
    const prompt = ctx.style
      ? buildShotPrompt({
          shot,
          characters: ids
            .map((id) => byId.get(id))
            .filter((c): c is CharacterRow => c !== undefined),
          style: ctx.style,
          universeStyle: ctx.universeStyle,
          userFeedback: ctx.userFeedback,
        })
      : [
          `分镜首帧：${shot.description}`,
          shot.scene ? `场景：${shot.scene}` : "",
          shot.lighting ? `光线：${shot.lighting}` : "",
          names.length ? `角色：${names.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("。");
    await ctx.emitter.sendMessage("render", `正在绘制分镜 (${index}/${shots.length})`);
    const imageUrl = await ctx.media.generateImageUrl({ prompt });
    const before = ctx.shared.getShot(shot.id);
    if (!before) continue;
    const version = ctx.shared.createVersion(ctx.projectId, "shot", shot.id, before, ctx.runId, "generation");
    ctx.emitter.versionCreated("shot", shot.id, version, "generation");
    ctx.emitter.commit("shot_updated", () => {
      ctx.shared.updateShot(shot.id, { image_url: imageUrl });
      const after = ctx.shared.getShot(shot.id);
      return { shot: shotReadPayload(after ?? before) };
    });
  }
  ctx.completionInfo = {
    completed: "分镜画面已渲染完成",
    details: `已生成 ${shots.length} 个分镜首帧图`,
    next: "接下来将根据分镜生成视频片段并合成",
    question: "分镜画面是否满意？如果需要重新生成，请告诉我。",
  };
}

// ---------------------------------------------------------------------------
// Critic agent (critic.py + review_rules port)
// ---------------------------------------------------------------------------

export interface CritiqueOutcome {
  willRegenerate: boolean;
  minScore: number;
}

export async function runCritique(
  ctx: StageContext,
  entityType: "character" | "shot",
): Promise<CritiqueOutcome> {
  const entities: Array<CharacterRow | ShotRow> =
    entityType === "character"
      ? ctx.shared.charactersForProject(ctx.projectId)
      : ctx.shared.shotsForProject(ctx.projectId);
  const rounds = entityType === "character" ? ctx.critiqueRounds.characters : ctx.critiqueRounds.shots;
  await ctx.emitter.sendMessage("critic", `开始审查 ${entities.length} 张${entityType === "character" ? "角色形象图" : "分镜图"}...`);

  let minScore = 10;
  let willRegenerate = false;
  for (const entity of entities) {
    const imageUrl = entity.image_url;
    const prompt = `You evaluate visual quality. Review image: ${imageUrl ?? "(none)"} for ${entityType} ${entityType === "character" ? ((entity as CharacterRow).name ?? "角色") : `分镜 #${entity.id}`}. Return JSON with total_score, consistency, quality, composition.`;
    // key 现在受字面量类型约束，拼错会编译失败（见 prompts.ts 注释）。
    // 这里不再写 `?? ""` —— 正是那种兜底让空 prompt 的 bug 静默上线。
    const systemPrompt =
      entityType === "character"
        ? PROMPTS["critic.CHARACTER_REVIEW_SYSTEM_PROMPT"]
        : PROMPTS["critic.SHOT_REVIEW_SYSTEM_PROMPT"];
    const data = await callLlm(ctx, "critic", systemPrompt, prompt, 1024);
    const score = Number(data.total_score ?? 0);
    const dimensions: Record<string, number> = {
      consistency: Number(data.consistency ?? 0),
      quality: Number(data.quality ?? 0),
      composition: Number(data.composition ?? 0),
    };
    const issues = Array.isArray(data.issues) ? (data.issues as string[]) : [];
    const suggestions = Array.isArray(data.suggestions) ? (data.suggestions as string[]) : [];
    const belowThreshold = score < ctx.critiqueScoreThreshold;
    if (score < minScore) minScore = score;
    const willRegen = belowThreshold && rounds < ctx.critiqueMaxRounds;
    if (willRegen) willRegenerate = true;
    ctx.emitter.critiqueResult({
      score,
      dimensions,
      issues,
      suggestions,
      entity_type: entityType,
      entity_id: entity.id,
      will_regenerate: willRegen,
    });
    await ctx.emitter.sendMessage(
      "critic",
      `${entityType === "character" ? ((entity as CharacterRow).name ?? "角色") : `分镜 #${entity.id}`} 审查结果：总分 ${score.toFixed(1)}/10${willRegen ? "，将重新生成" : "，质量达标"}`,
    );
  }
  if (entityType === "character" && !willRegenerate && entities.length > 0) {
    // consistency_eval service parity: overall score over character critiques
    const overall = Math.min(100, Math.round((minScore / 10) * 100));
    ctx.emitter.consistencyEvalCompleted(overall, entities.length);
  }
  return { willRegenerate, minScore };
}

// ---------------------------------------------------------------------------
// Compose agent (compose.py port: videos, merge, audio)
// ---------------------------------------------------------------------------

export async function runComposeVideos(ctx: StageContext): Promise<void> {
  const shots = ctx.shared.shotsForProject(ctx.projectId);
  await ctx.emitter.sendMessage("compose", `开始生成 ${shots.length} 个分镜视频...`, { progress: 0, isLoading: true });
  const useI2V = ctx.mediaSettings.enableImageToVideo;
  let index = 0;
  for (const shot of shots) {
    index += 1;
    ctx.emitter.sendProgress("compose", "compose_videos", "compose_merge", index / shots.length);
    await ctx.emitter.sendMessage("compose", `正在生成视频 (${index}/${shots.length})`);
    const prompt = `${shot.description}${shot.camera ? `（镜头：${shot.camera}）` : ""}`;
    const videoUrl = await ctx.media.generateVideoUrl({
      prompt,
      imageUrl: useI2V ? shot.image_url : null,
    });
    ctx.emitter.commit("shot_updated", () => {
      ctx.shared.updateShot(shot.id, { video_url: videoUrl });
      const after = ctx.shared.getShot(shot.id);
      return { shot: shotReadPayload(after ?? shot) };
    });
  }
}

export async function runComposeMerge(ctx: StageContext): Promise<void> {
  const shots = ctx.shared.shotsForProject(ctx.projectId).filter((s) => s.video_url);
  if (shots.length === 0) {
    await ctx.emitter.sendMessage("compose", "没有可拼接的分镜视频。");
    return;
  }
  await ctx.emitter.sendMessage("compose", `开始拼接 ${shots.length} 个分镜视频...`, { progress: 0, isLoading: true });
  const mergedUrl = await ctx.media.mergeVideos(shots.map((s) => s.video_url as string));
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

export async function runAddAudioPlaceholderRemoved(): Promise<void> {}
