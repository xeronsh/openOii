/**
 * Domain persistence on the app's shared SQLite schema.
 *
 * Column names/types mirror the SQLModel tables (backend/app/models). All
 * writes are parameterized prepared statements on better-sqlite3.
 *
 * A pipeline receives a fenced SharedDb instance. Every mutation checks the
 * run's durable lease token first, so an expired/orphan executor can finish an
 * external provider request but cannot commit stale data afterwards.
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
  revision: number;
}

export interface AgentRunRow {
  id: number;
  project_id: number;
  status: string;
  current_agent: string | null;
  progress: number;
  error: string | null;
  confirm_requested: 0 | 1 | boolean | null;
  awaiting_payload: string | null;
  workflow_version: number;
  execution_attempt: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  context_snapshot: string | null;
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
  revision: number;
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
  revision: number;
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
    revision: c.revision,
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
    revision: s.revision,
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

interface ExecutionFence {
  runId: number;
  token: string;
}

export interface FrozenStageInput {
  project: ProjectRow | null;
  characters: CharacterRow[];
  shots: ShotRow[];
}

/**
 * Raised when a writer's revision no longer matches the stored row.
 *
 * Both the HTTP API and the engine write project/character/shot, so a stale
 * edit must be surfaced instead of silently overwriting the other writer.
 */
export class ConcurrentModificationError extends Error {
  constructor(
    readonly entity: string,
    readonly entityId: number,
    readonly expectedRevision: number,
  ) {
    super(
      `${entity} ${entityId} was modified concurrently ` +
        `(expected revision ${expectedRevision}); re-read and retry`,
    );
    this.name = "ConcurrentModificationError";
  }
}

function isInlineLocation(value: string): boolean {
  return /^(?:x'|X')/.test(value.trim());
}

export class SharedDb {
  constructor(
    private readonly db: Database.Database,
    private readonly fence?: ExecutionFence,
    /**
     * Input frozen before the current stage attempt's first side effect.
     *
     * A stage mutates project/character/shot as it runs, so a resume that
     * re-read them would regenerate against half-written state and issue a
     * *different* request under the *same* idempotency key. `executeStageAttempt`
     * installs this via `withFrozenStageInput`; entity reads then serve the
     * snapshot, while writes still hit the live database.
     */
    private readonly frozenInput?: FrozenStageInput,
  ) {}

  fenced(runId: number, token: string): SharedDb {
    return new SharedDb(this.db, { runId, token }, this.frozenInput);
  }

  /** Install the frozen stage input for the duration of one stage attempt. */
  withFrozenStageInput(input: FrozenStageInput): SharedDb {
    this.assertExecutionFence();
    return new SharedDb(this.db, this.fence, input);
  }

  assertExecutionFence(): void {
    if (!this.fence) return;
    if (!this.runLeaseOwned(this.fence.runId, this.fence.token)) {
      throw new Error(`execution lease lost for run ${this.fence.runId}`);
    }
  }

  // ---- project ----

  getProject(projectId: number): ProjectRow | undefined {
    if (this.frozenInput && this.frozenInput.project?.id === projectId) {
      return this.frozenInput.project;
    }
    return this.db.prepare("SELECT * FROM project WHERE id = ?").get(projectId) as
      | ProjectRow
      | undefined;
  }

  /**
   * Compare-and-set on an explicit expected revision.
   *
   * The caller must pass the revision it actually read. Re-reading it here
   * would defeat the check entirely: the engine holds a stale snapshot of the
   * entity (it read it at stage start), so the write must state that snapshot's
   * revision or the concurrent HTTP edit goes unnoticed.
   */
  private casWrite(
    entity: "project" | "character" | "shot",
    entityId: number,
    expectedRevision: number,
    fields: Record<string, unknown>,
    extraSet = "",
  ): void {
    this.assertExecutionFence();
    const entries = Object.entries(fields).filter(([k]) => k !== "id" && k !== "revision");
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const info = this.db
      .prepare(
        `UPDATE ${entity} SET ${sets}, revision = revision + 1${extraSet}
         WHERE id = ? AND revision = ?`,
      )
      .run(
        ...entries.map(([, v]) =>
          v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : v,
        ),
        entityId,
        expectedRevision,
      );
    if (info.changes === 0) {
      throw new ConcurrentModificationError(entity, entityId, expectedRevision);
    }
  }

  /**
   * Revision this writer read for the entity, i.e. the one it is allowed to
   * write against. Falls back to the live row so a caller that did not capture
   * a snapshot still compares against current state instead of blindly writing.
   */
  private expectedRevision(entity: "project" | "character" | "shot", entityId: number): number {
    if (this.frozenInput) {
      if (entity === "project" && this.frozenInput.project?.id === entityId) {
        return this.frozenInput.project.revision;
      }
      if (entity === "character") {
        const frozen = this.frozenInput.characters.find((c) => c.id === entityId);
        if (frozen) return frozen.revision;
      }
      if (entity === "shot") {
        const frozen = this.frozenInput.shots.find((s) => s.id === entityId);
        if (frozen) return frozen.revision;
      }
    }
    const row = this.db.prepare(`SELECT revision FROM ${entity} WHERE id = ?`).get(entityId) as
      | { revision: number }
      | undefined;
    return row?.revision ?? -1;
  }

  updateProject(projectId: number, fields: Partial<ProjectRow> & Record<string, unknown>): void {
    this.casWrite(
      "project",
      projectId,
      this.expectedRevision("project", projectId),
      fields,
      ", updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    );
  }

  // ---- agentrun ----

  getRun(runId: number): AgentRunRow | undefined {
    return this.db.prepare("SELECT * FROM agentrun WHERE id = ?").get(runId) as
      | AgentRunRow
      | undefined;
  }

  updateRun(runId: number, fields: Record<string, unknown>): void {
    this.assertExecutionFence();
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.db
      .prepare(
        `UPDATE agentrun SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(...entries.map(([, v]) => (v === undefined ? null : v)), runId);
  }

  acquireRunLease(runId: number, owner: string, token: string, ttlSeconds: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE agentrun
         SET execution_attempt = COALESCE(execution_attempt, 0) + 1,
             lease_owner = ?, lease_token = ?,
             lease_expires_at = datetime('now', ?),
             cancel_requested_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?
           AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= datetime('now'))`,
      )
      .run(owner, token, `+${ttlSeconds} seconds`, runId);
    return info.changes === 1;
  }

  renewRunLease(runId: number, owner: string, token: string, ttlSeconds: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE agentrun
         SET lease_expires_at = datetime('now', ?),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND lease_owner = ? AND lease_token = ?`,
      )
      .run(`+${ttlSeconds} seconds`, runId, owner, token);
    return info.changes === 1;
  }

  releaseRunLease(runId: number, owner: string, token: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE agentrun
         SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND lease_owner = ? AND lease_token = ?`,
      )
      .run(runId, owner, token);
    return info.changes === 1;
  }

  runLeaseOwned(runId: number, token: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS owned FROM agentrun
         WHERE id = ? AND lease_token = ?
           AND lease_expires_at IS NOT NULL AND lease_expires_at > datetime('now')`,
      )
      .get(runId, token) as { owned: number } | undefined;
    return row?.owned === 1;
  }

  runCancelRequested(runId: number): boolean {
    const row = this.db
      .prepare("SELECT cancel_requested_at FROM agentrun WHERE id = ?")
      .get(runId) as { cancel_requested_at: string | null } | undefined;
    return Boolean(row?.cancel_requested_at);
  }

  requestRunCancel(runId: number): void {
    this.db
      .prepare(
        `UPDATE agentrun
         SET cancel_requested_at = COALESCE(cancel_requested_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
             status = CASE WHEN status IN ('queued','running','waiting_for_approval') THEN 'cancelling' ELSE status END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(runId);
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
    this.assertExecutionFence();
    this.db
      .prepare(
        `INSERT INTO message (project_id, run_id, agent, role, content, summary, progress, is_loading, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(
        projectId,
        runId,
        agent,
        role,
        content,
        summary ?? null,
        progress ?? null,
        isLoading ? 1 : 0,
      );
  }

  insertAgentMessage(runId: number, agent: string, role: string, content: string): void {
    this.assertExecutionFence();
    this.db
      .prepare(
        `INSERT INTO agentmessage (run_id, agent, role, content, created_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run(runId, agent, role, content);
  }

  // ---- characters ----

  charactersForProject(projectId: number): CharacterRow[] {
    if (this.frozenInput) {
      return this.frozenInput.characters.filter((c) => c.project_id === projectId);
    }
    return this.db
      .prepare("SELECT * FROM character WHERE project_id = ? ORDER BY id")
      .all(projectId) as CharacterRow[];
  }

  getCharacter(characterId: number): CharacterRow | undefined {
    const frozen = this.frozenInput?.characters.find((c) => c.id === characterId);
    if (frozen) return frozen;
    return this.db.prepare("SELECT * FROM character WHERE id = ?").get(characterId) as
      | CharacterRow
      | undefined;
  }

  insertCharacter(
    projectId: number,
    name: string,
    description: string | null,
    visualNotes: string | null,
  ): number {
    this.assertExecutionFence();
    const info = this.db
      .prepare(
        "INSERT INTO character (project_id, name, description, visual_notes, approval_version) VALUES (?, ?, ?, ?, 0)",
      )
      .run(projectId, name, description, visualNotes);
    return Number(info.lastInsertRowid);
  }

  updateCharacter(characterId: number, fields: Record<string, unknown>): void {
    this.casWrite(
      "character",
      characterId,
      this.expectedRevision("character", characterId),
      fields,
    );
  }

  deleteCharacter(characterId: number): void {
    this.assertExecutionFence();
    this.db.prepare("DELETE FROM character WHERE id = ?").run(characterId);
  }

  // ---- shots ----

  shotsForProject(projectId: number): ShotRow[] {
    if (this.frozenInput) {
      return this.frozenInput.shots.filter((s) => s.project_id === projectId);
    }
    return this.db
      .prepare('SELECT * FROM shot WHERE project_id = ? ORDER BY "order"')
      .all(projectId) as unknown as ShotRow[];
  }

  getShot(shotId: number): ShotRow | undefined {
    const frozen = this.frozenInput?.shots.find((s) => s.id === shotId);
    if (frozen) return frozen;
    return this.db.prepare("SELECT * FROM shot WHERE id = ?").get(shotId) as ShotRow | undefined;
  }

  insertShot(
    projectId: number,
    order: number,
    fields: Omit<Partial<ShotRow>, "character_ids"> & { character_ids?: number[] },
  ): number {
    this.assertExecutionFence();
    const info = this.db
      .prepare(
        `INSERT INTO shot (project_id, "order", description, character_ids, approval_version)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(projectId, order, fields.description ?? "", JSON.stringify(fields.character_ids ?? []));
    const id = Number(info.lastInsertRowid);
    const extra = Object.entries(fields).filter(
      ([k]) => !["id", "project_id", "description", "character_ids"].includes(k),
    );
    if (extra.length > 0) this.updateShot(id, Object.fromEntries(extra));
    return id;
  }

  updateShot(shotId: number, fields: Record<string, unknown>): void {
    const prepared = Object.fromEntries(
      Object.entries(fields)
        .filter(([k]) => k !== "id" && k !== "order" && k !== "revision")
        .map(([k, v]) =>
          typeof v === "object" && v !== null
            ? [k, JSON.stringify(v)]
            : v === undefined
              ? [k, null]
              : k.endsWith("_ids")
                ? [k, JSON.stringify(v)]
                : [k, v],
        ),
    );
    this.casWrite("shot", shotId, this.expectedRevision("shot", shotId), prepared);
  }

  deleteShot(shotId: number): void {
    this.assertExecutionFence();
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
    this.assertExecutionFence();
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
      .run(
        projectId,
        entityType,
        entityId,
        nextVersion,
        JSON.stringify(snapshot),
        runId,
        trigger,
      );
    void Number(info.lastInsertRowid);
    return nextVersion;
  }
}
