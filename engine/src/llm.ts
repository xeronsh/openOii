/**
 * Text LLM service built on pi-ai.
 *
 * Providers mirror backend/app/config.py semantics:
 * - fake            : schema-aware local fixtures (no network)
 * - anthropic       : Anthropic-compatible endpoint (中转站 via custom baseUrl)
 * - openai          : OpenAI-compatible endpoint (custom baseUrl)
 */
import { complete, type Model } from "@mariozechner/pi-ai";
import type { EngineDatabase } from "./db.js";
import { fakeRespond } from "./fake-stream.js";

export type TextProviderKey = "fake" | "anthropic" | "openai";

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  provider: string;
  model: string;
}

export class TextLlmService {
  constructor(
    private readonly db: EngineDatabase,
  ) {}

  resolveProvider(): { key: TextProviderKey; baseUrl?: string; apiKey?: string; model: string } {
    const raw =
      this.db.configValue("TEXT_PROVIDER", "TEXT_PROVIDER", "anthropic") ?? "anthropic";
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
        model: this.db.configValue("ANTHROPIC_MODEL", "ANTHROPIC_MODEL", "claude-sonnet-4-5"),
      };
    }
    return {
      key,
      baseUrl: this.db.configValue("TEXT_BASE_URL", "TEXT_BASE_URL"),
      apiKey: this.db.configValue("TEXT_API_KEY", "TEXT_API_KEY") ?? "",
      model: this.db.configValue("TEXT_MODEL", "TEXT_MODEL", "deepseek-chat"),
    };
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const resolved = this.resolveProvider();
    if (resolved.key === "fake") {
      return { text: fakeRespond(req.prompt), provider: "fake", model: "fake" };
    }
    if (!resolved.baseUrl) {
      throw new Error(`provider ${resolved.key} needs a base URL (TEXT_BASE_URL / ANTHROPIC_BASE_URL)`);
    }

    // Hand-built Model for OpenAI/Anthropic-COMPATIBLE relays (中转站): the
    // configured base URL + arbitrary model id, bypassing the curated catalog.
    const model = {
      id: resolved.model,
      name: resolved.model,
      api: resolved.key === "anthropic" ? "anthropic-messages" : "openai-completions",
      provider: resolved.key,
      baseUrl: resolved.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 128000,
    } as unknown as Model<never>;

    const context = {
      systemPrompt: req.system,
      messages: [{ role: "user" as const, content: req.prompt, timestamp: Date.now() }],
    };
    const message = await complete(model, context, {
      apiKey: resolved.apiKey,
      maxTokens: req.maxTokens ?? 4096,
    });
    if (message.stopReason === "error") {
      throw new Error(`llm error: ${message.errorMessage ?? "unknown"}`);
    }
    const text = Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text")
          .map((block) => (block as { text: string }).text)
          .join("")
      : String(message.content ?? "");
    return { text, provider: resolved.key, model: resolved.model };
  }
}
