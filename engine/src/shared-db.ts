/**
 * Domain persistence on the app's shared SQLite schema.
 *
 * Column names/types mirror the SQLModel tables (backend/app/models). All
 * writes are parameterized prepared statements on better-sqlite3 (sync, fast,
 * single writer per process — see phase 2 notes on BEGIN semantics).
 */
import type Database from "better-sqlite3";

export interface ProjectRow {
  id: number;
  title: string | null;
  story: string | null;
  style: string | null;
  summary: string | null;
  status: string | null;
  video_url: string | null;
  target_shot_count: number | null;
  character_hints: string | null; // JSON
  creation_mode: string | null;
  reference_images: string | null; // JSON
  skill_id: string | null;
  story_outline: string | null; // JSON
  visual_bible: string | null;
  outline_approved: boolean | number | null;
}

export interface AgentRunRow {
  id: number;
  project_id: number;
  status: string;
  current_agent: string | null;
  progress: number;
  error: string | null;
  thread_id: string | null;
  confirm_requested: 0 | 1 | boolean | null;
  awaiting_payload: string | null;
}

export interface CharacterRow {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  reference_images: string | null; // JSON
  visual_notes: string | null;
  approved_name: string | null;
  approved_description: string | null;
  approved_image_url: string | null;
  approved_at: string | null;
  approval_version: number;
}

export interface ShotRow {
  id: number;
  project_id: number;
  order: number;
  description: string;
  prompt: string | null;
  image_prompt: string | null;
  image_url: string | null;
  video_url: string | null;
  duration: number | null;
  camera: string | null;
  motion_note: string | null;
  scene: string | null;
  action: string | null;
  expression: string | null;
  lighting: string | null;
  dialogue: string | null;
  sfx: string | null;
  tts_url: string | null;
  bgm_type: string | null;
  seed: number | null;
  character_ids: string | null; // JSON
  approved_description: string | null;
  approved_prompt: string | null;
  approved_image_prompt: string | null;
  approved_duration: number | null;
  approved_camera: string | null;
  approved_motion_note: string | null;
  approved_scene: string | null;
  approved_action: string | null;
  approved_expression: string | null;
  approved_lighting: string | null;
  approved_dialogue: string | null;
  approved_sfx: string | null;
  approved_character_ids: string | null; // JSON
  approved_at: string | null;
  approval_version: number;
}

export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function characterApprovalState(c: CharacterRow): "draft" | "approved" | "superseded" {
  if (c.approval_version <= 0 || c.approved_at === null) return "draft";
  if (
    c.name === c.approved_name &&
    c.description === c.approved_description &&
    c.image_url === c.approved_image_url
  )
    return "approved";
  return "superseded";
}

export function characterReadPayload(c: CharacterRow): Record<string, unknown> {
  return {
    id: c.id,
    project_id: c.project_id,
    name: c.name,
    description: c.description,
    image_url: c.image_url,
    reference_images: parseJsonColumn(c.reference_images, [] as string[]),
    has_embedding: false,
    visual_notes: c.visual_notes,
    approval_state: characterApprovalState(c),
    approval_version: c.approval_version,
    approved_at: c.approved_at,
    approved_name: c.approved_name,
    approved_description: c.approved_description,
    approved_image_url: c.approved_image_url,
  };
}

export function shotReadPayload(s: ShotRow): Record<string, unknown> {
  return {
    id: s.id,
    project_id: s.project_id,
    order: s.order,
    description: s.description,
    prompt: s.prompt,
    image_prompt: s.image_prompt,
    image_url: s.image_url,
    video_url: s.video_url,
    duration: s.duration,
    camera: s.camera,
    motion_note: s.motion_note,
    scene: s.scene,
    action: s.action,
    expression: s.expression,
    lighting: s.lighting,
    dialogue: s.dialogue,
    sfx: s.sfx,
    tts_url: s.tts_url,
    bgm_type: s.bgm_type,
    seed: s.seed,
    character_ids: parseJsonColumn(s.character_ids, [] as number[]),
    approval_state:
      s.approval_version <= 0 || s.approved_at === null
        ? "draft"
        : "superseded",
    approval_version: s.approval_version,
    approved_at: s.approved_at,
    approved_description: s.approved_description,
    approved_prompt: s.approved_prompt,
    approved_image_prompt: s.approved_image_prompt,
    approved_duration: s.approved_duration,
    approved_camera: s.approved_camera,
    approved_motion_note: s.approved_motion_note,
    approved_scene: s.approved_scene,
    approved_action: s.approved_action,
    approved_expression: s.approved_expression,
    approved_lighting: s.approved_lighting,
    approved_dialogue: s.approved_dialogue,
    approved_sfx: s.approved_sfx,
    approved_character_ids: parseJsonColumn(s.approved_character_ids, [] as number[]),
  };
}

const CHARACTER_SNAPSHOT_FIELDS = [
  "id",
  "project_id",
  "name",
  "description",
  "image_url",
  "reference_images",
  "visual_notes",
  "approved_name",
  "approved_description",
  "approved_image_url",
  "approved_at",
  "approval_version",
] as const;

const SHOT_SNAPSHOT_FIELDS = [
  "id",
  "project_id",
  "order",
  "description",
  "prompt",
  "image_prompt",
  "image_url",
  "video_url",
  "duration",
  "camera",
  "motion_note",
  "scene",
  "action",
  "expression",
  "lighting",
  "dialogue",
  "sfx",
  "tts_url",
  "bgm_type",
  "seed",
  "character_ids",
  "approved_description",
  "approved_prompt",
  "approved_image_prompt",
  "approved_duration",
  "approved_camera",
  "approved_motion_note",
  "approved_scene",
  "approved_action",
  "approved_expression",
  "approved_lighting",
  "approved_dialogue",
  "approved_sfx",
  "approved_character_ids",
  "approved_at",
  "approval_version",
] as const;

function snapshotOf(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = row[f];
    if (typeof v === "string" && (f.endsWith("_ids") || f === "reference_images")) {
      out[f] = parseJsonColumn(v, [] as unknown[]);
    } else {
      out[f] = v ?? null;
    }
  }
  return out;
}

export class SharedDb {
  constructor(private readonly db: Database.Database) {}

  // ---- project ----

  getProject(projectId: number): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM project WHERE id = ?").get(projectId) as
      | ProjectRow
      | undefined;
  }

  updateProject(projectId: number, fields: Partial<ProjectRow> & Record<string, unknown>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== "id");
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db
      .prepare(
        `UPDATE project SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(...entries.map(([, v]) => (v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : v)), projectId);
  }

  // ---- agentrun ----

  getRun(runId: number): AgentRunRow | undefined {
    return this.db.prepare("SELECT * FROM agentrun WHERE id = ?").get(runId) as
      | AgentRunRow
      | undefined;
  }

  updateRun(runId: number, fields: Record<string, unknown>): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db
      .prepare(
        `UPDATE agentrun SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(...entries.map(([, v]) => (v === undefined ? null : v)), runId);
  }

  consumeConfirmSignal(runId: number): boolean {
    const row = this.db
      .prepare("SELECT confirm_requested FROM agentrun WHERE id = ?")
      .get(runId) as { confirm_requested: 0 | 1 | null } | undefined;
    if (row?.confirm_requested) {
      this.updateRun(runId, { confirm_requested: 0 });
      return true;
    }
    return false;
  }

  clearConfirmSignal(runId: number): void {
    this.updateRun(runId, { confirm_requested: 0 });
  }

  setAwaitingPayload(runId: number, payload: unknown | null): void {
    this.updateRun(runId, {
      awaiting_payload: payload === null ? null : JSON.stringify(payload),
    });
  }

  // ---- messages ----

  insertMessage(
    projectId: number,
    runId: number | null,
    agent: string,
    role: string,
    content: string,
    summary?: string | null,
    progress?: number | null,
    isLoading?: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO message (project_id, run_id, agent, role, content, summary, progress, is_loading, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId, runId, agent, role, content, summary ?? null, progress ?? null, isLoading ? 1 : 0);
  }

  insertAgentMessage(runId: number, agent: string, role: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO agentmessage (run_id, agent, role, content, created_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(runId, agent, role, content);
  }

  // ---- characters ----

  charactersForProject(projectId: number): CharacterRow[] {
    return this.db.prepare("SELECT * FROM character WHERE project_id = ? ORDER BY id").all(projectId) as CharacterRow[];
  }

  getCharacter(characterId: number): CharacterRow | undefined {
    return this.db.prepare("SELECT * FROM character WHERE id = ?").get(characterId) as
      | CharacterRow
      | undefined;
  }

  insertCharacter(projectId: number, name: string, description: string | null, visualNotes: string | null): number {
    const info = this.db
      .prepare(
        "INSERT INTO character (project_id, name, description, visual_notes, approval_version) VALUES (?, ?, ?, ?, 0)",
      )
      .run(projectId, name, description, visualNotes);
    return Number(info.lastInsertRowid);
  }

  updateCharacter(characterId: number, fields: Record<string, unknown>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== "id");
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE character SET ${sets} WHERE id = ?`)
      .run(...entries.map(([, v]) => (v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : v)), characterId);
  }

  deleteCharacter(characterId: number): void {
    this.db.prepare("DELETE FROM character WHERE id = ?").run(characterId);
  }

  // ---- shots ----

  shotsForProject(projectId: number): ShotRow[] {
    return this.db.prepare("SELECT * FROM shot WHERE project_id = ? ORDER BY \"order\"").all(projectId) as unknown as ShotRow[];
  }

  getShot(shotId: number): ShotRow | undefined {
    return this.db.prepare("SELECT * FROM shot WHERE id = ?").get(shotId) as ShotRow | undefined;
  }

  insertShot(
    projectId: number,
    order: number,
    fields: Omit<Partial<ShotRow>, "character_ids"> & { character_ids?: number[] },
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO shot (project_id, "order", description, character_ids, approval_version)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(projectId, order, fields.description ?? "", JSON.stringify(fields.character_ids ?? []));
    const id = Number(info.lastInsertRowid);
    const extra = Object.entries(fields).filter(([k]) => !["id", "project_id", "description", "character_ids"].includes(k));
    if (extra.length > 0) this.updateShot(id, Object.fromEntries(extra));
    return id;
  }

  updateShot(shotId: number, fields: Record<string, unknown>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== "id" && k !== "order");
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE shot SET ${sets} WHERE id = ?`)
      .run(...entries.map(([k, v]) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v === undefined ? null : k.endsWith("_ids") ? JSON.stringify(v) : v)), shotId);
  }

  deleteShot(shotId: number): void {
    this.db.prepare("DELETE FROM shot WHERE id = ?").run(shotId);
  }

  // ---- artifact versions ----

  createVersion(
    projectId: number,
    entityType: "character" | "shot",
    entityId: number,
    row: CharacterRow | ShotRow,
    runId: number | null,
    trigger: string,
  ): number {
    // returns the created version number
    const fields = entityType === "character" ? CHARACTER_SNAPSHOT_FIELDS : SHOT_SNAPSHOT_FIELDS;
    const snapshot = snapshotOf(row as unknown as Record<string, unknown>, fields);
    const maxRow = this.db
      .prepare(
        "SELECT MAX(version) AS v FROM artifactversion WHERE entity_type = ? AND entity_id = ?",
      )
      .get(entityType, entityId) as { v: number | null };
    const nextVersion = (maxRow.v ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO artifactversion (project_id, entity_type, entity_id, version, snapshot, run_id, trigger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(projectId, entityType, entityId, nextVersion, JSON.stringify(snapshot), runId, trigger);
    void Number(info.lastInsertRowid);
    return nextVersion;
  }
}
