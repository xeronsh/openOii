import { describe, expect, it, vi } from "vitest";
import {
  AiOperationError,
  assertOperationInFlight,
  beginAiOperation,
  operationHeaders,
  operationInFlight,
} from "../src/ai-operation.js";

/**
 * The unified operation contract: text, image and video all carry the same
 * execution identity, deadline and cancellation semantics, so no provider
 * adapter needs to invent its own policy.
 */
describe("ai operation contract", () => {
  function operation(overrides: Partial<Parameters<typeof beginAiOperation>[0]> = {}) {
    return beginAiOperation({
      operationId: "attempt-1",
      idempotencyKey: "idem-1",
      runId: 7,
      projectId: 3,
      stage: "render_shots",
      ...overrides,
    });
  }

  it("carries the engine-owned execution identity", () => {
    const op = operation();
    expect(op.operationId).toBe("attempt-1");
    expect(op.idempotencyKey).toBe("idem-1");
    expect(op.runId).toBe(7);
    expect(op.projectId).toBe(3);
    expect(op.stage).toBe("render_shots");
  });

  it("sets a deadline from the timeout budget", () => {
    const before = Date.now();
    const op = operation({ timeoutMs: 1000 });
    expect(op.deadline).toBeGreaterThanOrEqual(before + 1000);
    expect(op.deadline).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("exposes one idempotency header for providers that accept it", () => {
    expect(operationHeaders(operation())).toEqual({ "Idempotency-Key": "idem-1" });
  });

  it("reports an in-flight operation as usable", () => {
    expect(operationInFlight(operation())).toBe(true);
    expect(() => assertOperationInFlight(operation())).not.toThrow();
  });

  it("treats an aborted operation as not in flight", () => {
    const controller = new AbortController();
    controller.abort();
    const op = operation({ signal: controller.signal });

    expect(operationInFlight(op)).toBe(false);
    expect(() => assertOperationInFlight(op)).toThrow(/aborted/);
  });

  it("treats an expired deadline as not in flight", () => {
    const op = operation({ timeoutMs: -1 });

    expect(operationInFlight(op)).toBe(false);
    expect(() => assertOperationInFlight(op)).toThrow(/deadline/);
  });

  it("separates cancellation from provider failure in the error shape", () => {
    const aborted = new AiOperationError("aborted", "attempt-1", "cancelled");
    const provider = new AiOperationError("provider", "attempt-1", "503", "doubao");

    expect(aborted.kind).toBe("aborted");
    expect(provider.kind).toBe("provider");
    expect(provider.provider).toBe("doubao");
    expect(provider).toBeInstanceOf(Error);
  });

  it("does not let an adapter invent its own retry policy", () => {
    // The contract deliberately exposes no retry/fallback knob: retrying is an
    // orchestration decision (engine), not a provider one.
    const op = operation();
    expect(op).not.toHaveProperty("retry");
    expect(op).not.toHaveProperty("fallback");
    expect(Object.keys(op).sort()).toEqual([
      "deadline",
      "idempotencyKey",
      "operationId",
      "projectId",
      "runId",
      "signal",
      "stage",
    ]);
  });

  it("honours a signal that aborts while work is pending", () => {
    const controller = new AbortController();
    const op = operation({ signal: controller.signal });
    expect(operationInFlight(op)).toBe(true);

    controller.abort();

    expect(operationInFlight(op)).toBe(false);
    expect(() => assertOperationInFlight(op)).toThrow(/aborted/);
  });

  it("keeps the deadline stable for a single operation", () => {
    vi.useFakeTimers();
    const op = operation({ timeoutMs: 5000 });
    const deadline = op.deadline;
    vi.advanceTimersByTime(4000);
    expect(op.deadline).toBe(deadline);
    expect(operationInFlight(op)).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(operationInFlight(op)).toBe(false);
    vi.useRealTimers();
  });
});

describe("one operation contract across providers", () => {
  it("gives text and media the same identity, deadline and cancellation", async () => {
    const { MediaService } = await import("../src/media/media.js");
    const controller = new AbortController();
    const operation = beginAiOperation({
      operationId: "attempt-9",
      idempotencyKey: "idem-9",
      runId: 4,
      projectId: 2,
      stage: "render_characters",
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    const media = new MediaService({ staticDir: "/tmp/openOii-op" } as never);
    media.setAbortSignal(controller.signal);
    media.setOperation(operation);

    // Both providers read the same object, so identity and the abort signal
    // cannot drift between the text path and the media path.
    expect(operation.idempotencyKey).toBe("idem-9");
    expect(operation.signal).toBe(controller.signal);
    expect(operationHeaders(operation)).toEqual({ "Idempotency-Key": "idem-9" });

    controller.abort();
    expect(operationInFlight(operation)).toBe(false);
  });

  it("lets a media request observe the operation deadline", async () => {
    const { MediaService } = await import("../src/media/media.js");
    const media = new MediaService({
      staticDir: "/tmp/openOii-op",
      imageProvider: "openai",
      imageApiKey: "k",
      imageBaseUrl: "https://example.test",
      imageEndpoint: "/v1/images",
      imageModel: "m",
      enableImageToImage: false,
      fakeImageFixtureUrl: null,
    } as never);

    // An already-expired operation must fail before any request is attempted.
    media.setOperation(
      beginAiOperation({
        operationId: "attempt-10",
        idempotencyKey: "idem-10",
        runId: 1,
        projectId: 1,
        stage: "render_shots",
        timeoutMs: -1,
      }),
    );

    await expect(media.generateImageUrl({ prompt: "never sent" })).rejects.toThrow(/deadline/);
  });
});
