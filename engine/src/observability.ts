/**
 * Thinnest useful observability layer: OpenTelemetry spans for the run → stage
 * → provider hierarchy.
 *
 * Deliberately minimal — no exporter is wired in by default and no second
 * framework is introduced. The engine records spans through `@opentelemetry/api`
 * (a no-op when no provider is registered), so a deployment that wants traces
 * registers a provider and gets them, while tests and local runs pay nothing.
 *
 * Attribute names follow the OpenTelemetry GenAI semantic conventions where
 * they exist (still marked Development upstream): `gen_ai.system`,
 * `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`.
 * Engine-specific identity uses plain names so the standard ones stay honest.
 */
import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

export const TRACER_NAME = "openoii-engine";

/** Engine-specific identity attributes, kept stable for log correlation. */
export interface OperationSpanAttributes {
  [key: string]: string | number | boolean | undefined;
  "openoii.run_id": number;
  "openoii.project_id": number;
  "openoii.stage": string;
  "openoii.stage_attempt_id": string;
  "openoii.execution_attempt"?: number;
}

export interface GenAiSpanAttributes {
  [key: string]: string | number | boolean | undefined;
  "gen_ai.system"?: string;
  "gen_ai.operation.name"?: string;
  "gen_ai.request.model"?: string;
  "gen_ai.usage.input_tokens"?: number;
  "gen_ai.usage.output_tokens"?: number;
  "openoii.retry_count"?: number;
  "openoii.status"?: string;
  "openoii.error_type"?: string;
}

function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a span, recording error type/status on failure.
 *
 * The span is always ended, including on abort, so a cancelled run does not
 * leak an unfinished span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes });
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(error instanceof Error ? error : String(error));
    span.setAttribute("openoii.error_type", errorTypeOf(error));
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Classify a failure so traces can separate cancellation and deadlines from
 * genuine provider errors without parsing messages.
 */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) {
    if (/abort|cancel/i.test(error.message)) return "cancelled";
    if (/deadline|timeout|timed out/i.test(error.message)) return "timeout";
    if (/lease lost/i.test(error.message)) return "lease_lost";
    return error.name || "error";
  }
  return "unknown";
}

/** One span per stage attempt, carrying the run identity it belongs to. */
export async function withStageSpan<T>(
  name: string,
  attributes: OperationSpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(name, attributes, fn);
}

/** One span per provider call, carrying GenAI attributes plus retry count. */
export async function withProviderSpan<T>(
  name: string,
  attributes: OperationSpanAttributes & GenAiSpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(name, attributes, fn);
}

/** Record token usage once a provider reports it. */
export function recordUsage(
  span: Span,
  usage: { inputTokens?: number; outputTokens?: number; model?: string },
): void {
  if (usage.model) span.setAttribute("gen_ai.request.model", usage.model);
  if (typeof usage.inputTokens === "number") {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (typeof usage.outputTokens === "number") {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
}
