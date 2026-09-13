/**
 * Run manager: drives a pi-agent-core Agent for a run and records every event
 * into engine_run_events. Phase 3 scope: single-stage smoke loop; the full
 * 17-stage pipeline + gates land in phase 4/5.
 */
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { EngineDatabase } from "./db.js";
import { fakeStreamFn } from "./fake-stream.js";
import { TextLlmService } from "./llm.js";

export interface RunRequest {
  projectId: number;
  runId: number;
  stage?: string;
  autoMode?: boolean;
}

export type RunPhase = "idle" | "running" | "awaiting_confirm" | "completed" | "failed" | "cancelled";

export interface RunHandle {
  request: RunRequest;
  phase: RunPhase;
  agent: Agent;
  abort: AbortController;
  startedAt: number;
}

const FAKE_MODEL = { id: "fake", provider: "fake", api: "openai-compat" } as unknown as Model<never>;

export class RunManager {
  private readonly runs = new Map<number, RunHandle>();

  constructor(
    private readonly db: EngineDatabase,
    private readonly llm: TextLlmService,
  ) {}

  get(runId: number): RunHandle | undefined {
    return this.runs.get(runId);
  }

  list(): RunHandle[] {
    return [...this.runs.values()];
  }

  async start(request: RunRequest): Promise<RunHandle> {
    const existing = this.runs.get(request.runId);
    if (existing && existing.phase === "running") return existing;

    const useFake = this.llm.resolveProvider().key === "fake";
    const agent = new Agent({
      initialState: {
        systemPrompt: "You are openOii's generation engine agent.",
        model: FAKE_MODEL,
        tools: [],
      },
      ...(useFake ? { streamFn: fakeStreamFn as never } : {}),
    });

    const handle: RunHandle = {
      request,
      phase: "running",
      agent,
      abort: new AbortController(),
      startedAt: Date.now(),
    };
    this.runs.set(request.runId, handle);

    agent.subscribe((event: AgentEvent) => {
      this.db.appendEvent(request.runId, request.projectId, event.type, summarizeEvent(event));
    });

    const stage = request.stage ?? "smoke";
    this.db.appendEvent(request.runId, request.projectId, "engine_run_started", {
      stage,
      project_id: request.projectId,
      run_id: request.runId,
      provider: this.llm.resolveProvider().key,
    });

    void agent
      .prompt(`Stage "${stage}" smoke prompt for project ${request.projectId}.`, {
        signal: handle.abort.signal,
      } as never)
      .then(() => {
        if (handle.phase !== "cancelled") handle.phase = "completed";
        this.db.appendEvent(request.runId, request.projectId, "engine_run_completed", {
          stage,
          duration_ms: Date.now() - handle.startedAt,
        });
      })
      .catch((err: unknown) => {
        if (handle.phase === "cancelled") return;
        handle.phase = "failed";
        this.db.appendEvent(request.runId, request.projectId, "engine_run_failed", {
          stage,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return handle;
  }

  cancel(runId: number): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    handle.phase = "cancelled";
    handle.abort.abort();
    this.db.appendEvent(runId, handle.request.projectId, "engine_run_cancelled", {});
    return true;
  }
}

function summarizeEvent(event: AgentEvent): Record<string, unknown> {
  // keep payloads compact: drop bulky partials, keep type-relevant facts
  const anyEvent = event as unknown as Record<string, unknown>;
  const partial = anyEvent.partial as { content?: unknown } | undefined;
  const summary: Record<string, unknown> = { ...anyEvent };
  if (partial && "content" in partial) {
    summary.partial = {
      content: typeof partial.content === "string" ? partial.content.slice(0, 2000) : "[complex]",
    };
  }
  const msg = anyEvent.message as { content?: unknown } | undefined;
  if (msg && "content" in msg) {
    summary.message = {
      content: typeof msg.content === "string" ? msg.content.slice(0, 2000) : "[complex]",
    };
  }
  const assistantEvent = anyEvent.assistantMessageEvent as Record<string, unknown> | undefined;
  if (assistantEvent) {
    summary.assistantMessageEvent = { type: assistantEvent.type };
  }
  return summary;
}
