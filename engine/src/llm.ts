/**
 * Text LLM service built on pi-ai.
 *
 * Providers mirror backend/app/config.py semantics:
 * - fake            : schema-aware local fixtures (no network)
 * - anthropic       : Anthropic-compatible endpoint (中转站 via custom baseUrl)
 * - openai          : OpenAI-compatible endpoint (custom baseUrl)
 */
import { complete, getModel, getProviders } from "@mariozechner/pi-ai";
import type { EngineDatabase } from "./db.js";

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

    if (!getProviders().includes(resolved.key)) {
      throw new Error(`pi-ai does not know provider ${resolved.key}`);
    }
    const model = getModel(resolved.key, resolved.model as never);
    const context = {
      systemPrompt: req.system,
      messages: [{ role: "user" as const, content: req.prompt, timestamp: Date.now() }],
    };
    const message = await complete(model, context, {
      apiKey: resolved.apiKey,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
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

/** Minimal fake responder; full schema-aware parity lands with phase 5. */
function fakeRespond(prompt: string): string {
  const combined = prompt.toLowerCase();
  if (combined.includes("story_outline") || combined.includes("outlineagent")) {
    return JSON.stringify({
      logline: "Fake 大纲：主角在本地测试中验证生成链路。",
      genre: ["本地测试"],
      themes: ["可靠性"],
      setting: "创作工作台",
      tone: "轻快",
      acts: [],
      emotional_arc: "平静 → 紧张 → 释然",
      visual_bible: "Fake 视觉圣经：清爽漫画风、暖色工作台。",
    });
  }
  if (combined.includes("planagent") || combined.includes("task")) {
    return JSON.stringify({
      user_message: "Fake 完整规划已生成：2 个角色、3 个分镜。",
      preserve_ids: { characters: [], shots: [] },
      characters: [
        { name: "小欧", description: "好奇的开发者，蓝色卫衣。", visual_notes: "清爽线条" },
        { name: "调试精灵", description: "发光的小精灵，爱提示。", visual_notes: "荧光轮廓" },
      ],
      shots: [
        { scene: "工作台", description: "小欧按下生成按钮", emotion: "期待", shot_type: "中景", lighting: "屏幕光", dialogue: "开始！", duration: 4.5 },
        { scene: "白板", description: "调试精灵圈出三个开关", emotion: "认真", shot_type: "近景", lighting: "顶光", dialogue: "确认配置。", duration: 4.0 },
        { scene: "预览屏", description: "一起看成片", emotion: "满意", shot_type: "特写", lighting: "暖光", dialogue: "完成了。", duration: 5.0 },
      ],
    });
  }
  if (combined.includes("criticagent") || combined.includes("score")) {
    return JSON.stringify({
      total_score: 8.5,
      consistency: 9,
      quality: 9,
      composition: 8,
      issues: [],
      suggestions: [],
    });
  }
  return JSON.stringify({ text: "Fake 文本响应。" });
}
