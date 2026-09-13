/**
 * Pipeline runner: the generated linear workflow with approval gates,
 * stage checkpoints, critique regeneration routing, durable cancellation and
 * execution fencing.
 */
import {
  AGENT_COMPLETION_INFO,
  APPROVAL_TO_PRODUCED_STAGE,
  GATE_AGENT,
  NEXT_STAGE,
  PRODUCTION_STAGE_SEQUENCE,
  agentForStage,
  progressForStage,
  type StageId,
} from "../contract.js";
import type { EngineDatabase } from "../db.js";
import { MediaService, resolveMediaSettings } from "../media/media.js";
import { TextLlmService } from "../llm.js";
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
  /** Feedback reruns start mid-pipeline; defaults to a full run from plan_outline. */
  startStage?: StageId;
}

export interface PipelineOutcome {
  status: "completed" | "failed" | "cancelled";
  error?: string;
}

const CONFIRM_POLL_MS = 300;
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

export class PipelineRunner {
  private cancelRequested = false;

  constructor(
    private readonly db: EngineDatabase,
    private readonly shared: SharedDb,
    private readonly llm: TextLlmService,
  ) {}

  requestCancel(): void {
    this.cancelRequested = true;
  }

  private shouldCancel(runId: number): boolean {
    return this.cancelRequested || this.shared.runCancelRequested(runId);
  }

  /**
   * Resume after an engine restart: rebuild completed stages from
   * engine_checkpoints and continue from the next pending stage.
   */
  async resume(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const completed = new Set<string>();
    for (const stage of PRODUCTION_STAGE_SEQUENCE) {
      const row = this.db.db
        .prepare("SELECT stage FROM engine_checkpoints WHERE run_id = ? AND stage = ?")
        .get(request.runId, stage);
      if (row) completed.add(stage);
    }
    if (completed.size === 0) {
      return this.run(request);
    }
    const lastCompleted = PRODUCTION_STAGE_SEQUENCE.filter((s) => completed.has(s)).at(-1);
    if (!lastCompleted) return this.run(request);
    const resumeStage = NEXT_STAGE[lastCompleted];
    if (!resumeStage) return { status: "completed" };

    return this.runFromStage(request, resumeStage, completed);
  }

  async run(request: PipelineRequest): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const startStage = request.startStage ?? "plan_outline";
    // 中途起跑（用户反馈重跑）时，把起点之前的生产阶段标记为已完成，
    // 使这些阶段对应的闸门自动放行、不重复生成。
    const completed = new Set<string>();
    for (const stage of PRODUCTION_STAGE_SEQUENCE) {
      if (stage === startStage) break;
      completed.add(stage);
    }
    return this.runFromStage(request, startStage, completed);
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
    completedStages: Set<string>,
  ): Promise<PipelineOutcome> {
    this.shared.assertExecutionFence();
    const project = this.shared.getProject(request.projectId);
    if (!project) return { status: "failed", error: `project ${request.projectId} not found` };

    const mediaSettings = resolveMediaSettings(this.db);
    const media = new MediaService(mediaSettings);
    const emitter = new PipelineEmitter(this.db, this.shared, request.projectId, request.runId, {
      thinkingChainEnabled:
        this.db.configValue("THINKING_CHAIN_ENABLED", "THINKING_CHAIN_ENABLED", "true") === "true",
      thinkingDetailLevel: (this.db.configValue(
        "THINKING_CHAIN_DETAIL_LEVEL",
        "THINKING_CHAIN_DETAIL_LEVEL",
        "normal",
      ) ?? "normal") as "minimal" | "normal" | "verbose",
    });

    // run_started + data_cleared (contract parity: full re-plan wipe)
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
      preserved_stages: fullRun
        ? []
        : PRODUCTION_STAGE_SEQUENCE.filter((s) => completedStages.has(s)),
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
      critiqueEnabled:
        this.db.configValue("CRITIQUE_ENABLED", "CRITIQUE_ENABLED", "true") === "true",
      critiqueScoreThreshold: Number(
        this.db.configValue("CRITIQUE_SCORE_THRESHOLD", "CRITIQUE_SCORE_THRESHOLD", "6") ?? 6,
      ),
      critiqueMaxRounds: Number(
        this.db.configValue("CRITIQUE_MAX_ROUNDS", "CRITIQUE_MAX_ROUNDS", "2") ?? 2,
      ),
      completionInfo: null,
      willRegenerate: false,
    };

    let stage: StageId = startStage;
    let guard = 0;
    const completedSet = completedStages;
    try {
      while (stage !== null && guard < 64) {
        guard += 1;
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) {
          return await this.finishCancelled(request, emitter);
        }

        if (stage === "review") {
          break;
        }

        if (isGate(stage)) {
          const produced = APPROVAL_TO_PRODUCED_STAGE[stage];
          if (produced && completedSet.has(produced)) {
            stage = NEXT_STAGE[stage] as StageId;
            continue;
          }
          await this.runGate(stage, request, ctx);
          if (this.shouldCancel(request.runId)) {
            return await this.finishCancelled(request, emitter);
          }
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        if (isCritique(stage)) {
          const entityType = stage === "critique_character_images" ? "character" : "shot";
          const outcome = await runCritique(ctx, entityType);
          this.shared.assertExecutionFence();
          if (this.shouldCancel(request.runId)) {
            return await this.finishCancelled(request, emitter);
          }
          const roundsKey: "characters" | "shots" =
            entityType === "character" ? "characters" : "shots";
          ctx.critiqueRounds[roundsKey] += 1;
          if (outcome.willRegenerate) {
            stage = entityType === "character" ? "render_characters" : "render_shots";
            continue;
          }
          stage = NEXT_STAGE[stage] as StageId;
          continue;
        }

        await this.runProduction(stage, ctx, request);
        // External calls are at-least-once. Before recording completion, verify
        // this runner still owns the fencing token and that cancellation was not
        // requested while the provider call was in flight.
        this.shared.assertExecutionFence();
        if (this.shouldCancel(request.runId)) {
          return await this.finishCancelled(request, emitter);
        }
        this.db.saveCheckpoint(request.runId, stage, {
          completed_at: new Date().toISOString(),
        });
        completedSet.add(stage);
        stage = NEXT_STAGE[stage] as StageId;
      }

      this.shared.assertExecutionFence();
      if (this.shouldCancel(request.runId)) {
        return await this.finishCancelled(request, emitter);
      }

      const finalProject = this.shared.getProject(request.projectId);
      if (!finalProject?.video_url && !videoSkippedFor(this.db, request.runId)) {
        throw new Error(
          "Compose finished without a usable final video: final project video_url is empty",
        );
      }
      this.shared.updateProject(request.projectId, { status: "ready" });
      // Persist terminal projection before publishing the terminal event so a
      // reconnect hydration can never observe running after seeing completion.
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

      // A stale executor must stop silently: its fencing token no longer gives
      // it authority to mutate the run or project.
      if (message.startsWith("execution lease lost for run")) {
        return { status: "failed", error: message };
      }

      if (this.shouldCancel(request.runId)) {
        return await this.finishCancelled(request, emitter);
      }

      this.shared.assertExecutionFence();
      this.shared.updateProject(request.projectId, { status: "failed" });
      this.shared.updateRun(request.runId, { status: "failed", error: message });
      emitter.emit("project_updated", { project: { id: request.projectId, status: "failed" } });
      emitter.emit("run_failed", {
        run_id: request.runId,
        project_id: request.projectId,
        error: message,
        agent: null,
        current_stage: null,
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
      case "plan_outline":
        await runOutline(ctx);
        break;
      case "plan_characters":
        await runPlanCharacters(ctx);
        break;
      case "plan_shots":
        await runPlanShots(ctx);
        break;
      case "render_characters":
        await runRenderCharacters(ctx);
        break;
      case "render_shots":
        await runRenderShots(ctx);
        break;
      case "compose_videos":
        await runComposeVideos(ctx);
        break;
      case "compose_merge":
        await runComposeMerge(ctx);
        break;
      case "add_audio":
        await runAddAudio(ctx);
        break;
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

  private async runGate(
    stage: StageId,
    request: PipelineRequest,
    ctx: StageContext,
  ): Promise<void> {
    const gateAgent = GATE_AGENT[stage] ?? agentForStage(stage);
    const currentStage = stage;
    const nextStage = NEXT_STAGE[stage];

    const info =
      ctx.completionInfo ??
      AGENT_COMPLETION_INFO[gateAgent] ?? {
        completed: `「${gateAgent}」已完成`,
        details: "",
        next: "继续下一步",
        question: "是否继续？",
      };
    const message = [info.completed, info.details, info.next, info.question]
      .filter((part) => part && part.trim())
      .join("\n");

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

    this.shared.updateRun(request.runId, {
      status: "waiting_for_approval",
      current_agent: gateAgent,
    });
    this.shared.setAwaitingPayload(request.runId, awaitingPayload);
    ctx.emitter.emit("run_awaiting_confirm", awaitingPayload);

    if (request.autoMode) {
      this.shared.setAwaitingPayload(request.runId, null);
      this.shared.updateRun(request.runId, { status: "running" });
      const postStage = nextStage ?? currentStage;
      ctx.emitter.emit("run_confirmed", {
        run_id: request.runId,
        project_id: request.projectId,
        agent: gateAgent,
        gate: gateAgent,
        current_stage: postStage,
        stage: postStage,
        next_stage: NEXT_STAGE[postStage as StageId] ?? null,
        recovery_summary: {
          project_id: request.projectId,
          run_id: request.runId,
          thread_id: `agent-run-${request.runId}`,
          current_stage: postStage,
        },
      });
      return;
    }

    const approved = await this.waitForConfirm(request.runId);
    if (!approved) {
      if (this.shouldCancel(request.runId)) return;
      throw new Error(`等待确认超时（agent: ${gateAgent}）`);
    }
    this.shared.setAwaitingPayload(request.runId, null);
    this.shared.updateRun(request.runId, { status: "running" });

    const postStage = nextStage ?? currentStage;
    ctx.emitter.emit("run_confirmed", {
      run_id: request.runId,
      project_id: request.projectId,
      agent: gateAgent,
      gate: gateAgent,
      current_stage: postStage,
      stage: postStage,
      next_stage: NEXT_STAGE[postStage as StageId] ?? null,
      recovery_summary: {
        project_id: request.projectId,
        run_id: request.runId,
        thread_id: `agent-run-${request.runId}`,
        current_stage: postStage,
      },
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
    cp &&
      typeof cp.state === "object" &&
      cp.state !== null &&
      (cp.state as { videoSkipped?: boolean }).videoSkipped,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
