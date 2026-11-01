/**
 * runComposeMerge: per-shot voice tracks, one music bed under the film and
 * script subtitles timed to the voice. Media and the audio worker are faked;
 * the ffmpeg side is covered in media-compose.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComposeMerge } from "../src/agents/index.js";
import { BackendWorker } from "../src/backend-worker.js";
import type { StageContext } from "../src/agents/index.js";

type Shot = Record<string, unknown> & { id: number };

afterEach(() => vi.restoreAllMocks());

function compose(options: {
  shots: Shot[];
  settings?: Record<string, unknown>;
  project?: Record<string, unknown>;
  media?: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const shots = options.shots.map((shot) => ({ revision: 1, character_ids: "[]", tts_url: null, bgm_type: null, dialogue: null, scene: null, expression: null, duration: 5, ...shot }));
  const project = { id: 1, style: "anime", video_url: null as string | null, status: "ready", ...options.project };
  const messages: string[] = [];
  const shotUpdates: Array<{ id: number; fields: Record<string, unknown> }> = [];
  const projectUpdates: Array<Record<string, unknown>> = [];
  const calls = { merge: [] as string[][], bgm: [] as unknown[][], subtitles: [] as unknown[][] };
  const media = {
    audioEnabled: true,
    mediaDuration: async (url: string | null) => (url?.includes("tts") ? 1.5 : url ? 4 : null),
    mergeVideos: async (urls: string[]) => {
      calls.merge.push(urls);
      return "/static/videos/merged.mp4";
    },
    addBackgroundMusic: async (...args: unknown[]) => {
      calls.bgm.push(args);
      return "/static/videos/with-bgm.mp4";
    },
    addSubtitles: async (...args: unknown[]) => {
      calls.subtitles.push(args);
      return { videoUrl: "/static/videos/subbed.mp4", srtUrl: "/static/subs.srt", cues: 2 };
    },
    ...options.media,
  };
  const ctx = {
    projectId: 1,
    runId: 9,
    signal: options.signal ?? new AbortController().signal,
    mediaSettings: { ttsEnabled: false, bgmEnabled: false, subtitleMode: "off", bgmVolume: 0.3, bgmDirectory: "/bgm", ttsVolume: 1, ...options.settings },
    media,
    shared: {
      shotsForProject: () => shots,
      getLiveShot: (id: number) => shots.find((shot) => shot.id === id),
      getProject: () => project,
      charactersForProject: () => [{ id: 5, name: "乌鸦", description: "黑色乌鸦", voice: " zh-CN-Yunxi " }],
      createVersion: () => 1,
      updateShot: (id: number, fields: Record<string, unknown>) => {
        shotUpdates.push({ id, fields });
        Object.assign(shots.find((shot) => shot.id === id)!, fields);
      },
      updateProject: (_id: number, fields: Record<string, unknown>) => {
        projectUpdates.push(fields);
        Object.assign(project, fields);
      },
    },
    emitter: {
      sendMessage: async (_agent: string, text: string) => void messages.push(text),
      commit: (_type: string, write: () => unknown) => write(),
      versionCreated: () => undefined,
      projectUpdated: () => undefined,
    },
  } as unknown as StageContext;
  return { ctx, messages, shotUpdates, projectUpdates, calls, project };
}

function fakeWorker(overrides: { processAudio?: unknown; bgmTrack?: unknown } = {}) {
  const close = vi.spyOn(BackendWorker.prototype, "close").mockResolvedValue(undefined);
  const processAudio = vi
    .spyOn(BackendWorker.prototype, "processAudio")
    .mockImplementation((overrides.processAudio as never) ?? (async (args: { video_url: string }) => ({
      video_url: args.video_url.replace(".mp4", "-voiced.mp4"),
      tts_url: args.video_url.replace(".mp4", "-tts.mp3"),
      bgm_type: null,
      tts_error: null,
    })) as never);
  const bgmTrack = vi
    .spyOn(BackendWorker.prototype, "bgmTrack")
    .mockImplementation((overrides.bgmTrack as never) ?? (async () => ({ track_url: "/static/bgm/calm.mp3", source: "library", mood: "calm", fallback_reason: null })) as never);
  return { close, processAudio, bgmTrack };
}

describe("runComposeMerge", () => {
  it("says so and stops when no shot has a clip", async () => {
    const worker = fakeWorker();
    const { ctx, messages, calls } = compose({ shots: [{ id: 1, order: 1, video_url: null }] });
    await runComposeMerge(ctx);
    expect(messages).toEqual(["没有可拼接的分镜视频。"]);
    expect(calls.merge).toEqual([]);
    expect(worker.processAudio).not.toHaveBeenCalled();
  });

  it("joins the clips in order and publishes the film", async () => {
    fakeWorker();
    const { ctx, calls, projectUpdates } = compose({
      shots: [
        { id: 1, order: 1, video_url: "/static/videos/s1.mp4" },
        { id: 2, order: 2, video_url: null },
        { id: 3, order: 3, video_url: "/static/videos/s3.mp4" },
      ],
    });
    await runComposeMerge(ctx);
    expect(calls.merge).toEqual([["/static/videos/s1.mp4", "/static/videos/s3.mp4"]]);
    expect(projectUpdates.at(-1)).toEqual({ video_url: "/static/videos/merged.mp4", status: "ready" });
  });

  it("voices each line with the speaker's own voice and marks an existing cut superseded", async () => {
    const worker = fakeWorker();
    const { ctx, shotUpdates, projectUpdates, calls } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "乌鸦：水太少了", character_ids: "[5]" }],
      settings: { ttsEnabled: true },
      project: { video_url: "/static/videos/old.mp4" },
    });
    await runComposeMerge(ctx);
    const args = worker.processAudio.mock.calls[0]![0];
    expect(args).toMatchObject({ dialogue: "水太少了", voice: "zh-CN-Yunxi", speaker: { name: "乌鸦" } });
    expect(shotUpdates[0]).toEqual({
      id: 1,
      fields: { video_url: "/static/videos/s1-voiced.mp4", tts_url: "/static/videos/s1-tts.mp3", bgm_type: null },
    });
    expect(projectUpdates[0]).toEqual({ status: "superseded" });
    expect(calls.merge).toEqual([["/static/videos/s1-voiced.mp4"]]);
    expect(worker.close).toHaveBeenCalled();
  });

  it("keeps the original sound when voicing fails, and says why", async () => {
    fakeWorker({
      processAudio: async () => {
        throw new Error("edge-tts unreachable");
      },
    });
    const { ctx, messages, calls, shotUpdates } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "你好" }],
      settings: { ttsEnabled: true },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runComposeMerge(ctx);
    expect(messages.some((text) => text.includes("S01 的配音和音效处理失败（edge-tts unreachable）"))).toBe(true);
    expect(shotUpdates).toEqual([]);
    expect(calls.merge).toEqual([["/static/videos/s1.mp4"]]);
  });

  it("reports a voice that the provider refused", async () => {
    fakeWorker({
      processAudio: async (args: { video_url: string }) => ({ video_url: args.video_url, tts_url: null, bgm_type: null, tts_error: "quota" }),
    });
    const { ctx, messages, shotUpdates } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "你好" }],
      settings: { ttsEnabled: true },
    });
    await runComposeMerge(ctx);
    expect(messages).toContain("⚠️ S01 配音失败（quota），这句台词先不配音。");
    expect(shotUpdates).toEqual([]);
  });

  it("stops when the run is cancelled during voicing", async () => {
    const controller = new AbortController();
    fakeWorker({
      processAudio: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    const { ctx, calls } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "你好" }],
      settings: { ttsEnabled: true },
      signal: controller.signal,
    });
    await expect(runComposeMerge(ctx)).rejects.toThrow("aborted");
    expect(calls.merge).toEqual([]);
  });

  it("lays music under the film, ducked at the voice lines, then subtitles timed to the voice", async () => {
    fakeWorker();
    const { ctx, calls, messages, project } = compose({
      shots: [
        { id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "水太少了" },
        { id: 2, order: 2, video_url: "/static/videos/s2.mp4", dialogue: "丢石子吧" },
      ],
      settings: { ttsEnabled: true, bgmEnabled: true, subtitleMode: "soft", subtitleFont: "Noto Sans CJK SC" },
    });
    await runComposeMerge(ctx);
    expect(calls.bgm).toEqual([
      [
        "/static/videos/merged.mp4",
        "/static/bgm/calm.mp3",
        [
          { url: "/static/videos/s1-tts.mp3", offset: 0 },
          { url: "/static/videos/s2-tts.mp3", offset: 4 },
        ],
        0.3,
        true,
      ],
    ]);
    expect(calls.subtitles).toEqual([
      [
        "/static/videos/with-bgm.mp4",
        [
          { offset: 0, window: 1.5, text: "水太少了" },
          { offset: 4, window: 1.5, text: "丢石子吧" },
        ],
        "soft",
        "Noto Sans CJK SC",
      ],
    ]);
    expect(messages).toContain("已铺上背景音乐（本地曲库，calm），台词处自动压低。");
    expect(messages).toContain("已加上 2 条软字幕（按剧本台词生成）。字幕文件：/static/subs.srt");
    expect(project.video_url).toBe("/static/videos/subbed.mp4");
  });

  it("estimates subtitle timing from the text when there is no voice", async () => {
    fakeWorker();
    const { ctx, calls } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "一二三四五六七八九十" }],
      settings: { subtitleMode: "burn" },
    });
    await runComposeMerge(ctx);
    const [, segments, mode, font] = calls.subtitles[0]!;
    expect(segments).toEqual([{ offset: 0, window: 2.4, text: "一二三四五六七八九十" }]);
    expect(mode).toBe("burn");
    expect(font).toBe("Smiley Sans");
  });

  it("says when the music service fell back to the library", async () => {
    fakeWorker({
      bgmTrack: async () => ({ track_url: "/static/bgm/lib.mp3", source: "library", mood: null, fallback_reason: "suno 503" }),
    });
    const { ctx, messages } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4" }],
      settings: { bgmEnabled: true, bgmDucking: false },
    });
    await runComposeMerge(ctx);
    expect(messages).toContain("⚠️ 背景音乐服务没生成出来（suno 503），先用本地曲库。");
    expect(messages).toContain("已铺上背景音乐（本地曲库，ambient）。");
  });

  it("ships the film without music or subtitles when those fail", async () => {
    fakeWorker({ bgmTrack: async () => ({ track_url: null, source: null, mood: null, fallback_reason: null }) });
    const { ctx, messages, project } = compose({
      shots: [{ id: 1, order: 1, video_url: "/static/videos/s1.mp4", dialogue: "你好" }],
      settings: { bgmEnabled: true, subtitleMode: "soft" },
      media: {
        addSubtitles: async () => {
          throw new Error("字幕：读不到画面尺寸");
        },
      },
    });
    await runComposeMerge(ctx);
    expect(messages).toContain("⚠️ 背景音乐没加上（没有可用的曲子），成片先不带配乐。");
    expect(messages).toContain("⚠️ 字幕没加上（字幕：读不到画面尺寸），成片先不带字幕。");
    expect(project.video_url).toBe("/static/videos/merged.mp4");
  });
});
