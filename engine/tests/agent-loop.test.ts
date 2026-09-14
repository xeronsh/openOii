import { describe, expect, it, vi } from "vitest";
import { beginAiOperation } from "../src/ai-operation.js";
import {
  AgentStepBudgetExceededError,
  AgentToolNotFoundError,
  runAgentLoop,
  type AgentMessage,
  type AgentStep,
  type AgentTool,
} from "../src/agent/index.js";

/**
 * The Agent Runtime seam is deliberately NOT wired into the pipeline (ADR 0008):
 * there is no agentic use case yet. These tests pin the boundary contract so
 * that wiring one in later is a wiring change, not an architecture change.
 */
function operation(signal?: AbortSignal) {
  return beginAiOperation({
    operationId: "agent-1",
    idempotencyKey: "idem-agent-1",
    runId: 1,
    projectId: 1,
    stage: "agent",
    signal,
    timeoutMs: 60_000,
  });
}

function echoTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "echo",
    description: "echo the input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (args) => `echoed: ${String(args.text)}`,
    ...overrides,
  };
}

describe("agent loop seam", () => {
  it("returns final text when the model asks for no tools", async () => {
    const model = vi.fn(async (): Promise<AgentStep> => ({ text: "done", toolCalls: [] }));

    const result = await runAgentLoop({
      system: "sys",
      task: "do it",
      tools: [],
      model,
      operation: operation(),
      maxSteps: 3,
    });

    expect(result.output).toBe("done");
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toEqual([]);
  });

  it("executes a tool, feeds the result back and finishes on the next turn", async () => {
    const execute = vi.fn(async () => "echoed: hi");
    const turns: AgentStep[] = [
      { text: null, toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }] },
      { text: "finished", toolCalls: [] },
    ];
    let index = 0;
    const seen: AgentMessage[][] = [];
    const model = vi.fn(async (input: { messages: AgentMessage[] }) => {
      seen.push([...input.messages]);
      return turns[index++]!;
    });

    const result = await runAgentLoop({
      system: "sys",
      task: "echo hi",
      tools: [echoTool({ execute })],
      model,
      operation: operation(),
      maxSteps: 5,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.output).toBe("finished");
    expect(result.steps).toBe(2);
    expect(result.toolCalls[0]).toMatchObject({ name: "echo", ok: true, content: "echoed: hi" });
    // The tool result must be visible to the model on the follow-up turn.
    expect(seen[1]!.some((m) => m.role === "tool" && m.content === "echoed: hi")).toBe(true);
  });

  it("stops at the step budget instead of looping forever", async () => {
    // A model that always asks for the same tool never terminates on its own.
    const model = vi.fn(
      async (): Promise<AgentStep> => ({
        text: null,
        toolCalls: [{ id: "c1", name: "echo", arguments: { text: "again" } }],
      }),
    );

    await expect(
      runAgentLoop({
        system: "sys",
        task: "loop",
        tools: [echoTool()],
        model,
        operation: operation(),
        maxSteps: 3,
      }),
    ).rejects.toThrow(AgentStepBudgetExceededError);

    expect(model).toHaveBeenCalledTimes(3);
  });

  it("does not start another turn once the run is cancelled", async () => {
    const controller = new AbortController();
    const model = vi.fn(async (): Promise<AgentStep> => {
      controller.abort();
      return { text: null, toolCalls: [{ id: "c1", name: "echo", arguments: {} }] };
    });

    await expect(
      runAgentLoop({
        system: "sys",
        task: "cancel",
        tools: [echoTool()],
        model,
        operation: operation(controller.signal),
        maxSteps: 5,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("reports a failing tool back to the model rather than aborting the loop", async () => {
    const turns: AgentStep[] = [
      { text: null, toolCalls: [{ id: "c1", name: "boom", arguments: {} }] },
      { text: "recovered", toolCalls: [] },
    ];
    let index = 0;
    const seen: AgentMessage[][] = [];
    const model = vi.fn(async (input: { messages: AgentMessage[] }) => {
      seen.push([...input.messages]);
      return turns[index++]!;
    });

    const result = await runAgentLoop({
      system: "sys",
      task: "fail once",
      tools: [
        echoTool({
          name: "boom",
          execute: async () => {
            throw new Error("tool exploded");
          },
        }),
      ],
      model,
      operation: operation(),
      maxSteps: 5,
    });

    expect(result.output).toBe("recovered");
    expect(result.toolCalls[0]).toMatchObject({ ok: false, content: "tool exploded" });
    expect(seen[1]!.some((m) => m.content === "tool exploded")).toBe(true);
  });

  it("rejects a tool the model invented", async () => {
    const model = vi.fn(
      async (): Promise<AgentStep> => ({
        text: null,
        toolCalls: [{ id: "c1", name: "not-a-tool", arguments: {} }],
      }),
    );

    await expect(
      runAgentLoop({
        system: "sys",
        task: "hallucinate",
        tools: [echoTool()],
        model,
        operation: operation(),
        maxSteps: 2,
      }),
    ).rejects.toThrow(AgentToolNotFoundError);
  });

  it("passes the same operation to the model and to tools", async () => {
    const op = operation();
    const seenOps: unknown[] = [];
    const model = vi.fn(
      async (input: { operation: unknown }): Promise<AgentStep> => {
        seenOps.push(input.operation);
        return { text: null, toolCalls: [{ id: "c1", name: "echo", arguments: { text: "x" } }] };
      },
    );

    await expect(
      runAgentLoop({
        system: "sys",
        task: "identity",
        tools: [
          echoTool({
            execute: async (_args, passed) => {
              seenOps.push(passed);
              return "ok";
            },
          }),
        ],
        model,
        operation: op,
        maxSteps: 1,
      }),
    ).rejects.toThrow(AgentStepBudgetExceededError);

    // Identity is shared, so an agent's provider calls are cancellable and
    // observable exactly like pipeline calls.
    expect(seenOps[0]).toBe(op);
    expect(seenOps[1]).toBe(op);
  });

  it("is not wired into the pipeline", async () => {
    // Guard for the ADR 0008 boundary: the workflow runner must not import the
    // agent loop, and the agent loop must not encode business stages.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const runner = readFileSync(resolve(import.meta.dirname, "../src/pipeline/runner.ts"), "utf8");
    expect(runner).not.toContain("runAgentLoop");
    expect(runner).not.toContain("agent/index");
  });
});
