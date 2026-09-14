/**
 * One AI operation contract shared by text, image and video.
 *
 * Before this, each provider path carried its own copy of the same concerns:
 * text went through `pi-ai` with an AbortSignal, media built its own
 * `Idempotency-Key` header and its own abort plumbing, and neither knew about
 * the other's retry, timeout, credential or error shape. Orchestration
 * semantics therefore existed twice, which is how "retry 3 times", "fall back
 * to another model" and "decide the next stage" ended up encoded in a provider
 * client.
 *
 * An AI operation describes *what is being asked for* and carries the
 * execution identity the engine owns. A provider adapter only turns that into a
 * request and reports success or failure — it never decides policy.
 */
export interface AiOperation {
  /** Stable identity of the logical operation (the stage attempt). */
  operationId: string;
  /** Stage attempt idempotency key; providers that support it receive it. */
  idempotencyKey: string;
  runId: number;
  projectId: number;
  stage: string;
  /** Absolute deadline; adapters must not start work after it passes. */
  deadline: number;
  /** Aborted when the run is cancelled; every provider request must observe it. */
  signal?: AbortSignal;
}

export interface AiOperationContext {
  operationId: string;
  idempotencyKey: string;
  runId: number;
  projectId: number;
  stage: string;
  signal?: AbortSignal;
  /** Milliseconds from now; defaults to `DEFAULT_OPERATION_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Default wall-clock budget for one provider operation. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 10 * 60 * 1000;

export function beginAiOperation(context: AiOperationContext): AiOperation {
  const timeoutMs = context.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  return {
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    runId: context.runId,
    projectId: context.projectId,
    stage: context.stage,
    deadline: Date.now() + timeoutMs,
    signal: context.signal,
  };
}

/** Whether an operation may still start work (deadline + cancellation). */
export function operationInFlight(operation: AiOperation): boolean {
  if (operation.signal?.aborted) return false;
  return Date.now() < operation.deadline;
}

/**
 * Fail fast with one message shape, so a cancelled or timed-out operation is
 * distinguishable from a provider error at every call site.
 */
export function assertOperationInFlight(operation: AiOperation): void {
  if (operation.signal?.aborted) {
    throw new Error(`operation ${operation.operationId} aborted: run cancelled`);
  }
  if (Date.now() >= operation.deadline) {
    throw new Error(`operation ${operation.operationId} exceeded its deadline`);
  }
}

/**
 * The unified error shape for provider failures. Adapters wrap their own
 * failures in this instead of inventing per-provider message formats.
 */
export type AiOperationErrorKind =
  | "aborted"
  | "timeout"
  | "provider"
  | "invalid_response";

export class AiOperationError extends Error {
  constructor(
    readonly kind: AiOperationErrorKind,
    readonly operationId: string,
    message: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "AiOperationError";
  }
}

/**
 * Header contract for providers that accept an idempotency key. The media
 * service used to build this inline; it is shared now so text/image/video
 * carry operation identity the same way.
 */
export function operationHeaders(operation: AiOperation): Record<string, string> {
  return { "Idempotency-Key": operation.idempotencyKey };
}
