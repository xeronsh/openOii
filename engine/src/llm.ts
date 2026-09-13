/** Text LLM service built on pi-ai with immutable per-run provider selection. */
import { complete, type Model } from "@mariozechner/pi-ai";
import type { EngineDatabase } from "./db.js";
import { fakeRespond } from "./fake-stream.js";

export type TextProviderKey = "fake" | "anthropic" | "openai";

export interface TextProviderSnapshot {
  provider?: string | null;
  base_url?: string | null;
  model?: string | null;
  endpoint?: string | null;
  credential_keys?: string[] | null;
}

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
    private readonly pinned?: TextProviderSnapshot,
  ) {}

  forSnapshot(snapshot: TextProviderSnapshot | null | undefined): TextLlmService {
    return new TextLlmService(this.db, snapshot ?? undefined);
  }

  private secret(keys: string[]): string {
    for (const key of keys) {
      const value = this.db.configValue(key, key);
      if (value) return value;
    }
    return "";
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

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const resolved = this.resolveProvider();
    if (resolved.key === "fake") {
      return { text: fakeRespond(req.prompt), provider: "fake", model: resolved.model };
    }
    if (!resolved.baseUrl) {
      throw new Error(`provider ${resolved.key} needs a base URL in the run context snapshot`);
    }

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
