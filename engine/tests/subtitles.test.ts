import { describe, expect, it } from "vitest";
import {
  buildSubtitleCues,
  estimatedSpeechSeconds,
  renderAss,
  renderSrt,
  splitSubtitleText,
  subtitleLayout,
  subtitleMode,
} from "../src/media/subtitles.js";

describe("subtitle lines from the script", () => {
  it("accepts only soft and burn, anything else is off", () => {
    expect(subtitleMode(" SOFT ")).toBe("soft");
    expect(subtitleMode("burn")).toBe("burn");
    expect(subtitleMode("yes")).toBe("off");
    expect(subtitleMode(undefined)).toBe("off");
  });

  it("estimates speech at about 0.24 s a character, at least 1.2 s", () => {
    expect(estimatedSpeechSeconds("好")).toBe(1.2);
    expect(estimatedSpeechSeconds("一二三四五六七八九十")).toBeCloseTo(2.4);
  });

  it("breaks at punctuation, packs short phrases and drops quotes and edge commas", () => {
    expect(splitSubtitleText("「你好，」乌鸦说。我们走吧！", 8)).toEqual(["你好，乌鸦说", "我们走吧！"]);
    expect(splitSubtitleText("   ")).toEqual([]);
  });

  it("hard-cuts a phrase longer than a line", () => {
    expect(splitSubtitleText("一二三四五六七八九十", 4)).toEqual(["一二三四", "五六七八", "九十"]);
  });

  it("shares a shot's window among its lines by length and skips tiny windows", () => {
    const cues = buildSubtitleCues(
      [
        { offset: 2, window: 3, text: "一二，三四五六。" },
        { offset: 5, window: 0.1, text: "太短" },
      ],
      4,
    );
    expect(cues).toEqual([
      { start: 2, end: 3, text: "一二" },
      { start: 3, end: 5, text: "三四五六" },
    ]);
  });

  it("renders SRT clocks with milliseconds", () => {
    expect(renderSrt([{ start: 61.5, end: 3723.004, text: "嗨" }])).toBe("1\n00:01:01,500 --> 01:02:03,004\n嗨\n");
  });

  it("sizes the font and safe area from the frame", () => {
    expect(subtitleLayout(1920, 1080)).toEqual({ fontSize: 59, marginV: 76, marginH: 134, maxChars: 16 });
    expect(subtitleLayout(320, 240)).toMatchObject({ fontSize: 18, maxChars: 15 });
  });

  it("writes an ASS script with a safe font name and escaped text", () => {
    const ass = renderAss([{ start: 0, end: 1.25, text: "a{b}\\c\nd" }], 1280, 720, "Evil,Font\n");
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("Style: Default,Evil Font,");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.25,Default,,0,0,0,,ab＼c\\Nd");
    expect(renderAss([], 640, 360, " , ")).toContain("Style: Default,Noto Sans CJK SC,");
  });
});
