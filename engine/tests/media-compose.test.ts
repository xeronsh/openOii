/**
 * Final-film composition in MediaService against real ffmpeg on tiny clips:
 * merging shot clips, probing durations, soft and burned subtitles, the
 * background music bed with ducking, image boards and clip frame strips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaService, type MediaSettings } from "../src/media/media.js";

let dir: string;
let registered: string[];

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

function probe(path: string): { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } } {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path], {
      encoding: "utf8",
    }),
  );
}

function pathOf(url: string): string {
  return join(dir, url.slice("/static/".length));
}

function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function service(signal?: AbortSignal): MediaService {
  const media = new MediaService({
    staticDir: dir,
    imageProvider: "fake",
    videoProvider: "fake",
    publicBaseUrl: null,
  } as MediaSettings);
  media.setMediaRegistrar((relativePath) => registered.push(relativePath));
  if (signal) media.setAbortSignal(signal);
  return media;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openoii-compose-"));
  const fx = join(dir, "fx");
  mkdirSync(fx);
  const clip = (name: string, color: string) =>
    ffmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=320x240:d=1:r=10`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(fx, name),
    ]);
  clip("a.mp4", "red");
  clip("b.mp4", "blue");
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=320x240:d=1:r=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(fx, "silent.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=0.7", "-c:a", "aac", join(fx, "track.m4a")]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=660:duration=0.4", "-c:a", "aac", join(fx, "voice.m4a")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=200x100", "-frames:v", "1", join(fx, "wide.png")]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=100x100", "-frames:v", "1", join(fx, "square.png")]);
  writeFileSync(join(fx, "notes.txt"), "not media");
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("mergeVideos", () => {
  it("joins shot clips in order into one managed film", async () => {
    registered = [];
    const url = await service().mergeVideos(["/static/fx/a.mp4", "/static/fx/b.mp4"]);
    expect(url).toMatch(/^\/static\/managed-v1\/.+\.mp4$/);
    expect(registered).toEqual([url.slice("/static/".length)]);
    expect(Number(probe(pathOf(url)).format.duration)).toBeCloseTo(2, 0);
  }, 30_000);

  it("publishes a single clip as is", async () => {
    registered = [];
    const url = await service().mergeVideos(["/static/fx/a.mp4"]);
    expect(readFileSync(pathOf(url)).equals(readFileSync(join(dir, "fx/a.mp4")))).toBe(true);
  });

  it("refuses an empty list and a missing local clip", async () => {
    registered = [];
    await expect(service().mergeVideos([])).rejects.toThrow("No video URLs provided");
    await expect(service().mergeVideos(["/static/fx/gone.mp4"])).rejects.toThrow("Local video file is missing");
    expect(registered).toEqual([]);
  });

  it("publishes nothing once the run is cancelled", async () => {
    registered = [];
    const controller = new AbortController();
    controller.abort();
    await expect(service(controller.signal).mergeVideos(["/static/fx/a.mp4"])).rejects.toThrow("run cancelled");
    expect(registered).toEqual([]);
  });

  it("refuses a path that escapes static storage", async () => {
    await expect(service().mergeVideos(["/static/../etc/passwd"])).rejects.toThrow("Invalid local video path");
  });
});

describe("mediaDuration", () => {
  it("reads the length of a local clip", async () => {
    expect(await service().mediaDuration("/static/fx/a.mp4")).toBeCloseTo(1, 0);
  });

  it("is null when there is nothing local to probe", async () => {
    const media = service();
    expect(await media.mediaDuration(null)).toBeNull();
    expect(await media.mediaDuration("https://cdn.example.com/a.mp4")).toBeNull();
    expect(await media.mediaDuration("/static/fx/gone.mp4")).toBeNull();
    expect(await media.mediaDuration("/static/fx/notes.txt")).toBeNull();
  });
});

describe("addSubtitles", () => {
  const segments = [
    { offset: 0, window: 1, text: "乌鸦看见水瓶。" },
    { offset: 1, window: 1, text: "它一颗一颗丢进石子！" },
  ];

  it("adds a switchable subtitle track and publishes the srt", async () => {
    registered = [];
    const result = await service().addSubtitles("/static/fx/a.mp4", segments, "soft", "Noto Sans CJK SC");
    expect(result?.cues).toBe(2);
    const kinds = probe(pathOf(result!.videoUrl)).streams.map((stream) => stream.codec_type);
    expect(kinds).toEqual(expect.arrayContaining(["video", "audio", "subtitle"]));
    const srt = readFileSync(pathOf(result!.srtUrl), "utf8");
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000\n乌鸦看见水瓶");
    expect(registered).toHaveLength(2);
  }, 30_000);

  it("burns subtitles into the picture without a subtitle track", async () => {
    const result = await service().addSubtitles("/static/fx/silent.mp4", segments, "burn", "Noto Sans CJK SC");
    const streams = probe(pathOf(result!.videoUrl)).streams;
    expect(streams.map((stream) => stream.codec_type)).toEqual(["video"]);
    expect(streams[0]).toMatchObject({ width: 320, height: 240 });
  }, 30_000);

  it("does nothing when off or when there are no lines", async () => {
    const media = service();
    expect(await media.addSubtitles("/static/fx/a.mp4", segments, "off", "")).toBeNull();
    expect(await media.addSubtitles("/static/fx/a.mp4", [{ offset: 0, window: 1, text: "  " }], "soft", "")).toBeNull();
  });

  it("names the missing film", async () => {
    await expect(service().addSubtitles("https://cdn.example.com/a.mp4", segments, "soft", "")).rejects.toThrow(
      "字幕：找不到本地成片文件",
    );
  });
});

describe("addBackgroundMusic", () => {
  it("ducks the bed under voice lines and keeps the film length", async () => {
    const url = await service().addBackgroundMusic(
      "/static/fx/a.mp4",
      "/static/fx/track.m4a",
      [{ url: "/static/fx/voice.m4a", offset: 0.3 }, { url: "/static/fx/missing.m4a", offset: 0 }],
      0.4,
      true,
    );
    const info = probe(pathOf(url));
    expect(info.streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
    expect(Number(info.format.duration)).toBeCloseTo(1, 0);
  }, 30_000);

  it("ducks under the film's own audio when there are no voice tracks", async () => {
    const url = await service().addBackgroundMusic("/static/fx/b.mp4", "/static/fx/track.m4a", [], 2, true);
    expect(probe(pathOf(url)).streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
  }, 30_000);

  it("gives a silent film a music track", async () => {
    const url = await service().addBackgroundMusic("/static/fx/silent.mp4", "/static/fx/track.m4a", [], 0.5, false);
    expect(probe(pathOf(url)).streams.map((stream) => stream.codec_type)).toEqual(["video", "audio"]);
  }, 30_000);

  it("names what is missing", async () => {
    const media = service();
    await expect(media.addBackgroundMusic("/static/fx/none.mp4", "/static/fx/track.m4a", [], 1, false)).rejects.toThrow(
      "背景音乐：找不到本地成片文件",
    );
    await expect(media.addBackgroundMusic("/static/fx/a.mp4", "https://x.example/t.mp3", [], 1, false)).rejects.toThrow(
      "背景音乐：找不到曲目文件",
    );
  });
});

describe("image boards", () => {
  it("returns a single image untouched", async () => {
    const png = readFileSync(join(dir, "fx/wide.png"));
    expect(await service().stackImages([png])).toBe(png);
  });

  it("lays images side by side at one height", async () => {
    const board = await service().stackImages([readFileSync(join(dir, "fx/wide.png")), readFileSync(join(dir, "fx/square.png"))]);
    expect(pngSize(board)).toEqual({ width: 1536 + 768, height: 768 });
    expect(existsSync(join(dir, ".stack-"))).toBe(false);
  }, 30_000);

  it("strips first, middle and last frame of a clip into one image", async () => {
    const strip = await service().videoFrameStrip("/static/fx/a.mp4");
    expect(pngSize(strip!)).toEqual({ width: 1536, height: 384 });
  }, 30_000);

  it("has no strip for a remote clip", async () => {
    expect(await service().videoFrameStrip("https://cdn.example.com/a.mp4")).toBeNull();
  });
});
