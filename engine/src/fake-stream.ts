/**
 * Fake LLM fixtures for local/no-network runs (TEXT_PROVIDER=fake).
 *
 * 关键：按 system/prompt 里出现的 agent 名回放结构化 JSON，让整条 15 阶段
 * 流水线在不联网的情况下跑通。
 */

export function fakeRespond(system: string, prompt: string): string {
  if (/^\s*You are a character visual design assistant\b/i.test(system)) {
    const description = /Description: ([^\n]*)/.exec(prompt)?.[1] ?? "";
    return JSON.stringify({ visual_notes: description || "清晰的发型、服装与标志性配饰" });
  }
  const agent = /^\s*You are (OutlineAgent|PlanAgent|CriticAgent)\b/i.exec(system)?.[1]?.toLowerCase();
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(prompt) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON repair requests use the generic fake response below.
  }
  if (agent === "outlineagent") {
    return JSON.stringify({
      agent: "outline",
      user_message: "主角在创作工作台验证生成链路，最终跑通本地流程。",
      story_outline: {
        logline: "主角在本地测试中验证生成链路。",
        genre: ["本地测试"],
        themes: ["可靠性"],
        setting: "创作工作台",
        tone: "轻快",
        acts: [
          { act: 1, title: "起", summary: "主角启动本地创作流程。" },
          { act: 2, title: "承转", summary: "主角逐步验证生成步骤。" },
          { act: 3, title: "合", summary: "完整流程成功跑通。" },
        ],
        emotional_arc: "平静 → 紧张 → 释然",
      },
      visual_bible: "Fake 视觉圣经：清爽漫画风、暖色工作台。",
      project_update: { title: null, summary: "主角在创作工作台验证生成链路。" },
    });
  }
  if (agent === "planagent") {
    if (input.task === "shots") {
      const project = input.project as Record<string, unknown> | undefined;
      const target = project?.target_shot_count;
      if (typeof target === "number" && target > 100) {
        throw new Error(`fake provider supports at most 100 shots; requested ${target}`);
      }
      const count = typeof target === "number" && target > 0 ? Math.max(1, Math.floor(target)) : 6;
      const shots = [
        { scene: "工作台", description: "小欧按下生成按钮，屏幕上亮起 Fake 三个字", emotion: "期待而专注", camera: "中景缓慢推近", lighting: "柔和蓝色屏幕光", dialogue: "开始本地测试。", duration: 4.5 },
        { scene: "分镜白板前", description: "调试精灵用发光光标圈出文本、图片、视频三个开关", emotion: "认真提醒", camera: "近景横移", lighting: "明亮顶光", dialogue: "Fake 模式已开启。", duration: 4.0 },
        { scene: "角色展示台", description: "小欧、调试精灵、时间线猫依次站上旋转台", emotion: "自信亮相", camera: "三连中景切换", lighting: "黄色轮廓光", dialogue: "角色齐了！", duration: 5.0 },
        { scene: "想象世界入口", description: "占位图片像卡片一样从门内飞出并贴到分镜板", emotion: "惊喜", camera: "全景拉开", lighting: "彩色轮廓光", dialogue: "首帧画面出来了。", duration: 4.5 },
        { scene: "视频时间线", description: "时间线猫把多个 Fake 视频片段拖入轨道并自动吸附", emotion: "机灵得意", camera: "俯拍推进", lighting: "蓝紫色工作灯", dialogue: "片段开始拼接。", duration: 5.0 },
        { scene: "预览屏幕前", description: "三位角色一起观看最终合成视频，屏幕角落显示本地占位", emotion: "满意微笑", camera: "特写定格", lighting: "温暖背光", dialogue: "完整流程跑通。", duration: 5.5 },
      ];
      return JSON.stringify({ shots: Array.from({ length: count }, (_, i) => shots[i % shots.length]) });
    }
    const project = input.project as Record<string, unknown> | undefined;
    const rawHints = project?.character_hints;
    const hints = Array.isArray(rawHints)
      ? rawHints.filter(
          (hint): hint is string => typeof hint === "string" && hint.trim().length > 0,
        )
      : [];
    // No visual_notes: like a terse real plan, so fake runs also exercise
    // (and stream) the character visual design call before each portrait.
    const defaults = [
      { name: "小欧", description: "好奇的开发者，蓝色卫衣。" },
      { name: "调试精灵", description: "发光的小精灵，爱提示。" },
      { name: "时间线猫", description: "踩着时间线的猫，慵懒可靠。" },
    ];
    const characters = hints.length
      ? hints.map((hint) => {
          const [name, ...description] = hint.split(/[：:]/);
          return {
            name: (description.length ? name ?? hint : hint).trim(),
            description: description.join("：").trim() || `${hint.trim()}，参与故事的角色。`,
          };
        })
      : defaults;
    return JSON.stringify({
      user_message: `Fake 角色规划已生成：${characters.length} 个角色。`,
      preserve_ids: { characters: [], shots: [] },
      characters,
    });
  }
  if (agent === "criticagent") {
    return JSON.stringify({
      score: 8.5,
      dimensions: { consistency: 8, quality: 9, composition: 9 },
      issues: [],
      suggestions: [],
    });
  }
  return JSON.stringify({ text: "Fake 文本响应。" });
}

/**
 * 假推理过程：让 fake 模式也有 thinking_delta，界面能按真实模型的样子流式显示。
 * 内容按 agent 区分，只是演示文案，不参与解析。
 */
export function fakeThinking(system: string): string {
  if (/^\s*You are a character visual design assistant\b/i.test(system)) {
    return "先看角色描述里最容易辨认的部分：发型、服装颜色和一件标志性配饰。把它们写成画面提示，保证换角度时仍然认得出来。";
  }
  const agent = /^\s*You are (OutlineAgent|PlanAgent|CriticAgent)\b/i.exec(system)?.[1]?.toLowerCase();
  if (agent === "outlineagent") {
    return "先读故事梗概，找出主角想要什么、挡在面前的是什么。三幕里第一幕交代处境，第二幕让阻碍升级，第三幕给出一个清楚的结果。语气保持轻快，视觉上用暖色工作台统一。";
  }
  if (agent === "planagent") {
    return "按大纲拆成角色和镜头。每个角色要有一眼能认出的外形；镜头之间注意景别变化，中景、近景、全景交替，节奏先慢后快，最后一个镜头留给情绪落点。";
  }
  if (agent === "criticagent") {
    return "对照角色设定检查一致性：脸型、发色、服装是否和设定相符；再看构图是否把主体放在视觉中心，最后检查画面质量有没有明显瑕疵。";
  }
  return "整理输入，生成结构化结果。";
}

/** 故事里写 `[fake:stream-error]` 时，fake 模型输出到一半中断，用来验证流式出错的界面。 */
export const FAKE_STREAM_ERROR_TOKEN = "[fake:stream-error]";
