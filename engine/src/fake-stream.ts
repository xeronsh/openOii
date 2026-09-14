/**
 * Fake LLM fixtures for local/no-network runs (TEXT_PROVIDER=fake).
 *
 * 关键：按 system/prompt 里出现的 agent 名回放结构化 JSON，让整条 17 阶段
 * 流水线在不联网的情况下跑通。
 */

export function fakeRespond(prompt: string): string {
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
    // 与 backend/app/services/fake_text.py 的默认角色/分镜数量保持一致
    return JSON.stringify({
      user_message: "Fake 完整规划已生成：3 个角色、6 个分镜。",
      preserve_ids: { characters: [], shots: [] },
      characters: [
        { name: "小欧", description: "好奇的开发者，蓝色卫衣。", visual_notes: "清爽线条" },
        { name: "调试精灵", description: "发光的小精灵，爱提示。", visual_notes: "荧光轮廓" },
        { name: "时间线猫", description: "踩着时间线的猫，慵懒可靠。", visual_notes: "圆滚滚轮廓" },
      ],
      shots: [
        { scene: "工作台", description: "小欧按下生成按钮，屏幕上亮起 Fake 三个字", emotion: "期待而专注", camera: "中景缓慢推近", lighting: "柔和蓝色屏幕光", dialogue: "开始本地测试。", duration: 4.5 },
        { scene: "分镜白板前", description: "调试精灵用发光光标圈出文本、图片、视频三个开关", emotion: "认真提醒", camera: "近景横移", lighting: "明亮顶光", dialogue: "Fake 模式已开启。", duration: 4.0 },
        { scene: "角色展示台", description: "小欧、调试精灵、时间线猫依次站上旋转台", emotion: "自信亮相", camera: "三连中景切换", lighting: "黄色轮廓光", dialogue: "角色齐了！", duration: 5.0 },
        { scene: "想象世界入口", description: "占位图片像卡片一样从门内飞出并贴到分镜板", emotion: "惊喜", camera: "全景拉开", lighting: "彩色轮廓光", dialogue: "首帧画面出来了。", duration: 4.5 },
        { scene: "视频时间线", description: "时间线猫把多个 Fake 视频片段拖入轨道并自动吸附", emotion: "机灵得意", camera: "俯拍推进", lighting: "蓝紫色工作灯", dialogue: "片段开始拼接。", duration: 5.0 },
        { scene: "预览屏幕前", description: "三位角色一起观看最终合成视频，屏幕角落显示本地占位", emotion: "满意微笑", camera: "特写定格", lighting: "温暖背光", dialogue: "完整流程跑通。", duration: 5.5 },
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
