import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { EngineDatabase } from "../src/db.js";
import { TextLlmService } from "../src/llm.js";
import { installEngineRuntimeSchema } from "./test-db.js";

const SCHEMA = readFileSync(resolve(import.meta.dirname, "fixtures/app-schema.sql"), "utf8");

/**
 * The model descriptor used to be fabricated (`contextWindow: 1000000`,
 * `as unknown as Model`). Fake metadata becomes real behaviour once anything
 * depends on it, so known models must come from the pi-ai registry and unknown
 * OpenAI-compatible custom ids use bounded fallback metadata; unknown
 * Anthropic ids still fail rather than inheriting invented limits.
 */
describe("provider model descriptors", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openoii-model-"));
    file = join(dir, "o.db");
    const raw = new SqliteDatabase(file);
    raw.exec(SCHEMA);
    installEngineRuntimeSchema(raw);
    raw.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function llmWith(provider: string, model: string, baseUrl = "https://example.test") {
    const edb = new EngineDatabase(file);
    const llm = new TextLlmService(edb, {
      provider,
      model,
      base_url: baseUrl,
      reasoning_effort: "high",
      credential_keys: [],
    } as never);
    return { edb, llm };
  }

  it("uses the registry limits for a known anthropic model", () => {
    const { edb, llm } = llmWith("anthropic", "claude-sonnet-4-5-20250929");
    const model = (llm as unknown as {
      buildModel(p: string, m: string, b: string): { contextWindow: number; maxTokens: number };
    }).buildModel("anthropic", "claude-sonnet-4-5-20250929", "https://example.test");

    expect(model.contextWindow).toBe(200000);
    expect(model.maxTokens).toBe(64000);
    edb.close();
  });

  it("rejects a model id that the registry does not know", () => {
    const { edb, llm } = llmWith("anthropic", "totally-made-up-model");
    expect(() =>
      (llm as unknown as { buildModel(p: string, m: string, b: string): unknown }).buildModel(
        "anthropic",
        "totally-made-up-model",
        "https://example.test",
      ),
    ).toThrow(/unknown model/);
    edb.close();
  });

  it("builds a bounded chat-completions descriptor for OpenAI-compatible custom models", () => {
    const { edb, llm } = llmWith("openai", "deepseek-v4.1-flash");
    const resolved = llm.resolveProvider();
    const model = (llm as unknown as {
      buildModel(p: string, m: string, b: string, reasoning?: string): {
        api: string;
        baseUrl: string;
        contextWindow: number;
        maxTokens: number;
        reasoning: boolean;
        compat: { maxTokensField?: string; supportsReasoningEffort?: boolean };
      };
    }).buildModel("openai", "deepseek-v4.1-flash", "http://127.0.0.1:7863/v1", resolved.reasoning);

    expect(model).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7863/v1",
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: true,
      compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true },
    });
    expect(resolved.reasoning).toBe("high");
    edb.close();
  });

  it("keeps the configured base url for custom endpoints", () => {
    const { edb, llm } = llmWith("anthropic", "claude-sonnet-4-5-20250929", "https://custom.test");
    const model = (llm as unknown as {
      buildModel(p: string, m: string, b: string): { baseUrl: string };
    }).buildModel("anthropic", "claude-sonnet-4-5-20250929", "https://custom.test");

    expect(model.baseUrl).toBe("https://custom.test");
    edb.close();
  });
});
