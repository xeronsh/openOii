/** Text LLM service built on pi-ai with immutable per-run provider/context selection. */
import { complete, getModels, type Api, type Model } from "@mariozechner/pi-ai";
import type { EngineDatabase } from "./db.js";
import { fakeRespond } from "./fake-stream.js";
import { AiOperationError, assertOperationInFlight, type AiOperation } from "./ai-operation.js";

export type TextProviderKey = "fake" | "anthropic" | "openai";

export interface TextProviderSnapshot {
  provider?: string | null;
  base_url?: string | null;
  model?: string | null;
  endpoint?: string | null;
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

  resolveProvider(): { key: TextProviderKey; baseUrl?: string; apiKey?: string; model: string } {
    if (this.pinned?.provider) {
      const raw = this.pinned.provider;
      const key = (["fake", "anthropic", "openai"] as const).includes(raw as TextProviderKey)
        ? (raw as TextProviderKey)
        : null;
      if (key === null) throw new Error(`unsupported pinned text provider: ${raw}`);
      if (key === "fake") return { key, model: this.pinned.model || "fake" };
      return {
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
    };
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
  ): Model<Api> {
    if (provider === "fake") {
      throw new Error("the fake provider does not build a real pi-ai model");
    }
    const known = getModels(provider as never).find((entry) => entry.id === modelId);
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

  private async generateOnce(req: LlmRequest): Promise<LlmResponse> {
    const resolved = this.resolveProvider();
    const prompt = this.promptWithRunContext(req.prompt);
    // Fail fast on a cancelled or expired operation before spending a request.
    if (req.operation) assertOperationInFlight(req.operation);
    if (resolved.key === "fake") {
      return { text: fakeRespond(prompt), provider: "fake", model: resolved.model };
    }
    if (!resolved.baseUrl) {
      throw new Error(`provider ${resolved.key} needs a base URL in the run context snapshot`);
    }

    const model = this.buildModel(resolved.key, resolved.model, resolved.baseUrl);

    const context = {
      systemPrompt: req.system,
      messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
    };
    const message = await complete(model, context, {
      apiKey: resolved.apiKey,
      maxTokens: req.maxTokens ?? 4096,
      // pi-ai honours AbortSignal itself, so cancellation does not have to wait
      // for the response to come back before the run actually stops.
      signal: req.signal ?? req.operation?.signal,
    });
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
   */
  async generate(req: LlmRequest): Promise<LlmResponse> {
    const first = await this.generateOnce(req);
    try {
      parseJsonObjectText(first.text);
      return first;
    } catch (firstError) {
      const repair = await this.generateOnce({
        system:
          "Repair the supplied model output into one valid JSON object. Preserve the original data and meaning. Return JSON only, with no markdown or explanation.",
        prompt: JSON.stringify({ invalid_output: first.text }),
        maxTokens: req.maxTokens ?? 4096,
        signal: req.signal,
      });
      try {
        const parsed = parseJsonObjectText(repair.text);
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
}
