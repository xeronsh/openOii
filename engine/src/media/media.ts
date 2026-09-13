/**
 * Media services: image / video / TTS.
 *
 * Fake providers mirror backend/app/services/fake_image.py and fake_video.py
 * (local SVG placeholders and ffmpeg color clips under backend/app/static).
 * Real providers use the same HTTP contracts as the Python service layer
 * (modelscope / OpenAI-compatible images & videos / doubao Ark).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EngineDatabase } from "../db.js";

const execFileAsync = promisify(execFile);

export interface MediaSettings {
  imageProvider: "fake" | "modelscope" | "openai";
  imageBaseUrl: string;
  imageApiKey: string | null;
  imageModel: string;
  imageEndpoint: string;
  enableImageToImage: boolean;
  fakeImageFixtureUrl: string | null;

  videoProvider: "fake" | "openai" | "doubao";
  videoBaseUrl: string;
  videoApiKey: string | null;
  videoModel: string;
  videoEndpoint: string;
  enableImageToVideo: boolean;
  videoMode: string; // "text" | "image"
  fakeVideoFixtureUrl: string | null;
  fakeVideoFixturePath: string | null;
  doubaoApiKey: string | null;
  doubaoVideoModel: string;
  doubaoVideoDuration: number;
  doubaoVideoRatio: string;

  ttsEnabled: boolean;
  bgmEnabled: boolean;

  staticDir: string;
}

export function resolveMediaSettings(db: EngineDatabase): MediaSettings {
  const staticDir =
    process.env.ENGINE_STATIC_DIR ??
    resolve(process.cwd(), "../backend/app/static");
  const pick = (key: string, env: string, fallback: string): string =>
    db.configValue(key, env, fallback) ?? fallback;
  const optional = (key: string, env: string): string | null => {
    const v = db.configValue(key, env);
    return v ? v : null;
  };
  const imageProvider = pick("IMAGE_PROVIDER", "IMAGE_PROVIDER", "fake");
  const videoProvider = pick("VIDEO_PROVIDER", "VIDEO_PROVIDER", "fake");
  return {
    imageProvider: imageProvider === "modelscope" || imageProvider === "openai" ? imageProvider : "fake",
    imageBaseUrl: pick("IMAGE_BASE_URL", "IMAGE_BASE_URL", "https://api-inference.modelscope.cn"),
    imageApiKey: optional("IMAGE_API_KEY", "IMAGE_API_KEY"),
    imageModel: pick("IMAGE_MODEL", "IMAGE_MODEL", "Tongyi-MAI/Z-Image-Turbo"),
    imageEndpoint: pick("IMAGE_ENDPOINT", "IMAGE_ENDPOINT", "/v1/images/generations"),
    enableImageToImage: pick("ENABLE_IMAGE_TO_IMAGE", "ENABLE_IMAGE_TO_IMAGE", "true") === "true",
    fakeImageFixtureUrl: optional("FAKE_IMAGE_FIXTURE_URL", "FAKE_IMAGE_FIXTURE_URL"),

    videoProvider: videoProvider === "openai" || videoProvider === "doubao" ? videoProvider : "fake",
    videoBaseUrl: pick("VIDEO_BASE_URL", "VIDEO_BASE_URL", "https://api.example.com/v1"),
    videoApiKey: optional("VIDEO_API_KEY", "VIDEO_API_KEY"),
    videoModel: pick("VIDEO_MODEL", "VIDEO_MODEL", "video-gen-1"),
    videoEndpoint: pick("VIDEO_ENDPOINT", "VIDEO_ENDPOINT", "/videos/generations"),
    enableImageToVideo: pick("ENABLE_IMAGE_TO_VIDEO", "ENABLE_IMAGE_TO_VIDEO", "false") === "true",
    videoMode: pick("VIDEO_MODE", "VIDEO_MODE", "text"),
    fakeVideoFixtureUrl: optional("FAKE_VIDEO_FIXTURE_URL", "FAKE_VIDEO_FIXTURE_URL"),
    fakeVideoFixturePath: optional("FAKE_VIDEO_FIXTURE_PATH", "FAKE_VIDEO_FIXTURE_PATH"),
    doubaoApiKey: optional("DOUBAO_API_KEY", "DOUBAO_API_KEY"),
    doubaoVideoModel: pick("DOUBAO_VIDEO_MODEL", "DOUBAO_VIDEO_MODEL", "doubao-seedance-1-5-pro-251215"),
    doubaoVideoDuration: Number(pick("DOUBAO_VIDEO_DURATION", "DOUBAO_VIDEO_DURATION", "5")),
    doubaoVideoRatio: pick("DOUBAO_VIDEO_RATIO", "DOUBAO_VIDEO_RATIO", "adaptive"),

    ttsEnabled: pick("TTS_ENABLED", "TTS_ENABLED", "true") === "true",
    bgmEnabled: pick("BGM_ENABLED", "BGM_ENABLED", "true") === "true",

    staticDir,
  };
}

// ---------------------------------------------------------------------------
// fake image (fake_image.py port)
// ---------------------------------------------------------------------------

function safeSlug(prompt: string, fallback: string): string {
  const cleaned = prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function placeholderSvg(prompt: string): string {
  const label = prompt.slice(0, 60).replace(/[<>&]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#1e1b4b"/><text x="50%" y="45%" fill="#fbbf24" font-size="36" text-anchor="middle" font-family="sans-serif">Fake Image</text><text x="50%" y="58%" fill="#ffffff" font-size="20" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
}

// ---------------------------------------------------------------------------
// fake video (fake_video.py port)
// ---------------------------------------------------------------------------

const FAKE_VIDEO_COLORS = ["0x111827", "0x1e1b4b", "0x422006", "0x052e16", "0x3b0764", "0x0f172a"];

function videoSlug(prompt: string, prefix = "fake_video_v2"): string {
  const digest = createHash("sha1").update(prompt).digest("hex").slice(0, 10);
  return `${prefix}_${digest}.mp4`;
}

function promptLabel(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const ascii = compact.replace(/[^\x20-\x7E]/g, "").trim();
  if (ascii.length >= 3) return ascii.slice(0, 36);
  const digest = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return `local prompt ${digest}`;
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

export class MediaService {
  constructor(private readonly settings: MediaSettings) {}

  get staticDir(): string {
    return this.settings.staticDir;
  }

  async generateImageUrl(args: {
    prompt: string;
    size?: string;
    imageBytes?: Buffer | null;
  }): Promise<string> {
    const { prompt } = args;
    if (this.settings.fakeImageFixtureUrl) return this.settings.fakeImageFixtureUrl;

    if (this.settings.imageProvider === "fake") {
      const dir = join(this.settings.staticDir, "images");
      mkdirSync(dir, { recursive: true });
      const filename = `${safeSlug(prompt, "fake_image")}.svg`;
      const path = join(dir, filename);
      const svg = placeholderSvg(prompt);
      if (!existsSync(path) || readFileSync(path, "utf8") !== svg) {
        writeFileSync(path, svg, "utf8");
      }
      return `/static/images/${filename}`;
    }

    // real providers: OpenAI-compatible / modelscope JSON POST
    const url = `${this.settings.imageBaseUrl}${this.settings.imageEndpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "openoii-engine",
        ...(this.settings.imageApiKey
          ? { Authorization: `Bearer ${this.settings.imageApiKey}` }
          : {}),
      },
      body: JSON.stringify({ model: this.settings.imageModel, prompt, size: args.size ?? "1024x1024" }),
    });
    if (!res.ok) {
      throw new Error(`image provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { data?: Array<{ url?: string }> };
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) throw new Error("image provider returned no url");
    return imageUrl;
  }

  async generateVideoUrl(args: { prompt: string; imageUrl?: string | null }): Promise<string> {
    const { prompt } = args;
    if (this.settings.fakeVideoFixtureUrl) return this.settings.fakeVideoFixtureUrl;

    if (this.settings.videoProvider === "fake") {
      if (this.settings.fakeVideoFixturePath) {
        const source = resolve(this.settings.fakeVideoFixturePath);
        if (!existsSync(source)) throw new Error(`Fake video fixture file not found: ${source}`);
        const dir = join(this.settings.staticDir, "videos");
        mkdirSync(dir, { recursive: true });
        const filename = `fake_clip_${createHash("sha1").update(prompt + Date.now()).digest("hex").slice(0, 8)}.mp4`;
        const dest = join(dir, filename);
        const { copyFileSync } = await import("node:fs");
        copyFileSync(source, dest);
        return `/static/videos/${filename}`;
      }
      return this.ensureDefaultFakeClip(prompt);
    }

    if (this.settings.videoProvider === "doubao" && this.settings.doubaoApiKey) {
      // doubao Ark: text/image → video (simplified single-shot contract)
      const content: Array<Record<string, unknown>> =
        this.settings.enableImageToVideo && args.imageUrl
          ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: args.imageUrl } }]
          : [{ type: "text", text: prompt }];
      const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.doubaoApiKey}`,
        },
        body: JSON.stringify({
          model: this.settings.doubaoVideoModel,
          content,
          duration: this.settings.doubaoVideoDuration,
          ratio: this.settings.doubaoVideoRatio,
        }),
      });
      if (!res.ok) throw new Error(`doubao video ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { id?: string };
      const taskId = data.id;
      if (!taskId) throw new Error("doubao task id missing");
      // poll up to ~5 minutes
      for (let i = 0; i < 100; i++) {
        await sleep(3000);
        const status = await fetch(
          `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${taskId}`,
          { headers: { Authorization: `Bearer ${this.settings.doubaoApiKey}` } },
        );
        const body = (await status.json()) as {
          status?: string;
          content?: { video_url?: string };
        };
        if (body.status === "succeeded" && body.content?.video_url) return body.content.video_url;
        if (body.status === "failed") throw new Error("doubao video generation failed");
      }
      throw new Error("doubao video polling timeout");
    }

    // OpenAI-compatible videos endpoint
    const url = `${this.settings.videoBaseUrl}${this.settings.videoEndpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "openoii-engine",
        ...(this.settings.videoApiKey
          ? { Authorization: `Bearer ${this.settings.videoApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.settings.videoModel,
        prompt,
        ...(this.settings.enableImageToVideo && args.imageUrl
          ? { image_url: args.imageUrl }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`video provider ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { data?: Array<{ url?: string }>; url?: string };
    const videoUrl = data.data?.[0]?.url ?? data.url;
    if (!videoUrl) throw new Error("video provider returned no url");
    return videoUrl;
  }

  private async ensureDefaultFakeClip(prompt: string): Promise<string> {
    const dir = join(this.settings.staticDir, "videos");
    mkdirSync(dir, { recursive: true });
    const filename = videoSlug(prompt);
    const dest = join(dir, filename);
    if (existsSync(dest)) return `/static/videos/${filename}`;

    const digest = parseInt(createHash("sha1").update(prompt).digest("hex").slice(0, 8), 16);
    const color = FAKE_VIDEO_COLORS[digest % FAKE_VIDEO_COLORS.length] ?? "0x111827";
    const label = promptLabel(prompt).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
    const shotNo = (digest % 97) + 1;
    const cmd = [
      "-y",
      "-f", "lavfi", "-i", `color=c=${color}:s=960x540:d=2.0`,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf",
      [
        "drawtext=text='Fake Video':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=150",
        `drawtext=text='#${String(shotNo).padStart(2, "0")} local placeholder':fontcolor=0xfbbf24:fontsize=34:x=(w-text_w)/2:y=230`,
        `drawtext=text='${label}':fontcolor=white@0.82:fontsize=24:x=(w-text_w)/2:y=315`,
        "drawtext=text='no external API call':fontcolor=white@0.62:fontsize=22:x=(w-text_w)/2:y=370",
      ].join(","),
      "-shortest",
      "-c:v", "libx264",
      "-t", "2.0",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      dest,
    ];
    try {
      await execFileAsync("ffmpeg", cmd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Fake video provider needs ffmpeg: ${message.slice(0, 300)}`);
    }
    return `/static/videos/${filename}`;
  }

  /** video_merger.py port: local concat via ffmpeg, copy first, re-encode fallback. */
  async mergeVideos(videoUrls: string[], outputFilename?: string): Promise<string> {
    if (videoUrls.length === 0) throw new Error("No video URLs provided");
    const name = outputFilename ?? `merged_${createHash("sha1").update(videoUrls.join()).digest("hex").slice(0, 8)}`;
    const outputDir = join(this.settings.staticDir, "videos");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${name}.mp4`);

    const localPaths = videoUrls.map((url) => this.localPathFor(url));
    for (const p of localPaths) {
      if (!existsSync(p)) throw new Error(`video file missing for merge: ${p}`);
    }

    if (localPaths.length === 1) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(localPaths[0] as string, outputPath);
      return `/static/videos/${name}.mp4`;
    }

    const concatFile = join(outputDir, `concat_${name}.txt`);
    writeFileSync(
      concatFile,
      localPaths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n") + "\n",
      "utf8",
    );

    try {
      await execFileAsync("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", outputPath,
      ]);
    } catch {
      // re-encode fallback (video_merger.py parity)
      await execFileAsync("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        outputPath,
      ]);
    }
    return `/static/videos/${name}.mp4`;
  }

  /** Resolve a /static/... URL to its local file path; pass through remote URLs. */
  localPathFor(url: string): string {
    if (url.startsWith("/static/")) {
      return join(this.settings.staticDir, url.slice("/static/".length));
    }
    if (url.startsWith("file://")) return url.slice("file://".length);
    return url;
  }

  /** 未实现（见 agents runAddAudio）：引擎还没移植 TTS/BGM。 */
  get audioEnabled(): boolean {
    return this.settings.ttsEnabled || this.settings.bgmEnabled;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mediaDirOf(staticDir: string, kind: "images" | "videos"): string {
  return join(resolve(staticDir), kind);
}
