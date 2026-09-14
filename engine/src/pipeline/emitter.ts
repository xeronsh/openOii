/**
 * Contract event emitter: every pipeline event is recorded into
 * engine_run_events with the WS-contract payload shape.
 *
 * Event publication is fenced by the run execution lease. A stale executor may
 * finish an external provider request, but after losing its lease it cannot
 * append authoritative events or mutate domain projections.
 */
import { progressForStage } from "../contract.js";
import type { EngineDatabase } from "../db.js";
import type { SharedDb } from "../shared-db.js";

export interface EmitterConfig {
  thinkingChainEnabled: boolean;
  thinkingDetailLevel: "minimal" | "normal" | "verbose";
}

const PHASE_VISIBILITY: Record<string, Set<string>> = {
  minimal: new Set(["decision"]),
  normal: new Set(["decision", "reviewing"]),
  verbose: new Set(["reasoning", "decision", "planning", "reviewing"]),
};

export class PipelineEmitter {
  constructor(
    private readonly db: EngineDatabase,
    private readonly shared: SharedDb,
    private readonly projectId: number,
    private readonly runId: number,
    private readonly config: EmitterConfig,
  ) {}

  emit(type: string, data: Record<string, unknown>): void {
    this.shared.assertExecutionFence();
    this.db.appendEvent(this.runId, this.projectId, type, data);
  }

  /**
   * Mutate domain state and append its durable event in ONE transaction.
   *
   * A crash between the two used to leave the database new while no client ever
   * received the corresponding event (or the reverse). The mutation callback
   * performs the writes and returns the exact event payload, so the append
   * cannot drift from what was written.
   *
   * The callback must be synchronous; better-sqlite3 transactions cannot span
   * an await point.
   */
  commit<T extends Record<string, unknown>>(type: string, mutation: () => T): T {
    this.shared.assertExecutionFence();
    let payload!: T;
    this.db.transaction(() => {
      payload = mutation();
      this.db.appendEvent(this.runId, this.projectId, type, payload);
    });
    return payload;
  }

  async sendMessage(
    agent: string,
    content: string,
    opts: { summary?: string; progress?: number; isLoading?: boolean } = {},
  ): Promise<void> {
    const data: Record<string, unknown> = {
      agent,
      role: "assistant",
      content,
      project_id: this.projectId,
      run_id: this.runId,
    };
    if (opts.summary !== undefined) data.summary = opts.summary;
    if (opts.progress !== undefined) data.progress = opts.progress;
    if (opts.isLoading) data.isLoading = true;

    this.shared.insertMessage(
      this.projectId,
      this.runId,
      agent,
      "assistant",
      content,
      opts.summary ?? null,
      opts.progress ?? null,
      opts.isLoading ?? false,
    );
    this.emit("run_message", data);
  }

  async sendThinking(
    agent: string,
    phase: "reasoning" | "decision" | "planning" | "reviewing",
    content: string,
    details?: string,
  ): Promise<void> {
    if (!this.config.thinkingChainEnabled) return;
    if (!PHASE_VISIBILITY[this.config.thinkingDetailLevel]?.has(phase)) return;
    this.emit("agent_thinking", { agent, phase, content, details: details ?? null });
    // backward-compatible chat display row
    this.shared.insertMessage(this.projectId, this.runId, agent, "thinking", content);
    this.emit("run_message", {
      agent,
      role: "thinking",
      content,
      project_id: this.projectId,
      run_id: this.runId,
    });
  }

  sendProgress(
    currentAgent: string,
    stage: string,
    nextStage: string | null,
    withinStage = 0,
  ): void {
    this.emit("run_progress", {
      run_id: this.runId,
      project_id: this.projectId,
      current_agent: currentAgent,
      current_stage: stage,
      stage,
      next_stage: nextStage,
      progress: progressForStage(stage, withinStage),
    });
  }

  projectUpdated(fields: Record<string, unknown>): void {
    this.emit("project_updated", { project: { id: this.projectId, ...fields } });
  }

  characterCreated(row: Record<string, unknown>): void {
    this.emit("character_created", { character: row });
  }

  characterUpdated(row: Record<string, unknown>): void {
    this.emit("character_updated", { character: row });
  }

  characterDeleted(characterId: number): void {
    this.emit("character_deleted", { character_id: characterId });
  }

  shotCreated(row: Record<string, unknown>): void {
    this.emit("shot_created", { shot: row });
  }

  shotUpdated(row: Record<string, unknown>): void {
    this.emit("shot_updated", { shot: row });
  }

  versionCreated(
    entityType: "character" | "shot",
    entityId: number,
    version: number,
    trigger: string,
  ): void {
    this.emit("version_created", {
      entity_type: entityType,
      entity_id: entityId,
      version,
      trigger,
    });
  }

  critiqueResult(data: {
    score: number;
    dimensions: Record<string, number>;
    issues: string[];
    suggestions: string[];
    entity_type: string;
    entity_id: number;
    will_regenerate: boolean;
  }): void {
    this.emit("critique_result", data);
  }

  consistencyEvalCompleted(overallScore: number, characterCount: number): void {
    this.emit("consistency_eval_completed", {
      project_id: this.projectId,
      overall_score: overallScore,
      character_count: characterCount,
    });
  }
}
