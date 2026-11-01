/**
 * Pipeline runner: the generated linear workflow with approval gates,
 * stage checkpoints, durable stage attempts, critique regeneration routing,
 * cancellation and execution fencing.
 */
import {
  AGENT_COMPLETION_INFO,
  APPROVAL_TO_PRODUCED_STAGE,
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
  withProjectMediaOptions,
  type MediaProviderSnapshot,
  type MediaRunSnapshot,
  type MediaSettings,
} from "../media/media.js";
import { TextLlmService, type RunCreativeContext } from "../llm.js";
import {
  ConcurrentModificationError,
  SharedDb,
  parseJsonColumn,
} from "../shared-db.js";
import type {
  CharacterRow,
  FrozenStageInput,
  GateFeedbackSignal,
  ProjectRow,
  ShotRow,
} from "../shared-db.js";
import {
  runComposeMerge,
  runComposeVideos,
  runCritique,
  runOutline,
  runPlanCharacters,
  runPlanShots,
  runRenderCharacters,
  runRenderShots,
  targetCheckpointStage,
  type StageContext,
} from "../agents/index.js";
import { PipelineEmitter } from "./emitter.js";
import { resolveStageStyleContext } from "../style.js";
import { AiOperationError, beginAiOperation, stageOperationTimeoutMs } from "../ai-operation.js";
import { withRunSpan, withStageSpan } from "../observability.js";

export interface PipelineRequest {
  projectId: number;
  runId: number;
  autoMode: boolean;
  userFeedback: string;
  startStage?: StageId;
  /**
   * Restrict work to these entities (targeted redraw / fill). Absent means
   * "every entity in scope". This is the engine-side replacement for the Python
   * `agent_plan` + `TargetIds` dispatch that FastAPI used to build itself.
   */
  targetCharacterIds?: number[];
  targetShotIds?: number[];
  forceRegenerate?: boolean;
}

export interface PipelineOutcome {
  status: "completed" | "failed" | "cancelled";
  error?: string;
}

const CONFIRM_POLL_MS = 300;
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;
const STAGE_ACTIVITY_LABEL: Partial<Record<StageId, string>> = {
  plan_outline: "生成故事大纲",
  plan_characters: "规划角色",
  plan_shots: "规划分镜",
  render_characters: "生成角色形象",
  critique_character_images: "检查角色一致性",
  render_shots: "生成分镜画面",
  critique_shot_images: "检查分镜画面",
  compose_videos: "生成分镜视频",
  compose_merge: "合成完整视频",
};

function assertTargetIdsExist(shared: SharedDb, request: PipelineRequest): void {
  const characters = new Set(shared.charactersForProject(request.projectId).map((row) => row.id));
  const shots = new Set(shared.shotsForProject(request.projectId).map((row) => row.id));
  const missing = [
    ...(request.targetCharacterIds ?? []).filter((id) => !characters.has(id)),
    ...(request.targetShotIds ?? []).filter((id) => !shots.has(id)),
  ];
  if (missing.length) {
    throw new Error(
      `target IDs no longer exist in project ${request.projectId}: ${missing.join(", ")}`,
    );
  }
}

function durationLabel(durationMs: number): string {
  return durationMs < 1000
    ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(durationMs)} 毫秒`
    : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(durationMs / 1000)} 秒`;
}

function stageActivityLabel(stage: StageId): string {
  return STAGE_ACTIVITY_LABEL[stage] ?? stage;
}

function classifyRunFailure(error: unknown): { error_code: string; retryable: boolean } {
  if (error instanceof ConcurrentModificationError) {
    return { error_code: "CONCURRENT_MODIFICATION", retryable: false };
  }
  if (error instanceof AiOperationError) {
    switch (error.kind) {
      case "timeout":
        return { error_code: "PROVIDER_TIMEOUT", retryable: true };
      case "aborted":
        return { error_code: "OPERATION_ABORTED", retryable: true };
      case "invalid_response":
        return { error_code: "INVALID_PROVIDER_RESPONSE", retryable: false };
      case "provider":
        return { error_code: "PROVIDER_ERROR", retryable: false };
    }
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { error_code: "PROVIDER_TIMEOUT", retryable: true };
  }
  return { error_code: "GENERATION_FAILED", retryable: false };
}

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
  /**
   * Cancellation reaches the providers through this signal, not only through
   * the stage-boundary flag: an in-flight LLM or media request is aborted
   * immediately instead of running to completion after the run was stopped.
   */
  private readonly abortController = new AbortController();

  constructor(
    private readonly db: EngineDatabase,
    private readonly shared: SharedDb,
    private readonly llm: TextLlmService,
    private readonly runContext?: RunCreativeContext,
  ) {}

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  requestCancel(): void {
    this.cancelRequested = true;
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  private shouldCancel(runId: number): boolean {
    // A cancel observed in the database must also abort in-flight provider work,
    // otherwise a resumed owner keeps the old requests alive.
    if (!this.cancelRequested && this.shared.runCancelRequested(runId)) {
      this.requestCancel();
    }
    if (this.abortController.signal.aborted) this.cancelRequested = true;
    return this.cancelRequested;
  }

  private policy(): Record<string, unknown> | null {
    return asRecord(this.runContext?.policy);
  }

  private mediaSettingsFor(projectId: number): MediaSettings {
    const settings = resolveMediaSettings(this.db, this.mediaSnapshot());
    if (this.policy()) return settings;
    return withProjectMediaOptions(settings, this.shared.getProject(projectId)?.media_options);
  }

  private mediaSnapshot(): MediaRunSnapshot | null {
    if (!this.runContext) return null;
    const providers = asRecord(this.runContext.providers);
    return {
      text: asRecord(providers?.text) as MediaProviderSnapshot | null,
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

  private invalidateCheckpointsFrom(runId: number, stage: StageId): void {
    const index = STAGE_ORDER.indexOf(stage);
    if (index < 0) return;
    this.db.deleteCheckpoints(runId, STAGE_ORDER.slice(index));
  }

  /**
   * Authoritative inputs a stage is allowed to see, captured once at attempt
   * start and persisted with the operation identity.
   */
  /** How many provider items a stage works through, for its deadline. */
  private stageItemCount(stage: StageId, projectId: number): number {
    return stage === "render_characters" || stage === "critique_character_images"
      ? this.shared.charactersForProject(projectId).length
      : this.shared.shotsForProject(projectId).length;
  }

  private stageInputSnapshot(stage: StageId, request: PipelineRequest): unknown {
    return {
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
  }

  /**
   * Record operation identity (plus the frozen input) before any side effect.
   *
   * Resume reuses a non-terminal attempt's identity rather than re-deriving it
   * from current state, so crash/replay cannot mint a second idempotency key for
   * one operation. `forceNew` is reserved for explicit rerun / feedback
   * invalidation, never for crash recovery.
   */
  private async executeStageAttempt<T>(
    stage: StageId,
    request: PipelineRequest,
    emitter: PipelineEmitter,
    fn: (attempt: StageAttemptRow, operation: ReturnType<typeof beginAiOperation>) => Promise<T>,
    options: { forceNew?: boolean } = {},
  ): Promise<T> {
    this.shared.assertExecutionFence();
    const run = this.shared.getRun(request.runId);
    const attempt = this.db.beginStageAttempt({
      runId: request.runId,
      stage,
      input: this.stageInputSnapshot(stage, request),
      executionAttempt: run?.execution_attempt ?? 0,
      forceNew: options.forceNew ?? false,
    });
    const startedAt = Date.now();
    const label = stageActivityLabel(stage);
    const agent = agentForStage(stage);
    let result!: T;
    try {
      emitter.activity(agent, "step", label, "运行中");
      const operation = beginAiOperation({
        operationId: attempt.stage_attempt_id,
        idempotencyKey: attempt.idempotency_key,
        runId: request.runId,
        projectId: request.projectId,
        stage,
        signal: this.abortController.signal,
        timeoutMs: stageOperationTimeoutMs(stage, this.stageItemCount(stage, request.projectId)),
        reportActivity: (name, status, durationMs) => {
          if (status === "running") {
            emitter.activity(agent, "tool_call", name, "调用中");
            return;
          }
          const outcome = status === "succeeded" ? "成功" : status === "cancelled" ? "已取消" : "失败";
          emitter.activity(agent, "tool_result", name, `${outcome} · ${durationLabel(durationMs ?? 0)}`);
        },
      });
      result = await fn(attempt, operation);
      this.shared.assertExecutionFence();
      this.db.completeStageAttempt(attempt.stage_attempt_id, "succeeded", {
        result: { stage, idempotency_key: attempt.idempotency_key },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("execution lease lost for run")) {
        this.shared.assertExecutionFence();
        const cancelled = this.shouldCancel(request.runId);
        this.db.completeStageAttempt(
          attempt.stage_attempt_id,
          cancelled ? "cancelled" : "failed",
          { error: message },
        );
        emitter.activity(
          agentForStage(stage),
          "step_result",
          stageActivityLabel(stage),
          `${cancelled ? "已取消" : "失败"} · ${durationLabel(Date.now() - startedAt)}`,
        );
      }
      throw error;
    }
    emitter.activity(agent, "step_result", label, `完成 · ${durationLabel(Date.now() - startedAt)}`);
    return result;
  }

  async resume(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    // Root span: every stage span (and its provider spans) nests under the run.
    return withRunSpan(request.runId, request.projectId, () => this.resumeInner(request));
  }

  private async resumeInner(request: PipelineRequest): Promise<PipelineOutcome> {
    // A cancel recorded while no executor was running must abort this one too.
    if (this.shared.runCancelRequested(request.runId)) this.requestCancel();
    if (request.targetCharacterIds?.length || request.targetShotIds?.length) {
      return this.runTargeted(request, true);
    }
    const completed = new Set(this.db.checkpointStages(request.runId));
    if (completed.size === 0) return this.run(request);
    const lastCompleted = STAGE_ORDER.filter((stage) => completed.has(stage)).at(-1);
    if (!lastCompleted) return this.run(request);
    const resumeStage = NEXT_STAGE[lastCompleted];
    if (!resumeStage) {
      const project = this.shared.getProject(request.projectId);
      if (!project?.video_url && !videoSkippedFor(this.db, request.runId)) {
        return this.runFromStage(request, "compose_merge", completed);
      }
      let cancelled = false;
      this.db.transaction(() => {
        this.shared.assertExecutionFence();
        if (this.shared.runCancelRequested(request.runId)) {
          cancelled = true;
          this.shared.updateRun(request.runId, {
            status: "cancelled",
            awaiting_payload: null,
          });
          this.db.appendEvent(request.runId, request.projectId, "run_cancelled", {
            run_id: request.runId,
            project_id: request.projectId,
            cancelled_count: 1,
            run_ids: [request.runId],
          });
          return;
        }
        this.shared.assertRunCommitAllowed(request.runId);
        this.shared.updateProject(request.projectId, { status: "ready" });
        this.db.appendEvent(request.runId, request.projectId, "project_updated", {
          project: { id: request.projectId, status: "ready" },
        });
        this.shared.completeRun(request.runId, {
          status: "succeeded",
          progress: 1,
          awaiting_payload: null,
          error: null,
        });
        this.db.appendEvent(request.runId, request.projectId, "run_completed", {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: lastCompleted,
          current_agent: agentForStage(lastCompleted),
          message: null,
          video_generation_pending: null,
        });
      });
      return { status: cancelled ? "cancelled" : "completed" };
    }
    return this.runFromStage(request, resumeStage, completed);
  }

  async run(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    return withRunSpan(request.runId, request.projectId, () => this.runInner(request));
  }

  private async runInner(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    if (this.shared.runCancelRequested(request.runId)) this.requestCancel();
    if (request.targetCharacterIds || request.targetShotIds) {
      return this.runTargeted(request);
    }
    const startStage = request.startStage ?? "plan_outline";
    if (startStage === STAGE_ORDER[0]) {
      this.db.clearCheckpoints(request.runId);
    } else {
      this.invalidateCheckpointsFrom(request.runId, startStage);
    }
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
    emitter.commitCancellation(() => {
      this.shared.setAwaitingPayload(request.runId, null);
      this.shared.updateRun(request.runId, { status: "cancelled" });
      this.db.appendEvent(request.runId, request.projectId, "run_cancelled", {
        run_id: request.runId,
        project_id: request.projectId,
        cancelled_count: 1,
        run_ids: [request.runId],
      });
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

    const mediaSettings = this.mediaSettingsFor(request.projectId);
    const media = new MediaService(mediaSettings);
    media.setAbortSignal(this.abortController.signal);
    media.setMediaRegistrar((relativePath) => this.shared.registerMediaObject(relativePath));
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
    media.setRetryNotice((message) => emitter.sendMessage("render", `⚠️ ${message}`));

    const fullRun = startStage === "plan_outline";
    const startAgent = agentForStage(startStage);
    try {
      emitter.commit("run_started", () => {
        this.shared.markRunStarted(request.runId);
        this.shared.updateRun(request.runId, {
          status: "running",
          current_agent: startAgent,
          progress: progressForStage(startStage),
          error: null,
        });
        return {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: startStage,
          stage: startStage,
          next_stage: NEXT_STAGE[startStage],
          progress: progressForStage(startStage),
          current_agent: startAgent,
          preserved_stages: fullRun ? [] : STAGE_ORDER.filter((s) => preservedStages.has(s)),
        };
      });
    } catch (error) {
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      throw error;
    }
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
      signal: this.abortController.signal,
      targetCharacterIds: request.targetCharacterIds,
      targetShotIds: request.targetShotIds,
      forceCharacterRedraw: request.startStage === undefined,
      completedTargets: new Set(
        this.db.checkpointStages(request.runId).filter((stage) => stage.startsWith("target:")),
      ),
      checkpointTarget: (kind, id) => {
        const checkpoint = targetCheckpointStage(kind, id);
        this.db.saveCheckpoint(request.runId, checkpoint, {
          completed_at: new Date().toISOString(),
        });
        ctx.completedTargets.add(checkpoint);
      },
      ...resolveStageStyleContext(
        this.db,
        this.shared.getProject(request.projectId) ?? null,
      ),
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

        if (isGate(stage)) {
          await this.runGate(stage, request, ctx);
          if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        if (isCritique(stage)) {
          const entityType = stage === "critique_character_images" ? "character" : "shot";
          const outcome = await this.executeStageAttempt(
            stage,
            request,
            emitter,
            async (attempt, operation) => {
              ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
              ctx.operation = operation;
              try {
                return await runCritique(ctx, entityType);
              } finally {
                ctx.operation = null;
                ctx.shared = this.shared;
              }
            },
          );
          ctx.shared = this.shared;
          this.shared.assertExecutionFence();
          if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
          const roundsKey: "characters" | "shots" =
            entityType === "character" ? "characters" : "shots";
          ctx.critiqueRounds[roundsKey] += 1;
          if (outcome.willRegenerate) {
            if (entityType === "character") {
              ctx.targetCharacterIds = outcome.regenerateEntityIds;
            } else {
              ctx.targetShotIds = outcome.regenerateEntityIds;
            }
            const rerenderStage: StageId =
              entityType === "character" ? "render_characters" : "render_shots";
            const checkpointKind =
              entityType === "character" ? "character_image" : "shot_image";
            const targetCheckpoints = outcome.regenerateEntityIds.map((id) =>
              targetCheckpointStage(checkpointKind, id),
            );
            this.db.deleteCheckpoints(request.runId, targetCheckpoints);
            for (const checkpoint of targetCheckpoints) {
              ctx.completedTargets.delete(checkpoint);
            }
            this.invalidateCheckpointsFrom(request.runId, rerenderStage);
            stage = rerenderStage;
            continue;
          }
          // A critique redo narrows the targets to the redone entities; once
          // it passes, later stages work on the run's own scope again.
          if (entityType === "character") ctx.targetCharacterIds = request.targetCharacterIds;
          else ctx.targetShotIds = request.targetShotIds;
          this.db.saveCheckpoint(request.runId, stage, {
            completed_at: new Date().toISOString(),
            will_regenerate: false,
          });
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        await this.runProductionAttempt(stage, request, ctx, emitter);
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
      emitter.commit("run_completed", () => {
        this.shared.updateProject(request.projectId, { status: "ready" });
        this.shared.completeRun(request.runId, {
          status: "succeeded",
          progress: 1,
          awaiting_payload: null,
        });
        return {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: "compose_approval",
          current_agent: "compose",
          message: null,
          video_generation_pending: null,
        };
      });
      return { status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("execution lease lost for run")) return { status: "failed", error: message };
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);

      const failure = classifyRunFailure(err);
      try {
        this.db.transaction(() => {
          this.shared.assertRunCommitAllowed(request.runId);
          this.shared.updateProject(request.projectId, { status: "failed" });
          this.shared.updateRun(request.runId, { status: "failed", error: message });
          this.db.appendEvent(request.runId, request.projectId, "project_updated", {
            project: { id: request.projectId, status: "failed" },
          });
          this.db.appendEvent(request.runId, request.projectId, "run_failed", {
            run_id: request.runId,
            project_id: request.projectId,
            error: message,
            ...failure,
            agent: null,
            current_stage: stage,
          });
        });
      } catch (commitError) {
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        throw commitError;
      }
      return { status: "failed", error: message };
    }
  }

  /** One durable attempt of a production stage (shared by the main loop and gate feedback). */
  private async runProductionAttempt(
    stage: StageId,
    request: PipelineRequest,
    ctx: StageContext,
    emitter: PipelineEmitter,
    options: { forceNew?: boolean } = {},
  ): Promise<void> {
    await this.executeStageAttempt(stage, request, emitter, async (attempt, operation) => {
      ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
      // One operation identity for every provider call in this attempt:
      // text (pi-ai), image and video all read from the same contract.
      ctx.operation = operation;
      ctx.media.setOperation(operation);
      try {
        // One span per stage attempt: the run -> stage -> provider tree is
        // what makes a failed run diagnosable without grepping logs.
        await withStageSpan(
          `stage ${stage}`,
          {
            "openoii.run_id": request.runId,
            "openoii.project_id": request.projectId,
            "openoii.stage": stage,
            "openoii.stage_attempt_id": attempt.stage_attempt_id,
            "openoii.execution_attempt": attempt.execution_attempt,
          },
          async (span) => {
            span.setAttribute("openoii.stage_attempt", attempt.attempt);
            await this.runProduction(stage, ctx, request);
            span.setAttribute("openoii.status", "succeeded");
          },
        );
      } finally {
        ctx.operation = null;
        ctx.media.setOperation(null);
        ctx.shared = this.shared;
      }
    }, options);
  }

  private async runProduction(
    stage: StageId,
    ctx: StageContext,
    request: PipelineRequest,
  ): Promise<void> {
    const agent = agentForStage(stage);
    ctx.completionInfo = null;
    ctx.stage = stage;
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
      case "outline_approval":
      case "characters_approval":
      case "shots_approval":
      case "character_images_approval":
      case "shot_images_approval":
      case "compose_approval":
      case "critique_character_images":
      case "critique_shot_images":
        throw new Error(`stage ${stage} reached runProduction`);
    }
  }

  /**
   * Targeted redraw / fill: run only the stages the requested entities need.
   *
   * This is the engine-side capability that replaces the Python
   * `RenderAgent`/`ComposeAgent` + `agent_plan` dispatch. FastAPI passes entity
   * ids and an intent; the engine decides which stages run (ADR 0008).
   *
   * Skip-if-satisfied: a target whose output already exists is dropped, so the
   * caller can pass "everything" without forcing a full redraw.
   */
  private async runTargeted(
    request: PipelineRequest,
    recovering = false,
  ): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const project = this.shared.getProject(request.projectId);
    if (!project) return { status: "failed", error: `project ${request.projectId} not found` };

    try {
      assertTargetIdsExist(this.shared, request);
    } catch (error) {
      return this.failTargeted(request, error);
    }
    const characterIds = request.targetCharacterIds ?? [];
    const shotIds = request.targetShotIds ?? [];
    // Intent comes from startStage; default to image work for the given scope.
    const intent: StageId = request.startStage ?? "render_characters";

    const characters = this.shared.charactersForProject(request.projectId);
    const shots = this.shared.shotsForProject(request.projectId);

    let effectiveCharacterIds: number[] = [];
    let effectiveShotIds: number[] = [];
    const completed = new Set(
      this.db.checkpointStages(request.runId).filter((stage) => stage.startsWith("target:")),
    );
    if (characterIds.length > 0) {
      effectiveCharacterIds = characterIds.filter(
        (id) => !completed.has(targetCheckpointStage("character_image", id)),
      );
      if (!recovering && !request.forceRegenerate && intent === "render_characters") {
        effectiveCharacterIds = effectiveCharacterIds.filter(
          (id) => characters.some((c) => c.id === id && !c.image_url),
        );
      }
    }
    if (shotIds.length > 0) {
      const checkpointKind = intent === "compose_videos" ? "shot_video" : "shot_image";
      effectiveShotIds = shotIds.filter(
        (id) => !completed.has(targetCheckpointStage(checkpointKind, id)),
      );
      if (!recovering && !request.forceRegenerate) {
        effectiveShotIds = effectiveShotIds.filter((id) =>
          shots.some((s) => s.id === id && (intent === "compose_videos" ? !s.video_url : !s.image_url)),
        );
      }
    }

    const scoped: PipelineRequest = {
      ...request,
      targetCharacterIds: characterIds.length > 0 ? effectiveCharacterIds : undefined,
      targetShotIds: shotIds.length > 0 ? effectiveShotIds : undefined,
    };

    if (
      (characterIds.length > 0 && effectiveCharacterIds.length === 0) ||
      (shotIds.length > 0 && effectiveShotIds.length === 0)
    ) {
      let cancelled = false;
      let targetError: Error | undefined;
      this.db.transaction(() => {
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) {
          cancelled = true;
          this.shared.updateRun(request.runId, { status: "cancelled", awaiting_payload: null });
          this.db.appendEvent(request.runId, request.projectId, "run_cancelled", {
            run_id: request.runId,
            project_id: request.projectId,
            cancelled_count: 1,
            run_ids: [request.runId],
          });
          return;
        }
        this.shared.assertRunCommitAllowed(request.runId);
        try {
          assertTargetIdsExist(this.shared, request);
        } catch (error) {
          targetError = error instanceof Error ? error : new Error(String(error));
          this.shared.updateRun(request.runId, { status: "failed", error: targetError.message });
          this.db.appendEvent(request.runId, request.projectId, "run_failed", {
            run_id: request.runId,
            project_id: request.projectId,
            error: targetError.message,
            error_code: "TARGET_NOT_FOUND",
            retryable: false,
          });
          return;
        }
        this.shared.completeRun(request.runId, {
          status: "succeeded",
          progress: 1,
          awaiting_payload: null,
          error: null,
        });
        this.db.appendEvent(request.runId, request.projectId, "run_completed", {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: null,
          current_agent: null,
          message: null,
          video_generation_pending: null,
        });
      });
      if (cancelled) {
        this.requestCancel();
        return { status: "cancelled" };
      }
      if (targetError) return { status: "failed", error: targetError.message };
      return { status: "completed" };
    }

    const stages: StageId[] =
      characterIds.length > 0
        ? ["render_characters"]
        : intent === "compose_videos"
          ? ["compose_videos"]
          : ["render_shots"];

    return this.runStages(request, stages, scoped);
  }

  private failTargeted(request: PipelineRequest, error: unknown): PipelineOutcome {
    const message = error instanceof Error ? error.message : String(error);
    this.db.transaction(() => {
      this.shared.assertRunCommitAllowed(request.runId);
      this.shared.updateRun(request.runId, { status: "failed", error: message });
      this.db.appendEvent(request.runId, request.projectId, "run_failed", {
        run_id: request.runId,
        project_id: request.projectId,
        error: message,
        error_code: "TARGET_NOT_FOUND",
        retryable: false,
      });
    });
    return { status: "failed", error: message };
  }

  /**
   * After a targeted render, review what it drew; true when the critic sent
   * some of it back, with the targets narrowed to those for the redraw.
   */
  private async critiqueTargets(
    stage: StageId,
    request: PipelineRequest,
    ctx: StageContext,
    emitter: PipelineEmitter,
  ): Promise<boolean> {
    if (!ctx.critiqueEnabled || (stage !== "render_shots" && stage !== "render_characters")) return false;
    const entityType = stage === "render_characters" ? "character" : "shot";
    const critique: StageId = entityType === "character" ? "critique_character_images" : "critique_shot_images";
    const outcome = await this.executeStageAttempt(critique, request, emitter, async (attempt, operation) => {
      ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
      ctx.operation = operation;
      try {
        return await runCritique(ctx, entityType);
      } finally {
        ctx.operation = null;
        ctx.shared = this.shared;
      }
    });
    this.shared.assertExecutionFence();
    ctx.critiqueRounds[entityType === "character" ? "characters" : "shots"] += 1;
    if (!outcome.willRegenerate) return false;
    if (entityType === "character") ctx.targetCharacterIds = outcome.regenerateEntityIds;
    else ctx.targetShotIds = outcome.regenerateEntityIds;
    const kind = entityType === "character" ? "character_image" : "shot_image";
    const checkpoints = outcome.regenerateEntityIds.map((id) => targetCheckpointStage(kind, id));
    this.db.deleteCheckpoints(request.runId, checkpoints);
    for (const checkpoint of checkpoints) ctx.completedTargets.delete(checkpoint);
    return true;
  }

  /** Run an explicit stage list under the normal fence/attempt discipline. */
  private async runStages(
    request: PipelineRequest,
    stages: StageId[],
    scoped: PipelineRequest,
  ): Promise<PipelineOutcome> {
    const mediaSettings = this.mediaSettingsFor(request.projectId);
    const media = new MediaService(mediaSettings);
    media.setAbortSignal(this.abortController.signal);
    media.setMediaRegistrar((relativePath) => this.shared.registerMediaObject(relativePath));
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
    media.setRetryNotice((message) => emitter.sendMessage("render", `⚠️ ${message}`));
    const first = stages[0]!;
    const ctx: StageContext = {
      shared: this.shared,
      emitter,
      llm: this.llm,
      media,
      mediaSettings,
      projectId: request.projectId,
      runId: request.runId,
      userFeedback: request.userFeedback,
      signal: this.abortController.signal,
      targetCharacterIds: scoped.targetCharacterIds,
      targetShotIds: scoped.targetShotIds,
      completedTargets: new Set(
        this.db.checkpointStages(request.runId).filter((checkpoint) => checkpoint.startsWith("target:")),
      ),
      checkpointTarget: (kind, id) => {
        const checkpoint = targetCheckpointStage(kind, id);
        this.db.saveCheckpoint(request.runId, checkpoint, {
          completed_at: new Date().toISOString(),
        });
        ctx.completedTargets.add(checkpoint);
      },
      ...resolveStageStyleContext(this.db, this.shared.getProject(request.projectId) ?? null),
      critiqueRounds: { characters: 0, shots: 0 },
      // A targeted redraw is checked like a full run: keyframes after render,
      // each clip inside compose_videos.
      critiqueEnabled: this.boolPolicy("critique_enabled", "CRITIQUE_ENABLED", true),
      critiqueScoreThreshold: this.numberPolicy("critique_score_threshold", "CRITIQUE_SCORE_THRESHOLD", 6),
      critiqueMaxRounds: this.numberPolicy("critique_max_rounds", "CRITIQUE_MAX_ROUNDS", 2),
      completionInfo: null,
      willRegenerate: false,
    };

    const startAgent = agentForStage(first);
    try {
      emitter.commit("run_started", () => {
        this.shared.markRunStarted(request.runId);
        this.shared.updateRun(request.runId, {
          status: "running",
          current_agent: startAgent,
          progress: progressForStage(first),
          error: null,
        });
        return {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: first,
          stage: first,
          next_stage: null,
          progress: progressForStage(first),
          current_agent: startAgent,
          preserved_stages: [],
        };
      });
    } catch (error) {
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      throw error;
    }

    try {
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index]!;
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        await this.executeStageAttempt(stage, request, emitter, async (attempt, operation) => {
          ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
          // One operation identity for every provider call in this attempt:
          // text (pi-ai), image and video all read from the same contract.
          ctx.operation = operation;
          ctx.media.setOperation(operation);
          try {
            // One span per stage attempt: the run -> stage -> provider tree is
            // what makes a failed run diagnosable without grepping logs.
            await withStageSpan(
              `stage ${stage}`,
              {
                "openoii.run_id": request.runId,
                "openoii.project_id": request.projectId,
                "openoii.stage": stage,
                "openoii.stage_attempt_id": attempt.stage_attempt_id,
                "openoii.execution_attempt": attempt.execution_attempt,
              },
              async (span) => {
                span.setAttribute("openoii.stage_attempt", attempt.attempt);
                await this.runProduction(stage, ctx, request);
                span.setAttribute("openoii.status", "succeeded");
              },
            );
          } finally {
            ctx.operation = null;
            ctx.media.setOperation(null);
            ctx.shared = this.shared;
          }
        });
        if (await this.critiqueTargets(stage, request, ctx, emitter)) index -= 1;
      }
      this.shared.assertExecutionFence();
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      emitter.commit("run_completed", () => {
        assertTargetIdsExist(this.shared, request);
        this.shared.completeRun(request.runId, {
          status: "succeeded",
          progress: 1,
          awaiting_payload: null,
        });
        return {
          run_id: request.runId,
          project_id: request.projectId,
          current_stage: stages[stages.length - 1],
          current_agent: startAgent,
          message: null,
          video_generation_pending: null,
        };
      });
      return { status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("execution lease lost for run")) {
        return { status: "failed", error: message };
      }
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      const failure = classifyRunFailure(err);
      try {
        this.db.transaction(() => {
          this.shared.assertRunCommitAllowed(request.runId);
          if (!scoped.targetCharacterIds?.length && !scoped.targetShotIds?.length) {
            this.shared.updateProject(request.projectId, { status: "failed" });
            this.db.appendEvent(request.runId, request.projectId, "project_updated", {
              project: { id: request.projectId, status: "failed" },
            });
          }
          this.shared.updateRun(request.runId, { status: "failed", error: message });
          this.db.appendEvent(request.runId, request.projectId, "run_failed", {
            run_id: request.runId,
            project_id: request.projectId,
            error: message,
            ...failure,
            agent: startAgent,
          });
        });
      } catch (commitError) {
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        throw commitError;
      }
      return { status: "failed", error: message };
    }
  }

  private async runGate(stage: StageId, request: PipelineRequest, ctx: StageContext): Promise<void> {
    const gateAgent = GATE_AGENT[stage] ?? agentForStage(stage);
    const currentStage = stage;
    const nextStage = NEXT_STAGE[stage];
    let lastFeedback: GateFeedbackOutcome | null = null;

    // A gate only ever leaves on approval (or cancel/timeout). "Request changes"
    // redoes the gate's own stage with the feedback and comes back here.
    for (;;) {
      const info = ctx.completionInfo ?? AGENT_COMPLETION_INFO[gateAgent] ?? {
        completed: `「${gateAgent}」已完成`, details: "", next: "继续下一步", question: "是否继续？",
      };
      const message = [info.completed, info.details, info.next, info.question]
        .filter((part) => part && part.trim()).join("\n");

      // An approval clicked while a redo was running approved a version the
      // user has not seen; it must not carry over to the new one.
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
          current_stage: currentStage,
        },
        preserved_stages: [],
        message,
        completed: info.completed,
        next_step: info.next,
        question: info.question,
        feedback: lastFeedback,
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

      const decision = await this.waitForGateDecision(request.runId);
      if (decision.kind === "timeout") {
        if (this.shouldCancel(request.runId)) return;
        throw new Error(`等待确认超时（agent: ${gateAgent}）`);
      }
      if (decision.kind === "approve") {
        this.shared.setAwaitingPayload(request.runId, null);
        this.shared.updateRun(request.runId, { status: "running" });
        this.emitGateConfirmed(stage, request, ctx, gateAgent, currentStage, nextStage);
        return;
      }

      // The round comes from the persisted receipts (assigned by the gateway),
      // not from a counter that a restart or resume would reset.
      const round =
        decision.feedback.round ?? this.shared.countFeedbackReceipts(request.runId, currentStage) + 1;
      lastFeedback = await this.applyGateFeedback(stage, request, ctx, decision.feedback, round);
      if (this.shouldCancel(request.runId)) return;
    }
  }

  /**
   * Redo the gate's produced stage with the user's feedback.
   *
   * Returns the receipt the gate shows next: a new version (`revised`), or an
   * explicit reason why nothing was redone (`not_applied` / `failed`). It never
   * advances past the gate.
   */
  private async applyGateFeedback(
    gate: StageId,
    request: PipelineRequest,
    ctx: StageContext,
    feedback: GateFeedbackSignal,
    round: number,
  ): Promise<GateFeedbackOutcome> {
    const gateAgent = GATE_AGENT[gate] ?? agentForStage(gate);
    const receipt = (state: GateFeedbackOutcome["state"], reason: string | null = null): GateFeedbackOutcome => ({
      id: feedback.id,
      round,
      state,
      content: feedback.content,
      reason,
      entity_type: feedback.entityType,
      entity_ids: feedback.entityIds.length ? feedback.entityIds : null,
    });
    const emitReceipt = (outcome: GateFeedbackOutcome) => {
      if (outcome.id) {
        this.shared.upsertFeedbackReceipt(request.projectId, request.runId, gateAgent, {
          id: outcome.id,
          round: outcome.round,
          state: outcome.state,
          content: outcome.content,
          reason: outcome.reason,
          gate: gateAgent,
          stage: gate,
          entity_type: outcome.entity_type,
          entity_ids: outcome.entity_ids,
        });
      }
      ctx.emitter.emit("run_feedback", {
        run_id: request.runId,
        project_id: request.projectId,
        gate: gateAgent,
        stage: gate,
        feedback_id: outcome.id,
        round: outcome.round,
        state: outcome.state,
        content: outcome.content,
        reason: outcome.reason,
        entity_type: outcome.entity_type,
        entity_ids: outcome.entity_ids,
      });
    };
    const finish = (outcome: GateFeedbackOutcome): GateFeedbackOutcome => {
      this.shared.clearGateFeedback(request.runId);
      emitReceipt(outcome);
      return outcome;
    };

    emitReceipt(receipt("received"));
    const plan = planGateFeedback(gate, feedback);
    if (plan.kind === "not_applied") return finish(receipt("not_applied", plan.reason));

    // While the stage is redone the run is working, not waiting: a reload shows
    // 重做中 instead of a stale approval card for the version being replaced.
    this.shared.setAwaitingPayload(request.runId, null);
    this.shared.updateRun(request.runId, { status: "running", current_agent: agentForStage(plan.stages[0] ?? gate) });
    emitReceipt(receipt("regenerating"));

    const saved = {
      userFeedback: ctx.userFeedback,
      targetCharacterIds: ctx.targetCharacterIds,
      targetShotIds: ctx.targetShotIds,
      forceCharacterRedraw: ctx.forceCharacterRedraw,
    };
    const feedbackRequest: PipelineRequest = { ...request, userFeedback: feedback.content };
    ctx.userFeedback = feedback.content;
    if (plan.characters) {
      // Forced ids: a character that already has an image is redrawn anyway.
      const ids =
        plan.characters === "all"
          ? this.shared.charactersForProject(request.projectId).map((row) => row.id)
          : plan.characters;
      ctx.targetCharacterIds = ids;
      ctx.forceCharacterRedraw = true;
      this.dropTargetCheckpoints(request.runId, ctx, "character_image", ids);
    }
    if (plan.shots) {
      const ids =
        plan.shots === "all"
          ? this.shared.shotsForProject(request.projectId).map((row) => row.id)
          : plan.shots;
      ctx.targetShotIds = ids;
      this.dropTargetCheckpoints(request.runId, ctx, plan.shotKind, ids);
    }
    try {
      for (const stage of plan.stages) {
        await this.runProductionAttempt(stage, feedbackRequest, ctx, ctx.emitter, { forceNew: true });
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) return receipt("failed", "已取消");
        this.db.saveCheckpoint(request.runId, stage, {
          completed_at: new Date().toISOString(),
          feedback_round: round,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("execution lease lost for run") || this.shouldCancel(request.runId)) {
        throw error;
      }
      // The previous version is still in place; say so and keep waiting.
      return finish(receipt("failed", `按意见重做失败，已保留上一版：${message}`));
    } finally {
      ctx.userFeedback = saved.userFeedback;
      ctx.targetCharacterIds = saved.targetCharacterIds;
      ctx.targetShotIds = saved.targetShotIds;
      ctx.forceCharacterRedraw = saved.forceCharacterRedraw;
    }
    return finish(receipt("revised"));
  }

  private dropTargetCheckpoints(
    runId: number,
    ctx: StageContext,
    kind: "character_image" | "shot_image" | "shot_video",
    ids: number[],
  ): void {
    const checkpoints = ids.map((id) => targetCheckpointStage(kind, id));
    this.db.deleteCheckpoints(runId, checkpoints);
    for (const checkpoint of checkpoints) ctx.completedTargets.delete(checkpoint);
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
        current_stage: postStage,
      },
    });
    this.db.saveCheckpoint(request.runId, stage, {
      completed_at: new Date().toISOString(), approved: true,
    });
  }

  private async waitForGateDecision(runId: number): Promise<GateDecision> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // One read per poll; the exact readers run only when a signal is set.
      const signals = this.shared.gateSignals(runId);
      if (!signals.leaseOwned) this.shared.assertExecutionFence();
      if (signals.cancelRequested && !this.cancelRequested) this.requestCancel();
      if (this.abortController.signal.aborted) this.cancelRequested = true;
      if (this.cancelRequested) return { kind: "timeout" };
      // Feedback first: "request changes" must never be read as an approval.
      if (signals.feedbackPending) {
        const feedback = this.shared.peekGateFeedback(runId);
        if (feedback) return { kind: "changes", feedback };
      }
      if (signals.confirmRequested && this.shared.consumeConfirmSignal(runId)) return { kind: "approve" };
      await sleep(CONFIRM_POLL_MS);
    }
    return { kind: "timeout" };
  }

}

interface GateFeedbackOutcome {
  id: string | null;
  round: number;
  state: "received" | "regenerating" | "revised" | "not_applied" | "failed";
  content: string;
  reason: string | null;
  entity_type: "character" | "shot" | null;
  entity_ids: number[] | null;
}

type GateDecision =
  | { kind: "approve" }
  | { kind: "changes"; feedback: GateFeedbackSignal }
  | { kind: "timeout" };

type GateFeedbackPlan =
  | { kind: "not_applied"; reason: string }
  | {
      kind: "redo";
      stages: StageId[];
      characters?: number[] | "all";
      shots?: number[] | "all";
      shotKind: "shot_image" | "shot_video";
    };

/**
 * What "request changes" at a gate redoes. The gate's produced stage comes from
 * the workflow contract; entity targets narrow image work to what was selected.
 */
export function planGateFeedback(gate: StageId, feedback: GateFeedbackSignal): GateFeedbackPlan {
  const produced = APPROVAL_TO_PRODUCED_STAGE[gate];
  if (!produced) return { kind: "not_applied", reason: "这一步没有可重做的产出" };
  const ids = feedback.entityIds.length ? feedback.entityIds : null;
  switch (gate) {
    case "character_images_approval":
      if (feedback.entityType === "shot") {
        return { kind: "not_applied", reason: "现在确认的是角色形象，选中的是镜头；镜头意见请在分镜画面这一步提" };
      }
      return { kind: "redo", stages: [produced], characters: ids ?? "all", shotKind: "shot_image" };
    case "shot_images_approval":
      if (feedback.entityType === "character") {
        return { kind: "not_applied", reason: "现在确认的是分镜画面，选中的是角色；角色形象已在上一步确认" };
      }
      return { kind: "redo", stages: [produced], shots: ids ?? "all", shotKind: "shot_image" };
    case "compose_approval":
      if (feedback.entityType === "shot" && ids) {
        return { kind: "redo", stages: ["compose_videos", "compose_merge"], shots: ids, shotKind: "shot_video" };
      }
      return {
        kind: "not_applied",
        reason: "成片已合成：请先选中要改的镜头再提意见；整片重做请用「重新生成」",
      };
    default:
      return { kind: "redo", stages: [produced], shotKind: "shot_image" };
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

/**
 * Decode the input frozen onto a stage attempt before its first side effect.
 *
 * Entity rows are restored into the exact shapes `SharedDb` serves, so the
 * frozen read-view is indistinguishable from a live read at stage start.
 */
function readFrozenStageInput(attempt: StageAttemptRow): FrozenStageInput {
  const snapshot = attempt.input_snapshot
    ? (JSON.parse(attempt.input_snapshot) as {
        project?: ProjectRow | null;
        characters?: CharacterRow[];
        shots?: ShotRow[];
      })
    : {};
  return {
    project: snapshot.project ?? null,
    characters: snapshot.characters ?? [],
    shots: snapshot.shots ?? [],
  };
}
