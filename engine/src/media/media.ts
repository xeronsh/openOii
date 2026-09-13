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

export interface MediaProviderSnapshot {
  provider?: string | null;
  base_url?: string | null;
  model?: string | null;
  endpoint?: string | null;
  enable_image_to_image?: unknown;
  enable_image_to_video?: unknown;
  video_mode?: string | null;
  duration?: unknown;
  ratio?: string | null;
  credential_keys?: string[] | null;
}

export interface MediaRunSnapshot {
  image?: MediaProviderSnapshot | null;
  video?: MediaProviderSnapshot | null;
  policy?: Record<string, unknown> | null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve media settings for one execution.
 *
 * When a run snapshot exists, provider identity/model/endpoint/policy are taken
 * only from that immutable snapshot. Secrets are intentionally not snapshotted;
 * credential_keys name the live secret slots so keys may be rotated safely.
 * Tests and legacy direct callers without a run snapshot keep the old live-config
 * behavior.
 */
export function resolveMediaSettings(
  db: EngineDatabase,
  snapshot?: MediaRunSnapshot | null,
): MediaSettings {
  const staticDir =
    process.env.ENGINE_STATIC_DIR ??
    resolve(process.cwd(), "../backend/app/static");
  const pick = (key: string, env: string, fallback: string): string =>
    db.configValue(key, env, fallback) ?? fallback;
  const optional = (key: string, env: string): string | null => {
    const v = db.configValue(key, env);
    return v ? v : null;
  };
  const secret = (keys: string[] | null | undefined): string | null => {
    for (const key of keys ?? []) {
      const value = db.configValue(key, key);
      if (value) return value;
    }
    return null;
  };

  const imageSnapshot = snapshot?.image ?? null;
  const videoSnapshot = snapshot?.video ?? null;
  const policy = snapshot?.policy ?? null;

  const imageProviderRaw = imageSnapshot?.provider ?? pick("IMAGE_PROVIDER", "IMAGE_PROVIDER", "fake");
  const imageProvider: MediaSettings["imageProvider"] =
    imageProviderRaw === "modelscope" || imageProviderRaw === "openai" ? imageProviderRaw : "fake";
  const videoProviderRaw = videoSnapshot?.provider ?? pick("VIDEO_PROVIDER", "VIDEO_PROVIDER", "fake");
  const videoProvider: MediaSettings["videoProvider"] =
    videoProviderRaw === "openai" || videoProviderRaw === "doubao" ? videoProviderRaw : "fake";

  const imageBaseUrl = imageSnapshot
    ? String(imageSnapshot.base_url ?? "")
    : pick("IMAGE_BASE_URL", "IMAGE_BASE_URL", "https://api-inference.modelscope.cn");
  const videoBaseUrl = videoSnapshot
    ? String(videoSnapshot.base_url ?? "")
    : pick("VIDEO_BASE_URL", "VIDEO_BASE_URL", "https://api.example.com/v1");
  if (imageSnapshot && imageProvider !== "fake" && !imageBaseUrl) {
    throw new Error(`pinned image provider ${imageProvider} has no base_url`);
  }
  if (videoSnapshot && videoProvider !== "fake" && videoProvider !== "doubao" && !videoBaseUrl) {
    throw new Error(`pinned video provider ${videoProvider} has no base_url`);
  }

  const defaultImageCredentialKeys = imageProvider === "fake" ? [] : ["IMAGE_API_KEY"];
  const defaultVideoCredentialKeys =
    videoProvider === "fake"
      ? []
      : videoProvider === "doubao"
        ? ["DOUBAO_API_KEY"]
        : ["VIDEO_API_KEY"];
  const videoSecret = videoSnapshot
    ? secret(videoSnapshot.credential_keys ?? defaultVideoCredentialKeys)
    : null;

  return {
    imageProvider,
    imageBaseUrl,
    imageApiKey: imageSnapshot
      ? secret(imageSnapshot.credential_keys ?? defaultImageCredentialKeys)
      : optional("IMAGE_API_KEY", "IMAGE_API_KEY"),
    imageModel: imageSnapshot
      ? String(imageSnapshot.model ?? (imageProvider === "fake" ? "fake" : ""))
      : pick("IMAGE_MODEL", "IMAGE_MODEL", "Tongyi-MAI/Z-Image-Turbo"),
    imageEndpoint: imageSnapshot
      ? String(imageSnapshot.endpoint ?? "/v1/images/generations")
      : pick("IMAGE_ENDPOINT", "IMAGE_ENDPOINT", "/v1/images/generations"),
    enableImageToImage: imageSnapshot
      ? asBoolean(imageSnapshot.enable_image_to_image, true)
      : pick("ENABLE_IMAGE_TO_IMAGE", "ENABLE_IMAGE_TO_IMAGE", "true") === "true",
    // Fixture paths are local test/development plumbing, not execution provider
    // identity. They deliberately remain live and are ignored by real providers.
    fakeImageFixtureUrl: optional("FAKE_IMAGE_FIXTURE_URL", "FAKE_IMAGE_FIXTURE_URL"),

    videoProvider,
    videoBaseUrl,
    videoApiKey:
      videoProvider === "openai"
        ? videoSnapshot
          ? videoSecret
          : optional("VIDEO_API_KEY", "VIDEO_API_KEY")
        : null,
    videoModel: videoSnapshot
      ? String(videoSnapshot.model ?? (videoProvider === "fake" ? "fake" : ""))
      : pick("VIDEO_MODEL", "VIDEO_MODEL", "video-gen-1"),
    videoEndpoint: videoSnapshot
      ? String(videoSnapshot.endpoint ?? "/videos/generations")
      : pick("VIDEO_ENDPOINT", "VIDEO_ENDPOINT", "/videos/generations"),
    enableImageToVideo: videoSnapshot
      ? asBoolean(videoSnapshot.enable_image_to_video, false)
      : pick("ENABLE_IMAGE_TO_VIDEO", "ENABLE_IMAGE_TO_VIDEO", "false") === "true",
    videoMode: videoSnapshot
      ? String(videoSnapshot.video_mode ?? "text")
      : pick("VIDEO_MODE", "VIDEO_MODE", "text"),
    fakeVideoFixtureUrl: optional("FAKE_VIDEO_FIXTURE_URL", "FAKE_VIDEO_FIXTURE_URL"),
    fakeVideoFixturePath: optional("FAKE_VIDEO_FIXTURE_PATH", "FAKE_VIDEO_FIXTURE_PATH"),
    doubaoApiKey:
      videoProvider === "doubao"
        ? videoSnapshot
          ? videoSecret
          : optional("DOUBAO_API_KEY", "DOUBAO_API_KEY")
        : null,
    doubaoVideoModel: videoSnapshot
      ? String(videoSnapshot.model ?? "doubao-seedance-1-5-pro-251215")
      : pick("DOUBAO_VIDEO_MODEL", "DOUBAO_VIDEO_MODEL", "doubao-seedance-1-5-pro-251215"),
    doubaoVideoDuration: videoSnapshot
      ? asNumber(videoSnapshot.duration, 5)
      : Number(pick("DOUBAO_VIDEO_DURATION", "DOUBAO_VIDEO_DURATION", "5")),
    doubaoVideoRatio: videoSnapshot
      ? String(videoSnapshot.ratio ?? "adaptive")
      : pick("DOUBAO_VIDEO_RATIO", "DOUBAO_VIDEO_RATIO", "adaptive"),

    ttsEnabled: policy
      ? asBoolean(policy.tts_enabled, true)
      : pick("TTS_ENABLED", "TTS_ENABLED", "true") === "true",
    bgmEnabled: policy
      ? asBoolean(policy.bgm_enabled, true)
      : pick("BGM_ENABLED", "BGM_ENABLED", "true") === "true",

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
      if (!existsSync(path)) writeFileSync(path, placeholderSvg(prompt), "utf8");
      return `/static/images/${filename}`;
    }

    if (!this.settings.imageApiKey) throw new Error("IMAGE_API_KEY is required");
    const endpoint = new URL(this.settings.imageEndpoint, this.settings.imageBaseUrl).toString();
    const payload: Record<string, unknown> = {
      model: this.settings.imageModel,
      prompt,
      size: args.size ?? "1024x1024",
    };
    if (args.imageBytes && this.settings.enableImageToImage) {
      payload.image = `data:image/png;base64,${args.imageBytes.toString("base64")}`;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.imageApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`image provider failed: ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    const data = Array.isArray(body.data) ? body.data[0] : null;
    const url = data && typeof data === "object" ? (data as Record<string, unknown>).url : null;
    if (typeof url !== "string" || !url) throw new Error("image provider returned no URL");
    return url;
  }

  async generateVideoUrl(args: {
    prompt: string;
    imageUrl?: string | null;
    duration?: number;
  }): Promise<string> {
    const { prompt } = args;
    if (this.settings.fakeVideoFixtureUrl) return this.settings.fakeVideoFixtureUrl;

    if (this.settings.videoProvider === "fake") {
      const dir = join(this.settings.staticDir, "videos");
      mkdirSync(dir, { recursive: true });
      const filename = videoSlug(prompt);
      const path = join(dir, filename);
      if (this.settings.fakeVideoFixturePath && existsSync(this.settings.fakeVideoFixturePath)) {
        if (!existsSync(path)) writeFileSync(path, readFileSync(this.settings.fakeVideoFixturePath));
        return `/static/videos/${filename}`;
      }
      if (!existsSync(path)) {
        const idx = parseInt(createHash("sha1").update(prompt).digest("hex").slice(0, 2), 16) % FAKE_VIDEO_COLORS.length;
        const duration = Math.max(1, Math.min(args.duration ?? 3, 10));
        await execFileAsync("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${FAKE_VIDEO_COLORS[idx]}:s=960x540:d=${duration}`,
          "-vf",
          `drawtext=text='${promptLabel(prompt).replace(/'/g, "") }':fontcolor=white:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2`,
          "-pix_fmt",
          "yuv420p",
          path,
        ]);
      }
      return `/static/videos/${filename}`;
    }

    if (this.settings.videoProvider === "doubao") {
      if (!this.settings.doubaoApiKey) throw new Error("DOUBAO_API_KEY is required");
      const payload: Record<string, unknown> = {
        model: this.settings.doubaoVideoModel,
        content: [{ type: "text", text: prompt }],
        duration: args.duration ?? this.settings.doubaoVideoDuration,
        ratio: this.settings.doubaoVideoRatio,
      };
      if (args.imageUrl && this.settings.enableImageToVideo) {
        (payload.content as unknown[]).push({ type: "image_url", image_url: { url: args.imageUrl } });
      }
      const createResponse = await fetch("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.doubaoApiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!createResponse.ok) throw new Error(`doubao create failed: ${createResponse.status}`);
      const created = (await createResponse.json()) as Record<string, unknown>;
      const taskId = String(created.id ?? "");
      if (!taskId) throw new Error("doubao returned no task id");
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await fetch(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${this.settings.doubaoApiKey}` },
        });
        if (!poll.ok) throw new Error(`doubao poll failed: ${poll.status}`);
        const state = (await poll.json()) as Record<string, unknown>;
        const status = String(state.status ?? "");
        if (status === "succeeded") {
          const content = state.content as Record<string, unknown> | undefined;
          const videoUrl = content && typeof content.video_url === "string" ? content.video_url : null;
          if (!videoUrl) throw new Error("doubao returned no video URL");
          return videoUrl;
        }
        if (["failed", "cancelled"].includes(status)) {
          throw new Error(`doubao task ${status}: ${String(state.error ?? "unknown")}`);
        }
      }
      throw new Error("doubao video generation timed out");
    }

    if (!this.settings.videoApiKey) throw new Error("VIDEO_API_KEY is required");
    const endpoint = new URL(this.settings.videoEndpoint, this.settings.videoBaseUrl).toString();
    const payload: Record<string, unknown> = {
      model: this.settings.videoModel,
      prompt,
      duration: args.duration,
    };
    if (args.imageUrl && this.settings.enableImageToVideo) payload.image_url = args.imageUrl;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.videoApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`video provider failed: ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    const directUrl = typeof body.url === "string" ? body.url : null;
    const data = Array.isArray(body.data) ? body.data[0] : null;
    const nestedUrl = data && typeof data === "object" ? (data as Record<string, unknown>).url : null;
    const url = directUrl ?? (typeof nestedUrl === "string" ? nestedUrl : null);
    if (!url) throw new Error("video provider returned no URL");
    return url;
  }
}
