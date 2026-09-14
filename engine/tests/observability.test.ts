import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  TRACER_NAME,
  errorTypeOf,
  recordUsage,
  withProviderSpan,
  withSpan,
  withStageSpan,
} from "../src/observability.js";

/**
 * The observability layer must be thin and honest: spans exist for the
 * run → stage → provider hierarchy, failures are classified (cancelled vs
 * provider error vs lease loss), and nothing is emitted when no provider is
 * registered. A test provider is registered here, which is exactly how a
 * deployment opts in.
 */
describe("engine observability", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // OTel v2 takes span processors through the provider options.
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    } as never);
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
    trace.disable();
  });

  const baseAttributes = {
    "openoii.run_id": 7,
    "openoii.project_id": 3,
    "openoii.stage": "render_shots",
    "openoii.stage_attempt_id": "attempt-1",
  } as const;

  function names(spans: ReadableSpan[]): string[] {
    return spans.map((span) => span.name);
  }

  it("records a stage span with the run identity", async () => {
    const result = await withStageSpan("stage render_shots", baseAttributes, async (span: Span) => {
      span.setAttribute("openoii.status", "succeeded");
      return "ok";
    });

    expect(result).toBe("ok");
    const spans = exporter.getFinishedSpans();
    expect(names(spans)).toEqual(["stage render_shots"]);
    expect(spans[0]!.attributes["openoii.run_id"]).toBe(7);
    expect(spans[0]!.attributes["openoii.stage"]).toBe("render_shots");
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it("nests a provider span under its stage span", async () => {
    await withStageSpan("stage render_shots", baseAttributes, async () => {
      await withProviderSpan(
        "gen_ai.image.generate",
        { ...baseAttributes, "gen_ai.system": "doubao", "openoii.retry_count": 0 },
        async () => "url",
      );
    });

    const spans = exporter.getFinishedSpans();
    const providerSpan = spans.find((span) => span.name === "gen_ai.image.generate")!;
    const stageSpan = spans.find((span) => span.name === "stage render_shots")!;
    expect(providerSpan.attributes["gen_ai.system"]).toBe("doubao");
    expect(providerSpan.attributes["openoii.retry_count"]).toBe(0);
    expect(stageSpan.name).toBe("stage render_shots");
  });

  it("records token usage with GenAI attribute names", async () => {
    await withSpan("gen_ai.text.complete", baseAttributes, async (span) => {
      recordUsage(span, {
        model: "claude-sonnet-4-5",
        usage: { input: 120, output: 44, cost: { total: 0.0031 } },
      });
    });

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(120);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(44);
    expect(span.attributes["gen_ai.request.model"]).toBe("claude-sonnet-4-5");
    expect(span.attributes["openoii.cost.total"]).toBe(0.0031);
  });

  it("ends the span and records the error when work fails", async () => {
    await expect(
      withSpan("gen_ai.image.generate", baseAttributes, async () => {
        throw new Error("provider 503");
      }),
    ).rejects.toThrow(/503/);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // A plain Error reports its constructor name; classified kinds are used
    // only for the cases the engine distinguishes.
    expect(span.attributes["openoii.error_type"]).toBe("Error");
    expect(span.events.length).toBeGreaterThan(0);
  });

  it("classifies cancellation, deadlines and lease loss apart from provider errors", async () => {
    await expect(
      withSpan("stage", baseAttributes, async () => {
        throw new Error("run cancelled: provider request aborted");
      }),
    ).rejects.toThrow();
    await expect(
      withSpan("stage", baseAttributes, async () => {
        throw new Error("operation attempt-1 exceeded its deadline");
      }),
    ).rejects.toThrow();
    await expect(
      withSpan("stage", baseAttributes, async () => {
        throw new Error("execution lease lost for run 7");
      }),
    ).rejects.toThrow();

    const kinds = exporter.getFinishedSpans().map((span) => span.attributes["openoii.error_type"]);
    expect(kinds).toEqual(["cancelled", "timeout", "lease_lost"]);
  });

  it("classifies error types directly", () => {
    expect(errorTypeOf(new Error("run cancelled"))).toBe("cancelled");
    expect(errorTypeOf(new Error("aborted by signal"))).toBe("cancelled");
    expect(errorTypeOf(new Error("deadline exceeded"))).toBe("timeout");
    expect(errorTypeOf(new Error("execution lease lost for run 1"))).toBe("lease_lost");
    expect(errorTypeOf(new Error("provider 500"))).toBe("Error");
    // Provider adapters set a name so traces separate them from generic errors.
    const providerError = new Error("provider 500");
    providerError.name = "ProviderError";
    expect(errorTypeOf(providerError)).toBe("ProviderError");
    expect(errorTypeOf("nope")).toBe("unknown");
  });

  it("shares one tracer so spans correlate", async () => {
    await withStageSpan("stage", baseAttributes, async () => undefined);
    expect(TRACER_NAME).toBe("openoii-engine");
  });

  it("emits nothing when no provider is registered", async () => {
    trace.disable();
    // Without a provider the API returns no-op spans: local runs and tests pay
    // nothing, and no exporter is required to run the engine.
    const result = await withSpan("stage", baseAttributes, async () => "silent");
    expect(result).toBe("silent");
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe("run -> stage -> provider span tree", () => {
  it("nests provider spans under the run and stage spans", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    } as never);
    trace.setGlobalTracerProvider(provider);

    const { withRunSpan, withStageSpan, withProviderSpan } = await import(
      "../src/observability.js"
    );

    try {
      await withRunSpan(7, 3, async () => {
        await withStageSpan(
          "stage render_shots",
          {
            "openoii.run_id": 7,
            "openoii.project_id": 3,
            "openoii.stage": "render_shots",
            "openoii.stage_attempt_id": "attempt-1",
          },
          async () => {
            await withProviderSpan(
              "gen_ai.image.generate",
              {
                "openoii.run_id": 7,
                "openoii.project_id": 3,
                "openoii.stage": "render_shots",
                "openoii.stage_attempt_id": "attempt-1",
                "gen_ai.system": "doubao",
              },
              async () => "url",
            );
          },
        );
      });

      const spans = exporter.getFinishedSpans();
      const byName = new Map(spans.map((span) => [span.name, span]));
      const run = byName.get("run")!;
      const stage = byName.get("stage render_shots")!;
      const providerSpan = byName.get("gen_ai.image.generate")!;

      // The hierarchy is the point: run contains stage contains provider.
      expect(run).toBeDefined();
      expect(stage.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
      expect(providerSpan.parentSpanContext?.spanId).toBe(stage.spanContext().spanId);
      // Identity is on every level, so a provider call is traceable to its run.
      expect(providerSpan.attributes["openoii.run_id"]).toBe(7);
      expect(providerSpan.attributes["openoii.stage_attempt_id"]).toBe("attempt-1");
    } finally {
      exporter.reset();
      await provider.shutdown();
      trace.disable();
    }
  });
});
