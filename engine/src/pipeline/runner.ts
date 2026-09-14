/**
 * Pipeline runner: the generated linear workflow with approval gates,
 * stage checkpoints, durable stage attempts, critique regeneration routing,
 * cancellation and execution fencing.
 */
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
import type {
  CharacterRow,
  FrozenStageInput,
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
  type StageContext,
} from "../agents/index.js";
import { PipelineEmitter } from "./emitter.js";
import { resolveStageStyleContext } from "../style.js";
import { beginAiOperation } from "../ai-operation.js";

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

  private invalidateCheckpointsFrom(runId: number, stage: StageId): void {
    const index = STAGE_ORDER.indexOf(stage);
    if (index < 0) return;
    this.db.deleteCheckpoints(runId, STAGE_ORDER.slice(index));
  }

  /**
   * Authoritative inputs a stage is allowed to see, captured once at attempt
   * start and persisted with the operation identity.
   */
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
    fn: (attempt: StageAttemptRow) => Promise<T>,
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
    try {
      const result = await fn(attempt);
      this.shared.assertExecutionFence();
      this.db.completeStageAttempt(attempt.stage_attempt_id, "succeeded", {
        result: { stage, idempotency_key: attempt.idempotency_key },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    // A cancel recorded while no executor was running must abort this one too.
    if (this.shared.runCancelRequested(request.runId)) this.requestCancel();
    const completed = new Set(this.db.checkpointStages(request.runId));
    if (completed.size === 0) return this.run(request);
    const lastCompleted = STAGE_ORDER.filter((stage) => completed.has(stage)).at(-1);
    if (!lastCompleted) return this.run(request);
    const resumeStage = NEXT_STAGE[lastCompleted];
    if (!resumeStage) return { status: "completed" };
    return this.runFromStage(request, resumeStage, completed);
  }

  async run(request: PipelineRequest): Promise<PipelineOutcome> {
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
    media.setAbortSignal(this.abortController.signal);
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
      signal: this.abortController.signal,
      targetCharacterIds: request.targetCharacterIds,
      targetShotIds: request.targetShotIds,
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
            async (attempt) => {
              ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
              return runCritique(ctx, entityType);
            },
          );
          ctx.shared = this.shared;
          this.shared.assertExecutionFence();
          if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
          const roundsKey: "characters" | "shots" =
            entityType === "character" ? "characters" : "shots";
          ctx.critiqueRounds[roundsKey] += 1;
          if (outcome.willRegenerate) {
            const rerenderStage: StageId =
              entityType === "character" ? "render_characters" : "render_shots";
            this.invalidateCheckpointsFrom(request.runId, rerenderStage);
            stage = rerenderStage;
            continue;
          }
          this.db.saveCheckpoint(request.runId, stage, {
            completed_at: new Date().toISOString(),
            will_regenerate: false,
          });
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        await this.executeStageAttempt(stage, request, async (attempt) => {
          ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
          // One operation identity for every provider call in this attempt:
          // text (pi-ai), image and video all read from the same contract.
          const operation = beginAiOperation({
            operationId: attempt.stage_attempt_id,
            idempotencyKey: attempt.idempotency_key,
            runId: request.runId,
            projectId: request.projectId,
            stage,
            signal: this.abortController.signal,
          });
          ctx.operation = operation;
          ctx.media.setOperation(operation);
          try {
            await this.runProduction(stage, ctx, request);
          } finally {
            ctx.operation = null;
            ctx.media.setOperation(null);
            ctx.shared = this.shared;
          }
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
  private async runTargeted(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const project = this.shared.getProject(request.projectId);
    if (!project) return { status: "failed", error: `project ${request.projectId} not found` };

    const characterIds = request.targetCharacterIds ?? [];
    const shotIds = request.targetShotIds ?? [];
    // Intent comes from startStage; default to image work for the given scope.
    const intent: StageId = request.startStage ?? "render_characters";

    const characters = this.shared.charactersForProject(request.projectId);
    const shots = this.shared.shotsForProject(request.projectId);

    let effectiveCharacterIds: number[] = [];
    let effectiveShotIds: number[] = [];
    if (characterIds.length > 0) {
      effectiveCharacterIds =
        intent === "render_characters"
          ? characters
              .filter((c) => characterIds.includes(c.id) && !c.image_url)
              .map((c) => c.id)
          : characterIds;
    }
    if (shotIds.length > 0) {
      effectiveShotIds = shots
        .filter((s) =>
          shotIds.includes(s.id) &&
          (intent === "compose_videos" ? !s.video_url : !s.image_url),
        )
        .map((s) => s.id);
    }

    const scoped: PipelineRequest = {
      ...request,
      targetCharacterIds: characterIds.length > 0 ? effectiveCharacterIds : undefined,
      targetShotIds: shotIds.length > 0 ? effectiveShotIds : undefined,
    };

    if (characterIds.length > 0 && effectiveCharacterIds.length === 0) {
      return { status: "completed" };
    }
    if (shotIds.length > 0 && effectiveShotIds.length === 0) {
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

  /** Run an explicit stage list under the normal fence/attempt discipline. */
  private async runStages(
    request: PipelineRequest,
    stages: StageId[],
    scoped: PipelineRequest,
  ): Promise<PipelineOutcome> {
    const mediaSettings = resolveMediaSettings(this.db, this.mediaSnapshot());
    const media = new MediaService(mediaSettings);
    media.setAbortSignal(this.abortController.signal);
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
      ...resolveStageStyleContext(this.db, this.shared.getProject(request.projectId) ?? null),
      critiqueRounds: { characters: 0, shots: 0 },
      critiqueEnabled: false,
      critiqueScoreThreshold: 0,
      critiqueMaxRounds: 0,
      completionInfo: null,
      willRegenerate: false,
    };

    const startAgent = agentForStage(first);
    this.shared.updateRun(request.runId, {
      status: "running",
      current_agent: startAgent,
      progress: progressForStage(first),
      error: null,
    });
    emitter.emit("run_started", {
      run_id: request.runId,
      project_id: request.projectId,
      current_stage: first,
      stage: first,
      next_stage: null,
      progress: progressForStage(first),
      current_agent: startAgent,
      preserved_stages: [],
    });

    try {
      for (const stage of stages) {
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
        await this.executeStageAttempt(stage, request, async (attempt) => {
          ctx.shared = this.shared.withFrozenStageInput(readFrozenStageInput(attempt));
          // One operation identity for every provider call in this attempt:
          // text (pi-ai), image and video all read from the same contract.
          const operation = beginAiOperation({
            operationId: attempt.stage_attempt_id,
            idempotencyKey: attempt.idempotency_key,
            runId: request.runId,
            projectId: request.projectId,
            stage,
            signal: this.abortController.signal,
          });
          ctx.operation = operation;
          ctx.media.setOperation(operation);
          try {
            await this.runProduction(stage, ctx, request);
          } finally {
            ctx.operation = null;
            ctx.media.setOperation(null);
            ctx.shared = this.shared;
          }
        });
      }
      this.shared.assertExecutionFence();
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      this.shared.updateRun(request.runId, {
        status: "succeeded",
        progress: 1,
        awaiting_payload: null,
      });
      emitter.emit("run_completed", {
        run_id: request.runId,
        project_id: request.projectId,
        current_stage: stages[stages.length - 1],
        current_agent: startAgent,
        message: null,
        video_generation_pending: null,
      });
      return { status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("execution lease lost for run")) {
        return { status: "failed", error: message };
      }
      if (this.shouldCancel(request.runId)) return await this.finishCancelled(request, emitter);
      this.shared.assertExecutionFence();
      this.shared.updateRun(request.runId, { status: "failed", error: message });
      emitter.emit("run_failed", {
        run_id: request.runId,
        project_id: request.projectId,
        error: message,
        agent: startAgent,
      });
      return { status: "failed", error: message };
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
