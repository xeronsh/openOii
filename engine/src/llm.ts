/** Text LLM service built on pi-ai with immutable per-run provider/context selection. */
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  getCurrentSystemPrompt,
  getModels,
  registerFauxProvider,
  stream,
  type Api,
  type FauxProviderRegistration,
  type ImageContent,
  type Model,
  type TextContent,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import type { EngineDatabase } from "./db.js";
import { FAKE_STREAM_ERROR_TOKEN, fakeRespond, fakeThinking } from "./fake-stream.js";
import {
  AiOperationError,
  assertOperationInFlight,
  type AiOperation,
  withAiActivity,
} from "./ai-operation.js";
import {
  operationSpanAttributes,
  recordUsage,
  withProviderSpan,
} from "./observability.js";

export type TextProviderKey = "fake" | "anthropic" | "openai";

export interface TextProviderSnapshot {
  provider?: string | null;
  base_url?: string | null;
  model?: string | null;
  endpoint?: string | null;
  reasoning_effort?: string | null;
  credential_keys?: string[] | null;
}

export interface RunCreativeContext {
  workflow_version?: number;
  project?: Record<string, unknown> | null;
  skill?: Record<string, unknown> | null;
  universe_context?: Record<string, unknown> | null;
  style_template?: Record<string, unknown> | null;
  providers?: Record<string, unknown> | null;
  policy?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Aborted when the run is cancelled; forwarded to the provider request. */
  signal?: AbortSignal;
  /**
   * Operation identity this call belongs to. Supplied by the stage attempt, so
   * text carries the same operation contract as image/video (`ai-operation.ts`)
   * rather than only a bare abort signal.
   */
  operation?: AiOperation;
  /**
   * Called on every thinking/text delta with the text accumulated so far.
   * Real providers and the fake provider stream through the same pi-ai path.
   */
  onStream?: (update: LlmStreamUpdate) => void;
  /**
   * Images the model must actually see (pi-ai image content blocks), e.g. the
   * render a critic is reviewing. Never pass image URLs as prompt text: a
   * text-only model cannot fetch them and invents (or omits) a verdict.
   */
  images?: LlmImageInput[];
  /**
   * Shape check for the structured output of this operation. Returns an error
   * message when the object does not have the shape the caller consumes. Both
   * the first answer and the repaired answer must pass it.
   */
  validate?: (data: Record<string, unknown>) => string | null;
}

export interface LlmImageInput {
  /** base64 payload, without the data: prefix */
  data: string;
  mimeType: string;
}

/** Default output budget for structured workflow calls (and their repair). */
export const DEFAULT_MAX_TOKENS = 8192;

export interface LlmStreamUpdate {
  thinking: string;
  text: string;
}

/**
 * The fake provider is pi-ai's own faux provider, so fake runs go through the
 * same `stream()` call, event shapes and abort handling as real providers.
 * `OPENOII_FAKE_STREAM_MS` is the average delay per chunk (chunks are 1–3
 * pi-ai "tokens", i.e. 4–12 characters, so delays jitter with chunk size);
 * 0 streams without delay.
 */
let fauxRegistration: FauxProviderRegistration | null = null;
export const DEFAULT_FAKE_STREAM_MS = 30;

function fakeStreamMs(): number {
  const raw = Number(process.env.OPENOII_FAKE_STREAM_MS ?? DEFAULT_FAKE_STREAM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function fakeModel(system: string, prompt: string): Model<Api> {
  if (!fauxRegistration) {
    const ms = fakeStreamMs();
    fauxRegistration = registerFauxProvider({
      provider: "fake",
      models: [{ id: "fake", name: "Fake", reasoning: true }],
      tokenSize: { min: 1, max: 3 },
      // average chunk = 2 tokens, so 2 tokens per `ms`
      tokensPerSecond: ms > 0 ? 2000 / ms : undefined,
    });
  }
  // Fixture errors (e.g. too many shots) still throw here, before any request.
  fakeRespond(system, prompt);
  // The response queue is shared, so the factory rebuilds the reply from the
  // context it is handed; concurrent fake calls cannot swap answers.
  fauxRegistration.appendResponses([
    (context) => {
      // pi-ai 1.x carries the system prompt as a leading system message.
      const sys = getCurrentSystemPrompt(context.messages);
      const first = context.messages.find((message) => message.role !== "system");
      const input =
        first?.role === "user"
          ? typeof first.content === "string"
            ? first.content
            : first.content
                .filter((block): block is TextContent => block.type === "text")
                .map((block) => block.text)
                .join("")
          : "";
      const text = fakeRespond(sys, input);
      const thinking = fauxThinking(fakeThinking(sys));
      return input.includes(FAKE_STREAM_ERROR_TOKEN)
        ? fauxAssistantMessage([thinking, fauxText(text.slice(0, Math.ceil(text.length / 2)))], {
            stopReason: "error",
            errorMessage: "fake 流式输出中断（测试用）",
          })
        : fauxAssistantMessage([thinking, fauxText(text)]);
    },
  ]);
  return fauxRegistration.getModel() as unknown as Model<Api>;
}

export interface LlmResponse {
  text: string;
  provider: string;
  model: string;
}

/** Parse the tolerated provider wrappers, but never manufacture an empty object. */
export function parseJsonObjectText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded candidate.
    }
  }
  throw new Error("LLM output is not a valid JSON object");
}

export class TextLlmService {
  constructor(
    private readonly db: EngineDatabase,
    private readonly pinned?: TextProviderSnapshot,
    private readonly runContext?: RunCreativeContext,
  ) {}

  forSnapshot(
    snapshot: TextProviderSnapshot | null | undefined,
    runContext?: RunCreativeContext | null,
  ): TextLlmService {
    return new TextLlmService(this.db, snapshot ?? undefined, runContext ?? undefined);
  }

  private secret(keys: string[]): string {
    for (const key of keys) {
      const value = this.db.configValue(key, key);
      if (value) return value;
    }
    return "";
  }

  private reasoningEffort(): ThinkingLevel | undefined {
    const value = this.pinned?.reasoning_effort ?? this.db.configValue("TEXT_REASONING_EFFORT");
    return ["minimal", "low", "medium", "high", "xhigh"].includes(value ?? "")
      ? (value as ThinkingLevel)
      : undefined;
  }

  private promptWithRunContext(prompt: string): string {
    if (!this.runContext) return prompt;
    try {
      const parsed = JSON.parse(prompt) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const input = parsed as Record<string, unknown>;
        return JSON.stringify({
          ...input,
          skill: this.runContext.skill ?? input.skill ?? null,
          universe_context: this.runContext.universe_context ?? input.universe_context ?? null,
          style_template: this.runContext.style_template ?? input.style_template ?? null,
          run_context: {
            workflow_version: this.runContext.workflow_version ?? null,
            project_revision:
              typeof this.runContext.project === "object" && this.runContext.project !== null
                ? this.runContext.project.revision ?? null
                : null,
            policy: this.runContext.policy ?? null,
          },
        });
      }
    } catch {
      // Plain-text requests still receive the immutable context in a delimited block.
    }
    return `${prompt}\n\n<run_context>${JSON.stringify(this.runContext)}</run_context>`;
  }

  resolveProvider(): {
    key: TextProviderKey;
    baseUrl?: string;
    apiKey?: string;
    model: string;
    reasoning?: ThinkingLevel;
    endpoint?: string;
  } {
    if (this.pinned?.provider) {
      const raw = this.pinned.provider;
      const key = (["fake", "anthropic", "openai"] as const).includes(raw as TextProviderKey)
        ? (raw as TextProviderKey)
        : null;
      if (key === null) throw new Error(`unsupported pinned text provider: ${raw}`);
      if (key === "fake") return { key, model: this.pinned.model || "fake" };
      const resolved = {
        key,
        baseUrl: this.pinned.base_url ?? undefined,
        apiKey: this.secret(
          this.pinned.credential_keys ??
            (key === "anthropic"
              ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
              : ["TEXT_API_KEY"]),
        ),
        model:
          this.pinned.model ||
          (key === "anthropic" ? "claude-sonnet-4-5-20250929" : "deepseek-chat"),
      };
      return key === "openai"
        ? {
            ...resolved,
            reasoning: this.reasoningEffort(),
            endpoint: this.pinned.endpoint ?? undefined,
          }
        : resolved;
    }

    const raw = this.db.configValue("TEXT_PROVIDER", "TEXT_PROVIDER", "anthropic") ?? "anthropic";
    const key = (["fake", "anthropic", "openai"] as const).includes(raw as TextProviderKey)
      ? (raw as TextProviderKey)
      : "anthropic";

    if (key === "fake") return { key, model: "fake" };
    if (key === "anthropic") {
      return {
        key,
        baseUrl: this.db.configValue("ANTHROPIC_BASE_URL", "ANTHROPIC_BASE_URL"),
        apiKey:
          this.db.configValue("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN") ??
          this.db.configValue("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY") ??
          "",
        model: this.db.configValue(
          "ANTHROPIC_MODEL",
          "ANTHROPIC_MODEL",
          "claude-sonnet-4-5-20250929",
        ),
      };
    }
    return {
      key,
      baseUrl: this.db.configValue("TEXT_BASE_URL", "TEXT_BASE_URL"),
      apiKey: this.db.configValue("TEXT_API_KEY", "TEXT_API_KEY") ?? "",
      model: this.db.configValue("TEXT_MODEL", "TEXT_MODEL", "deepseek-chat"),
      reasoning: this.reasoningEffort(),
      endpoint: this.db.configValue("TEXT_ENDPOINT", "TEXT_ENDPOINT") ?? undefined,
    };
  }

  /**
   * OpenAI-compatible endpoint for calls that carry images
   * (CRITIQUE_VISION_*), or null when none is configured.
   */
  resolveVisionProvider(): {
    key: TextProviderKey;
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoning?: ThinkingLevel;
    endpoint?: string;
  } | null {
    const baseUrl = this.db.configValue("CRITIQUE_VISION_BASE_URL", "CRITIQUE_VISION_BASE_URL");
    if (!baseUrl) return null;
    return {
      key: "openai",
      baseUrl,
      // pi-ai refuses an empty key; a local server ignores the placeholder.
      apiKey: this.db.configValue("CRITIQUE_VISION_API_KEY", "CRITIQUE_VISION_API_KEY") || "local",
      model: this.db.configValue("CRITIQUE_VISION_MODEL", "CRITIQUE_VISION_MODEL") || "vision",
    };
  }

  private visionProbe: { at: number; status: { ok: boolean; reason: string } } | null = null;

  /**
   * Can the critic look at images right now? A blind text model used to get
   * the images when no vision model was set, and its non-answers passed every
   * shot; a vision server that was down or OOM-killed did the same. The
   * caller marks shots 「未检查」 instead when this says no. Only the fake
   * text provider (tests, demos) may review without a vision endpoint.
   * GET {base}/models, 5 s timeout, cached for a minute.
   */
  async visionStatus(): Promise<{ ok: boolean; reason: string }> {
    const vision = this.resolveVisionProvider();
    if (!vision) {
      return this.resolveProvider().key === "fake"
        ? { ok: true, reason: "" }
        : { ok: false, reason: "未配置视觉审查模型（设置 → 视觉审查）" };
    }
    if (this.visionProbe && Date.now() - this.visionProbe.at < 60_000) return this.visionProbe.status;
    let status: { ok: boolean; reason: string };
    try {
      const response = await fetch(`${vision.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${vision.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      status =
        response.status === 401 || response.status === 403
          ? { ok: false, reason: `视觉审查服务拒绝了密钥（HTTP ${response.status}）` }
          : response.status >= 500
            ? { ok: false, reason: `视觉审查服务出错（HTTP ${response.status}）` }
            : { ok: true, reason: "" };
    } catch {
      status = { ok: false, reason: "视觉审查服务连不上（未启动、已崩溃或内存不足被系统结束）" };
    }
    this.visionProbe = { at: Date.now(), status };
    return status;
  }

  /**
   * Build the pi-ai model descriptor for a provider/model pair.
   *
   * The previous version fabricated one (`contextWindow: 1000000`,
   * `maxTokens: 128000`, `reasoning: false`) and cast it through
   * `as unknown as Model`. That fake metadata starts to matter as soon as
   * anything real depends on it — context compaction, token budgets, thinking
   * levels, cost accounting — and nothing detected the lie.
   *
   * pi-ai ships a model registry, so known models get their real limits and
   * unknown ones are rejected explicitly instead of silently inheriting
   * invented capabilities. Custom endpoints are still supported by an override.
   */
  private buildModel(
    provider: TextProviderKey,
    modelId: string,
    baseUrl: string,
    reasoning?: ThinkingLevel,
    vision = false,
  ): Model<Api> {
    if (provider === "fake") {
      throw new Error("the fake provider does not build a real pi-ai model");
    }
    const known = getModels(provider as never).find((entry) => entry.id === modelId);
    if (provider === "openai") {
      const supportsReasoning = Boolean(reasoning) || Boolean(known?.reasoning);
      const compat = {
        supportsDeveloperRole: false,
        supportsReasoningEffort: supportsReasoning,
        maxTokensField: "max_tokens" as const,
        thinkingFormat: "openai" as const,
      };
      if (known) {
        return {
          ...known,
          api: "openai-completions",
          baseUrl,
          reasoning: supportsReasoning,
          compat,
        } as Model<Api>;
      }
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openai",
        baseUrl,
        reasoning: supportsReasoning,
        // A custom OpenAI-compatible id has no registry entry; when the caller
        // sends images, the operator configured it for a vision task, so the
        // image blocks must reach the provider instead of pi-ai's placeholder.
        input: vision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
        compat,
      } as Model<Api>;
    }
    if (!known) {
      const available = getModels(provider as never).map((entry) => entry.id).slice(0, 8);
      throw new Error(
        `unknown model ${modelId} for provider ${provider}; ` +
          `known ids include ${available.join(", ")}`,
      );
    }
    // The endpoint is configured per deployment, so it overrides the registry.
    return { ...known, baseUrl } as Model<Api>;
  }

  private async generateOnce(
    req: LlmRequest,
    opts: { withRunContext?: boolean } = {},
  ): Promise<LlmResponse> {
    const images = req.images ?? [];
    // A text model behind a chat-only gateway accepts image blocks and then
    // answers as if none were sent, so image calls go to the configured
    // vision endpoint when there is one.
    const vision = images.length > 0 ? this.resolveVisionProvider() : null;
    const resolved = vision ?? this.resolveProvider();
    // The vision call only reviews pixels against the prompt; the run context
    // would crowd the small context window a local vision model has.
    const prompt =
      opts.withRunContext === false || vision ? req.prompt : this.promptWithRunContext(req.prompt);
    // Fail fast on a cancelled or expired operation before spending a request.
    if (req.operation) assertOperationInFlight(req.operation);
    let model: Model<Api>;
    if (resolved.key === "fake") {
      model = fakeModel(req.system, prompt);
    } else {
      if (!resolved.baseUrl) {
        throw new Error(`provider ${resolved.key} needs a base URL in the run context snapshot`);
      }
      model = this.buildModel(
        resolved.key,
        resolved.model,
        resolved.key === "openai"
          ? openAiCompatibleBaseUrl(resolved.baseUrl, resolved.endpoint)
          : resolved.baseUrl,
        resolved.reasoning,
        images.length > 0,
      );
    }

    const content: string | (TextContent | ImageContent)[] = images.length
      ? [
          { type: "text", text: prompt },
          ...images.map((image): ImageContent => ({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : prompt;
    const context = {
      systemPrompt: req.system,
      messages: [{ role: "user" as const, content, timestamp: Date.now() }],
    };
    const op = req.operation;
    // One provider span per LLM call, nested under the stage span, carrying the
    // GenAI attributes a trace consumer expects.
    const message = await withProviderSpan(
      "gen_ai.text.complete",
      {
        ...(op ? operationSpanAttributes(op) : {}),
        "gen_ai.system": resolved.key,
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": resolved.model,
      },
      async (span) => {
        const events = stream(model, context, {
          apiKey: resolved.apiKey,
          maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          reasoning: resolved.reasoning,
          onPayload: resolved.model.toLowerCase().startsWith("deepseek")
            ? (payload) => ({
                ...(payload as Record<string, unknown>),
                response_format: { type: "json_object" },
              })
            : undefined,
          // pi-ai honours AbortSignal itself, so cancellation does not have to
          // wait for the response to come back before the run actually stops.
          signal: req.signal ?? op?.signal,
        });
        let thinking = "";
        let text = "";
        for await (const event of events) {
          if (event.type === "thinking_delta") thinking += event.delta;
          else if (event.type === "text_delta") text += event.delta;
          else continue;
          req.onStream?.({ thinking, text });
        }
        const result = await events.result();
        // Reported on the span that actually made the call, so token and cost
        // accounting lines up with the provider request in the trace.
        recordUsage(span, {
          model: resolved.model,
          usage: result.usage,
        });
        return result;
      },
    );
    if (message.stopReason === "error") {
      throw new AiOperationError(
        req.signal?.aborted ? "aborted" : "provider",
        req.operation?.operationId ?? "llm",
        `llm error: ${message.errorMessage ?? "unknown"}`,
        resolved.key,
      );
    }
    const text = Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => (block as { text: string }).text)
          .join("")
      : String(message.content ?? "");
    return { text, provider: resolved.key, model: resolved.model };
  }

  /**
   * Workflow LLM calls are structured-output calls. One bounded repair is
   * allowed for provider formatting mistakes; a second invalid response fails
   * the stage explicitly instead of flowing downstream as `{}`.
   *
   * The repair call keeps the caller's operation (activity, deadline, abort)
   * and output budget, is sent without the run context (the model must not
   * see, and echo back, anything but the broken output), and its result must
   * pass the same shape check as a first answer would.
   */
  async generate(req: LlmRequest): Promise<LlmResponse> {
    const first = await withAiActivity(req.operation, "文本生成", () => this.generateOnce(req));
    let firstError: unknown;
    try {
      checkStructuredOutput(parseJsonObjectText(first.text), req.validate);
      return first;
    } catch (error) {
      firstError = error;
    }
    // A cancelled run can hand back a cut-off answer; repairing it would spend
    // another call after the user pressed stop.
    if (req.signal?.aborted || req.operation?.signal?.aborted) {
      throw new AiOperationError("aborted", req.operation?.operationId ?? "llm", "run cancelled: llm request aborted");
    }
    const repair = await withAiActivity(req.operation, "修复结构化输出", () =>
      this.generateOnce(
        {
          system:
            "Repair the supplied model output into one valid JSON object. Preserve the original data and meaning, and keep the original top-level keys. Return only the repaired object itself, with no wrapper, markdown or explanation." +
            (firstError instanceof StructuredOutputError ? ` The object was rejected because: ${firstError.message}` : ""),
          prompt: first.text,
          maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal: req.signal,
          operation: req.operation,
        },
        { withRunContext: false },
      ),
    );
    try {
      const parsed = parseJsonObjectText(repair.text);
      checkStructuredOutput(parsed, req.validate);
      return { ...repair, text: JSON.stringify(parsed) };
    } catch (repairError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(
        `structured LLM output invalid after one repair (${firstMessage}; ${repairMessage})`,
      );
    }
  }
}

export class StructuredOutputError extends Error {}

/** Keys a model echoes back when it mistakes the request envelope for the answer. */
const ECHO_KEYS = ["invalid_output", "run_context"];

function checkStructuredOutput(
  data: Record<string, unknown>,
  validate: LlmRequest["validate"],
): void {
  const echoed = ECHO_KEYS.filter((key) => key in data);
  if (echoed.length) {
    throw new StructuredOutputError(`output echoes the request envelope (${echoed.join(", ")})`);
  }
  const problem = validate?.(data) ?? null;
  if (problem) throw new StructuredOutputError(problem);
}

/**
 * pi-ai's OpenAI client posts to `${baseUrl}/chat/completions`. Deployments
 * configure the full path as base + TEXT_ENDPOINT (same join as the Python
 * backend: base without trailing slash, endpoint with a leading one), so the
 * client base is everything before `/chat/completions`.
 */
export function openAiCompatibleBaseUrl(baseUrl: string, endpoint?: string | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  const raw = (endpoint ?? "").trim();
  if (!raw) return base;
  const path = (raw.startsWith("/") ? raw : `/${raw}`).replace(/\/+$/, "");
  const suffix = "/chat/completions";
  if (!path.endsWith(suffix)) {
    throw new Error(
      `TEXT_ENDPOINT must end with ${suffix} for an OpenAI-compatible text provider (got ${raw})`,
    );
  }
  return `${base}${path.slice(0, -suffix.length)}`;
}
