/**
 * Fake streamFn for local/no-network runs: emits the given text through the
 * pi-ai AssistantMessageEvent protocol so the Agent loop behaves identically
 * to a real provider call.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

let fakeCounter = 0;

export function fakeStreamFn(
  _model: unknown,
  context: { messages: Array<{ content: unknown }> },
  _options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const lastMessage = context.messages.at(-1);
  const raw = lastMessage?.content;
  const prompt =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((block) => (typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : ""))
            .join("\n")
        : "";
  const text = fakeRespond(prompt);

  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-compat",
    provider: "fake",
    model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;

  queueMicrotask(() => {
    stream.push({ type: "start", partial: message } as never);
    stream.push({ type: "text_start", contentIndex: 0, partial: message } as never);
    // chunk the text so downstream sees streaming behaviour
    for (let i = 0; i < text.length; i += 24) {
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: text.slice(i, i + 24),
        partial: message,
      } as never);
    }
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message } as never);
    stream.push({ type: "done", reason: "stop", message } as never);
    stream.end(message);
  });
  return stream;
}

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
  if (combined.includes("planagent") || combined.includes('"task"')) {
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

export function fakeCallCounter(): number {
  return ++fakeCounter;
}
