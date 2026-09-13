/**
 * Pipeline runner: the generated linear workflow with approval gates,
 * stage checkpoints, durable stage attempts, critique regeneration routing,
 * cancellation and execution fencing.
 */
import { createHash } from "node:crypto";
import {
  AGENT_COMPLETION_INFO,
  GATE_AGENT,
  NEXT_STAGE,
  STAGE_ORDER,
  agentForStage,
  progressForStage,
  type StageId,
} from "../contract.js";
import type { EngineDatabase, StageAttemptRow } from "../db.js";
import {
  MediaService,
  resolveMediaSettings,
  type MediaProviderSnapshot,
  type MediaRunSnapshot,
} from "../media/media.js";
import { TextLlmService, type RunCreativeContext } from "../llm.js";
import { SharedDb, parseJsonColumn } from "../shared-db.js";
import {
  runAddAudio,
  runComposeMerge,
  runComposeVideos,
  runCritique,
  runOutline,
  runPlanCharacters,
  runPlanShots,
  runRenderCharacters,
  runRenderShots,
  type StageContext,
} from "../agents/index.js";
import { PipelineEmitter } from "./emitter.js";

export interface PipelineRequest {
  projectId: number;
  runId: number;
  autoMode: boolean;
  userFeedback: string;
  startStage?: StageId;
}

export interface PipelineOutcome {
  status: "completed" | "failed" | "cancelled";
  error?: string;
}

const CONFIRM_POLL_MS = 300;
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class PipelineRunner {
  private cancelRequested = false;

  constructor(
    private readonly db: EngineDatabase,
    private readonly shared: SharedDb,
    private readonly llm: TextLlmService,
    private readonly runContext?: RunCreativeContext,
  ) {}

  requestCancel(): void {
    this.cancelRequested = true;
  }

  private shouldCancel(runId: number): boolean {
    return this.cancelRequested || this.shared.runCancelRequested(runId);
  }

  private policy(): Record<string, unknown> | null {
    return asRecord(this.runContext?.policy);
  }

  private mediaSnapshot(): MediaRunSnapshot | null {
    if (!this.runContext) return null;
    const providers = asRecord(this.runContext.providers);
    return {
      image: asRecord(providers?.image) as MediaProviderSnapshot | null,
      video: asRecord(providers?.video) as MediaProviderSnapshot | null,
      policy: this.policy(),
    };
  }

  private boolPolicy(key: string, liveKey: string, fallback: boolean): boolean {
    const policy = this.policy();
    if (policy && key in policy) return asBoolean(policy[key], fallback);
    return (this.db.configValue(liveKey, liveKey, String(fallback)) ?? String(fallback)) === "true";
  }

  private numberPolicy(key: string, liveKey: string, fallback: number): number {
    const policy = this.policy();
    if (policy && key in policy) return asNumber(policy[key], fallback);
    return Number(this.db.configValue(liveKey, liveKey, String(fallback)) ?? fallback);
  }

  private stringPolicy(key: string, liveKey: string, fallback: string): string {
    const policy = this.policy();
    if (policy && typeof policy[key] === "string") return String(policy[key]);
    return this.db.configValue(liveKey, liveKey, fallback) ?? fallback;
  }

  /** Stable fingerprint of the authoritative inputs visible to one stage. */
  private stageInputHash(stage: StageId, request: PipelineRequest): string {
    const payload = {
      workflow_version: this.runContext?.workflow_version ?? null,
      stage,
      project: this.shared.getProject(request.projectId) ?? null,
      characters: this.shared.charactersForProject(request.projectId),
      shots: this.shared.shotsForProject(request.projectId),
      user_feedback: request.userFeedback,
      creative_context: this.runContext
        ? {
            skill: this.runContext.skill ?? null,
            universe_context: this.runContext.universe_context ?? null,
            style_template: this.runContext.style_template ?? null,
            providers: this.runContext.providers ?? null,
            policy: this.runContext.policy ?? null,
          }
        : null,
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  /**
   * Record operation identity before any side effect. If the process died with
   * status=started, beginStageAttempt reuses the row/idempotency key on resume.
   */
  private async executeStageAttempt<T>(
    stage: StageId,
    request: PipelineRequest,
    fn: (attempt: StageAttemptRow) => Promise<T>,
  ): Promise<T> {
    this.shared.assertExecutionFence();
    const run = this.shared.getRun(request.runId);
    const attempt = this.db.beginStageAttempt(
      request.runId,
      stage,
      this.stageInputHash(stage, request),
      run?.execution_attempt ?? 0,
    );
    try {
      const result = await fn(attempt);
      this.shared.assertExecutionFence();
      this.db.completeStageAttempt(attempt.stage_attempt_id, "succeeded", {
        result: { stage, idempotency_key: attempt.idempotency_key },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A stale executor is no longer authoritative and must not overwrite the
      // durable attempt owned by the next lease holder.
      if (!message.startsWith("execution lease lost for run")) {
        this.shared.assertExecutionFence();
        this.db.completeStageAttempt(
          attempt.stage_attempt_id,
          this.shouldCancel(request.runId) ? "cancelled" : "failed",
          { error: message },
        );
      }
      throw error;
    }
  }

  async resume(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const completed = new Set<string>();
    for (const stage of STAGE_ORDER) {
      const row = this.db.db
        .prepare("SELECT stage FROM engine_checkpoints WHERE run_id = ? AND stage = ?")
        .get(request.runId, stage);
      if (row) completed.add(stage);
    }
    if (completed.size === 0) return this.run(request);
    const lastCompleted = STAGE_ORDER.filter((stage) => completed.has(stage)).at(-1);
    if (!lastCompleted) return this.run(request);
    const resumeStage = NEXT_STAGE[lastCompleted];
    if (!resumeStage) return { status: "completed" };
    return this.runFromStage(request, resumeStage, completed);
  }

  async run(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const startStage = request.startStage ?? "plan_outline";
    const preserved = new Set<string>();
    for (const stage of STAGE_ORDER) {
      if (stage === startStage) break;
      preserved.add(stage);
    }
    return this.runFromStage(request, startStage, preserved);
  }

  private async finishCancelled(
    request: PipelineRequest,
    emitter: PipelineEmitter,
  ): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    this.shared.setAwaitingPayload(request.runId, null);
    this.shared.updateRun(request.runId, { status: "cancelled" });
    emitter.emit("run_cancelled", {
      run_id: request.runId,
      project_id: request.projectId,
      cancelled_count: 1,
      run_ids: [request.runId],
    });
    return { status: "cancelled" };
  }

  private async runFromStage(
    request: PipelineRequest,
    startStage: StageId,
    preservedStages: Set<string>,
  ): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const project = this.shared.getProject(request.projectId);
    if (!project) return { status: "failed", error: `project ${request.projectId} not found` };

    const mediaSettings = resolveMediaSettings(this.db, this.mediaSnapshot());
    const media = new MediaService(mediaSettings);
    const emitter = new PipelineEmitter(this.db, this.shared, request.projectId, request.runId, {
      thinkingChainEnabled: this.boolPolicy(
        "thinking_chain_enabled",
        "THINKING_CHAIN_ENABLED",
        true,
      ),
      thinkingDetailLevel: this.stringPolicy(
        "thinking_chain_detail_level",
        "THINKING_CHAIN_DETAIL_LEVEL",
        "normal",
      ) as "minimal" | "normal" | "verbose",
    });

    const fullRun = startStage === "plan_outline";
    const startAgent = agentForStage(startStage);
    this.shared.updateRun(request.runId, {
      status: "running",
      current_agent: startAgent,
      progress: progressForStage(startStage),
      error: null,
    });
    emitter.emit("run_started", {
      run_id: request.runId,
      project_id: request.projectId,
      current_stage: startStage,
      stage: startStage,
      next_stage: NEXT_STAGE[startStage],
      progress: progressForStage(startStage),
      current_agent: startAgent,
      preserved_stages: fullRun ? [] : STAGE_ORDER.filter((s) => preservedStages.has(s)),
    });
    if (fullRun) {
      emitter.emit("data_cleared", {
        cleared_types: ["characters", "shots", "messages"],
        start_agent: "outline",
        mode: "full",
      });
    }

    const ctx: StageContext = {
      shared: this.shared,
      emitter,
      llm: this.llm,
      media,
      mediaSettings,
      projectId: request.projectId,
      runId: request.runId,
      userFeedback: request.userFeedback,
      critiqueRounds: { characters: 0, shots: 0 },
      critiqueEnabled: this.boolPolicy("critique_enabled", "CRITIQUE_ENABLED", true),
      critiqueScoreThreshold: this.numberPolicy(
        "critique_score_threshold",
        "CRITIQUE_SCORE_THRESHOLD",
        6,
      ),
      critiqueMaxRounds: this.numberPolicy("critique_max_rounds", "CRITIQUE_MAX_ROUNDS", 2),
      completionInfo: null,
      willRegenerate: false,
    };

    let stage: StageId = startStage;
    let guard = 0;
    try {
      while (stage !== null && guard < 64) {
        guard += 1;
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        if (stage === "review") break;

        if (isGate(stage)) {
          await this.runGate(stage, request, ctx);
          if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        if (isCritique(stage)) {
          const entityType = stage === "critique_character_images" ? "character" : "shot";
          const outcome = await this.executeStageAttempt(stage, request, async () =>
            runCritique(ctx, entityType),
          );
          this.shared.assertExecutionFence();
          if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
          const roundsKey: "characters" | "shots" =
            entityType === "character" ? "characters" : "shots";
          ctx.critiqueRounds[roundsKey] += 1;
          if (outcome.willRegenerate) {
            stage = entityType === "character" ? "render_characters" : "render_shots";
            continue;
          }
          this.db.saveCheckpoint(request.runId, stage, {
            completed_at: new Date().toISOString(),
            will_regenerate: false,
          });
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        await this.executeStageAttempt(stage, request, async () => {
          await this.runProduction(stage, ctx, request);
        });
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        this.db.saveCheckpoint(request.runId, stage, { completed_at: new Date().toISOString() });
        stage = NEXT_STAGE[stage] as StageId;
      }

      this.shared.assertExecutionFence();
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);

      const finalProject = this.shared.getProject(request.projectId);
      if (!finalProject?.video_url && !videoSkippedFor(this.db, request.runId)) {
        throw new Error("Compose finished without a usable final video: final project video_url is empty");
      }
      this.shared.updateProject(request.projectId, { status: "ready" });
      this.shared.updateRun(request.runId, {
        status: "succeeded",
        progress: 1,
        awaiting_payload: null,
      });
      emitter.emit("run_completed", {
        run_id: request.runId,
        project_id: request.projectId,
        current_stage: "compose_approval",
        current_agent: "compose",
        message: null,
        video_generation_pending: null,
      });
      return { status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("execution lease lost for run")) return { status: "failed", error: message };
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);

      this.shared.assertExecutionFence();
      this.shared.updateProject(request.projectId, { status: "failed" });
      this.shared.updateRun(request.runId, { status: "failed", error: message });
      emitter.emit("project_updated", { project: { id: request.projectId, status: "failed" } });
      emitter.emit("run_failed", {
        run_id: request.runId,
        project_id: request.projectId,
        error: message,
        agent: null,
        current_stage: stage,
      });
      return { status: "failed", error: message };
    }
  }

  private async runProduction(
    stage: StageId,
    ctx: StageContext,
    request: PipelineRequest,
  ): Promise<void> {
    const agent = agentForStage(stage);
    ctx.completionInfo = null;
    this.shared.updateRun(request.runId, {
      status: "running",
      current_agent: agent,
      progress: progressForStage(stage, 0),
    });
    ctx.emitter.sendProgress(agent, stage, NEXT_STAGE[stage], 0);

    switch (stage) {
      case "plan_outline": await runOutline(ctx); break;
      case "plan_characters": await runPlanCharacters(ctx); break;
      case "plan_shots": await runPlanShots(ctx); break;
      case "render_characters": await runRenderCharacters(ctx); break;
      case "render_shots": await runRenderShots(ctx); break;
      case "compose_videos": await runComposeVideos(ctx); break;
      case "compose_merge": await runComposeMerge(ctx); break;
      case "add_audio": await runAddAudio(ctx); break;
      case "outline_approval":
      case "characters_approval":
      case "shots_approval":
      case "character_images_approval":
      case "shot_images_approval":
      case "compose_approval":
      case "critique_character_images":
      case "critique_shot_images":
      case "review":
        throw new Error(`stage ${stage} reached runProduction`);
    }
  }

  private async runGate(stage: StageId, request: PipelineRequest, ctx: StageContext): Promise<void> {
    const gateAgent = GATE_AGENT[stage] ?? agentForStage(stage);
    const currentStage = stage;
    const nextStage = NEXT_STAGE[stage];
    const info = ctx.completionInfo ?? AGENT_COMPLETION_INFO[gateAgent] ?? {
      completed: `「${gateAgent}」已完成`, details: "", next: "继续下一步", question: "是否继续？",
    };
    const message = [info.completed, info.details, info.next, info.question]
      .filter((part) => part && part.trim()).join("\n");

    this.shared.clearConfirmSignal(request.runId);
    const awaitingPayload: Record<string, unknown> = {
      run_id: request.runId,
      project_id: request.projectId,
      agent: gateAgent,
      gate: gateAgent,
      current_stage: currentStage,
      stage: currentStage,
      next_stage: nextStage,
      recovery_summary: {
        project_id: request.projectId,
        run_id: request.runId,
        thread_id: `agent-run-${request.runId}`,
        current_stage: currentStage,
      },
      preserved_stages: [],
      message,
      completed: info.completed,
      next_step: info.next,
      question: info.question,
    };
    if (gateAgent === "outline") {
      const project = this.shared.getProject(request.projectId);
      if (project?.story_outline) {
        awaitingPayload.story_outline = parseJsonColumn(project.story_outline, null as unknown);
        awaitingPayload.visual_bible = project.visual_bible;
      }
    }

    this.shared.updateRun(request.runId, { status: "waiting_for_approval", current_agent: gateAgent });
    this.shared.setAwaitingPayload(request.runId, awaitingPayload);
    ctx.emitter.emit("run_awaiting_confirm", awaitingPayload);

    if (request.autoMode) {
      this.shared.setAwaitingPayload(request.runId, null);
      this.shared.updateRun(request.runId, { status: "running" });
      this.emitGateConfirmed(stage, request, ctx, gateAgent, currentStage, nextStage);
      return;
    }

    const approved = await this.waitForConfirm(request.runId);
    if (!approved) {
      if (this.shouldCancel(request.runId)) return;
      throw new Error(`等待确认超时（agent: ${gateAgent}）`);
    }
    this.shared.setAwaitingPayload(request.runId, null);
    this.shared.updateRun(request.runId, { status: "running" });
    this.emitGateConfirmed(stage, request, ctx, gateAgent, currentStage, nextStage);
  }

  private emitGateConfirmed(
    stage: StageId,
    request: PipelineRequest,
    ctx: StageContext,
    gateAgent: string,
    currentStage: StageId,
    nextStage: StageId | null,
  ): void {
    const postStage = nextStage ?? currentStage;
    ctx.emitter.emit("run_confirmed", {
      run_id: request.runId,
      project_id: request.projectId,
      agent: gateAgent,
      gate: gateAgent,
      current_stage: postStage,
      stage: postStage,
      next_stage: NEXT_STAGE[postStage] ?? null,
      recovery_summary: {
        project_id: request.projectId,
        run_id: request.runId,
        thread_id: `agent-run-${request.runId}`,
        current_stage: postStage,
      },
    });
    this.db.saveCheckpoint(request.runId, stage, {
      completed_at: new Date().toISOString(), approved: true,
    });
  }

  private async waitForConfirm(runId: number): Promise<boolean> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.shared.assertExecutionFence();
      if (this.shouldCancel(runId)) return false;
      if (this.shared.consumeConfirmSignal(runId)) return true;
      await sleep(CONFIRM_POLL_MS);
    }
    return false;
  }
}

function isGate(stage: StageId): boolean {
  return stage in GATE_AGENT && stage.endsWith("approval");
}

function isCritique(stage: StageId): boolean {
  return stage.startsWith("critique_");
}

function videoSkippedFor(db: EngineDatabase, runId: number): boolean {
  const cp = db.latestCheckpoint(runId);
  return Boolean(
    cp && typeof cp.state === "object" && cp.state !== null &&
      (cp.state as { videoSkipped?: boolean }).videoSkipped,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
