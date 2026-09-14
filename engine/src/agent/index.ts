/**
 * Agent Runtime seam.
 *
 * ADR 0008 divides the two kinds of work this repository does:
 *
 * - **Workflow Runtime** (`src/pipeline/`) owns the fixed 15-stage creation
 *   pipeline. It is a state machine, and a state machine is not an agent.
 * - **Agent Runtime** (this module) is for work that genuinely needs a model to
 *   choose its tools and iterate: model → tool calls → results → model.
 *
 * This module is a SEAM, not a product feature. It is deliberately not wired
 * into `pipeline/runner.ts`: there is no agentic use case yet, and building a
 * tool system nothing calls would be speculative. What it does provide is the
 * boundary the engine needs so that adding such a use case is a wiring change
 * instead of an architecture change:
 *
 * - a loop that is bounded (step budget) and cancellable (AbortSignal),
 * - tools that declare their schema and are validated before invocation,
 * - one operation identity per run (`ai-operation.ts`), so an agent's provider
 *   calls are observable and cancellable exactly like pipeline calls.
 *
 * A workflow stage must never call `runAgentLoop()`; if it needs a model it
 * calls the LLM directly. Conversely, the agent loop must never encode business
 * stages — those belong in the workflow.
 */
import { AiOperationError, assertOperationInFlight, type AiOperation } from "../ai-operation.js";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Serialised output handed back to the model. */
  content: string;
}

/**
 * A tool the agent may choose. `parameters` is a JSON Schema object so the tool
 * definition can be handed to a provider verbatim and validated locally.
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, operation: AiOperation) => Promise<string>;
}

/** One model turn: either final text, or the tool calls to perform next. */
export interface AgentStep {
  text: string | null;
  toolCalls: AgentToolCall[];
}

/**
 * The model port. The loop owns control flow; the provider owns nothing but
 * turning a transcript into a step.
 */
export type AgentModelCall = (input: {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  operation: AiOperation;
}) => Promise<AgentStep>;

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: AgentToolCall[];
}

export interface AgentLoopOptions {
  system: string;
  task: string;
  tools: AgentTool[];
  model: AgentModelCall;
  operation: AiOperation;
  /** Hard ceiling on model turns. A loop without one is an outage waiting. */
  maxSteps: number;
  /** Optional observer, used for tracing without the loop knowing the sink. */
  onStep?: (step: number, message: AgentMessage) => void;
}

export interface AgentLoopResult {
  output: string;
  steps: number;
  toolCalls: AgentToolResult[];
}

export class AgentStepBudgetExceededError extends AiOperationError {
  constructor(operationId: string, maxSteps: number) {
    super(
      "timeout",
      operationId,
      `agent loop exceeded its step budget of ${maxSteps} turns`,
    );
    this.name = "AgentStepBudgetExceededError";
  }
}

export class AgentToolNotFoundError extends AiOperationError {
  constructor(operationId: string, toolName: string) {
    super("invalid_response", operationId, `model requested unknown tool ${toolName}`);
    this.name = "AgentToolNotFoundError";
  }
}

/**
 * Run a bounded, cancellable agent loop.
 *
 * Every iteration re-checks the operation (deadline + cancellation), so a run
 * stopped mid-plan stops before the next provider call rather than after.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const messages: AgentMessage[] = [{ role: "user", content: options.task }];
  const toolCalls: AgentToolResult[] = [];

  for (let step = 1; step <= options.maxSteps; step += 1) {
    assertOperationInFlight(options.operation);

    const turn = await options.model({
      system: options.system,
      messages,
      tools: options.tools,
      operation: options.operation,
    });

    if (turn.toolCalls.length === 0) {
      return { output: turn.text ?? "", steps: step, toolCalls };
    }

    messages.push({ role: "assistant", content: turn.text ?? "", toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const tool = byName.get(call.name);
      if (!tool) throw new AgentToolNotFoundError(options.operation.operationId, call.name);
      assertOperationInFlight(options.operation);

      let result: AgentToolResult;
      try {
        result = {
          callId: call.id,
          name: call.name,
          ok: true,
          content: await tool.execute(call.arguments, options.operation),
        };
      } catch (error) {
        // A failing tool is reported to the model, not fatal to the loop: the
        // model can recover, and hiding the error would make it hallucinate.
        result = {
          callId: call.id,
          name: call.name,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        };
      }
      toolCalls.push(result);
      const message: AgentMessage = {
        role: "tool",
        toolCallId: call.id,
        content: result.content,
      };
      messages.push(message);
      options.onStep?.(step, message);
    }
  }

  throw new AgentStepBudgetExceededError(options.operation.operationId, options.maxSteps);
}
