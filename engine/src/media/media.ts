/**
 * Media services: image / video / TTS.
 *
 * Provider identity/model/endpoint is pinned by RunContextSnapshot. Secrets are
 * resolved by credential key at execution time so rotation does not rewrite a
 * historical run snapshot. External create requests carry the durable stage
 * idempotency key when the provider accepts arbitrary HTTP headers.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  linkSync,
  unlinkSync,
  rmSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { EngineDatabase } from "../db.js";
import {
  AiOperationError,
  assertOperationInFlight,
  operationHeaders,
  type AiOperation,
  withAiActivity,
} from "../ai-operation.js";
import { operationSpanAttributes, withProviderSpan } from "../observability.js";
import {
  buildSubtitleCues,
  renderAss,
  renderSrt,
  subtitleLayout,
  subtitleMode,
  type SubtitleMode,
  type SubtitleSegment,
} from "./subtitles.js";
import {
  VIDEO_JOB_ADAPTERS,
  isVideoJobProvider,
  runVideoJob,
  videoJobDuration,
  type VideoJobAdapter,
  type VideoJobProvider,
} from "./video-jobs/index.js";

const execFileAsync = promisify(execFile);

export interface MediaSettings {
  imageProvider: "fake" | "modelscope" | "openai";
  imageBaseUrl: string;
  imageApiKey: string | null;
  imageModel: string;
  imageEndpoint: string;
  enableImageToImage: boolean;
  fakeImageFixtureUrl: string | null;

  videoProvider: "fake" | "openai" | "doubao" | VideoJobProvider;
  videoBaseUrl: string;
  videoApiKey: string | null;
  videoModel: string;
  videoEndpoint: string;
  enableImageToVideo: boolean;
  videoMode: string;
  /** 服务商原生接口的画幅（VIDEO_RATIO），不支持时由各模块回落 */
  videoRatio: string;
  fakeVideoFixtureUrl: string | null;
  fakeVideoFixturePath: string | null;
  doubaoApiKey: string | null;
  doubaoVideoModel: string;
  doubaoVideoDuration: number;
  doubaoVideoRatio: string;
  videoImageMode: string;
  videoInlineLocalImages: boolean;
  publicBaseUrl: string | null;

  ttsEnabled: boolean;
  bgmEnabled: boolean;
  /** 配音服务商（TTS_PROVIDER），默认 edge */
  ttsProvider?: string;
  ttsBaseUrl?: string | null;
  ttsModel?: string | null;
  ttsApiKey?: string | null;
  ttsDefaultVoice: string;
  ttsVolume: number;
  bgmVolume: number;
  bgmDirectory: string;
  /** 背景音乐服务商（BGM_PROVIDER）：library / minimax / stability / suno，默认 library */
  bgmProvider?: string;
  bgmBaseUrl?: string | null;
  bgmModel?: string | null;
  bgmApiKey?: string | null;
  /** 有台词时压低背景音乐，默认开 */
  bgmDucking?: boolean;
  /** 字幕：off / soft / burn（项目可覆盖），默认 off */
  subtitleMode?: SubtitleMode;
  subtitleFont?: string;
  textProvider: string;
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
  video_image_mode?: string | null;
  video_inline_local_images?: unknown;
  public_base_url?: string | null;
  duration?: unknown;
  ratio?: string | null;
  credential_keys?: string[] | null;
}

export interface MediaRunSnapshot {
  text?: MediaProviderSnapshot | null;
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
 * A run without a frozen policy (targeted runs such as 重新合成 or a single-shot
 * regen) still honours the project's own 配音 / 字幕 / 背景音乐 switches; a
 * missing or null switch follows settings, as in the backend's run context.
 */
export function withProjectMediaOptions(settings: MediaSettings, raw: unknown): MediaSettings {
  let options: unknown = raw;
  if (typeof raw === "string") {
    try {
      options = JSON.parse(raw);
    } catch {
      return settings;
    }
  }
  if (!options || typeof options !== "object") return settings;
  const { tts, bgm, subtitles } = options as Record<string, unknown>;
  return {
    ...settings,
    ...(typeof tts === "boolean" ? { ttsEnabled: tts } : {}),
    ...(typeof bgm === "boolean" ? { bgmEnabled: bgm } : {}),
    ...(subtitles === "off" || subtitles === "soft" || subtitles === "burn"
      ? { subtitleMode: subtitleMode(subtitles) }
      : {}),
  };
}

export function resolveMediaSettings(
  db: EngineDatabase,
  snapshot?: MediaRunSnapshot | null,
): MediaSettings {
  const staticDir =
    process.env.ENGINE_STATIC_DIR ?? resolve(process.cwd(), "../backend/app/static");
  const pick = (key: string, env: string, fallback: string): string =>
    db.configValue(key, env, fallback) ?? fallback;
  const optional = (key: string, env: string): string | null => {
    const value = db.configValue(key, env);
    return value ? value : null;
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
  const textSnapshot = snapshot?.text ?? null;
  const policy = snapshot?.policy ?? null;

  const imageProviderRaw =
    imageSnapshot?.provider ?? pick("IMAGE_PROVIDER", "IMAGE_PROVIDER", "fake");
  const imageProvider: MediaSettings["imageProvider"] =
    imageProviderRaw === "modelscope" || imageProviderRaw === "openai"
      ? imageProviderRaw
      : "fake";
  const videoProviderRaw =
    videoSnapshot?.provider ?? pick("VIDEO_PROVIDER", "VIDEO_PROVIDER", "fake");
  const videoMode = videoSnapshot
    ? String(videoSnapshot.video_mode ?? "text")
    : pick("VIDEO_MODE", "VIDEO_MODE", "text");
  const enableImageToVideo = (videoSnapshot
    ? asBoolean(videoSnapshot.enable_image_to_video, false)
    : pick("ENABLE_IMAGE_TO_VIDEO", "ENABLE_IMAGE_TO_VIDEO", "false") === "true") || videoMode === "image";
  const videoProvider: MediaSettings["videoProvider"] =
    videoProviderRaw === "openai" || videoProviderRaw === "doubao" || isVideoJobProvider(videoProviderRaw)
      ? videoProviderRaw
      : "fake";
  const textProvider = String(
    textSnapshot?.provider ?? pick("TEXT_PROVIDER", "TEXT_PROVIDER", "anthropic"),
  );

  const imageBaseUrl = imageSnapshot
    ? String(imageSnapshot.base_url ?? "")
    : pick("IMAGE_BASE_URL", "IMAGE_BASE_URL", "https://api-inference.modelscope.cn");
  const videoBaseUrl = videoSnapshot
    ? String(videoSnapshot.base_url ?? "")
    : pick("VIDEO_BASE_URL", "VIDEO_BASE_URL", "https://api.example.com/v1");
  if (imageSnapshot && imageProvider !== "fake" && !imageBaseUrl) {
    throw new Error(`pinned image provider ${imageProvider} has no base_url`);
  }
  if (
    videoSnapshot &&
    videoProvider !== "fake" &&
    videoProvider !== "doubao" &&
    !videoBaseUrl
  ) {
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
    fakeImageFixtureUrl: optional("FAKE_IMAGE_FIXTURE_URL", "FAKE_IMAGE_FIXTURE_URL"),

    videoProvider,
    videoBaseUrl,
    videoApiKey:
      videoProvider !== "fake" && videoProvider !== "doubao"
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
    enableImageToVideo,
    videoMode,
    videoRatio: videoSnapshot
      ? String(videoSnapshot.ratio ?? "16:9")
      : pick("VIDEO_RATIO", "VIDEO_RATIO", "16:9"),
    videoImageMode: videoSnapshot && "video_image_mode" in videoSnapshot
      ? String(videoSnapshot.video_image_mode ?? "first_frame")
      : pick("VIDEO_IMAGE_MODE", "VIDEO_IMAGE_MODE", "first_frame"),
    videoInlineLocalImages: videoSnapshot && "video_inline_local_images" in videoSnapshot
      ? asBoolean(videoSnapshot.video_inline_local_images, true)
      : pick("VIDEO_INLINE_LOCAL_IMAGES", "VIDEO_INLINE_LOCAL_IMAGES", "true") === "true",
    publicBaseUrl: videoSnapshot && "public_base_url" in videoSnapshot
      ? videoSnapshot.public_base_url ?? null
      : optional("PUBLIC_BASE_URL", "PUBLIC_BASE_URL"),
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
      : pick(
          "DOUBAO_VIDEO_MODEL",
          "DOUBAO_VIDEO_MODEL",
          "doubao-seedance-1-5-pro-251215",
        ),
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
    ttsProvider: policy && "tts_provider" in policy
      ? String(policy.tts_provider ?? "edge") || "edge"
      : pick("TTS_PROVIDER", "TTS_PROVIDER", "edge"),
    ttsBaseUrl: policy && "tts_base_url" in policy
      ? (policy.tts_base_url ? String(policy.tts_base_url) : null)
      : optional("TTS_BASE_URL", "TTS_BASE_URL"),
    ttsModel: policy && "tts_model" in policy
      ? (policy.tts_model ? String(policy.tts_model) : null)
      : optional("TTS_MODEL", "TTS_MODEL"),
    ttsApiKey: secret(
      Array.isArray(policy?.tts_credential_keys)
        ? (policy.tts_credential_keys as unknown[]).map(String)
        : ["TTS_API_KEY"],
    ),
    ttsDefaultVoice: policy && "tts_default_voice" in policy
      ? String(policy.tts_default_voice ?? "zh-CN-XiaoxiaoNeural")
      : pick("TTS_DEFAULT_VOICE", "TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural"),
    ttsVolume: policy && "tts_volume" in policy
      ? asNumber(policy.tts_volume, 1)
      : asNumber(pick("TTS_VOLUME", "TTS_VOLUME", "1"), 1),
    bgmVolume: policy && "bgm_volume" in policy
      ? asNumber(policy.bgm_volume, 0.3)
      : asNumber(pick("BGM_VOLUME", "BGM_VOLUME", "0.3"), 0.3),
    bgmDirectory: policy && "bgm_directory" in policy
      ? String(policy.bgm_directory ?? "static/bgm")
      : pick("BGM_DIRECTORY", "BGM_DIRECTORY", "static/bgm"),
    bgmProvider: policy && "bgm_provider" in policy
      ? String(policy.bgm_provider ?? "library") || "library"
      : pick("BGM_PROVIDER", "BGM_PROVIDER", "library"),
    bgmBaseUrl: policy && "bgm_base_url" in policy
      ? (policy.bgm_base_url ? String(policy.bgm_base_url) : null)
      : optional("BGM_BASE_URL", "BGM_BASE_URL"),
    bgmModel: policy && "bgm_model" in policy
      ? (policy.bgm_model ? String(policy.bgm_model) : null)
      : optional("BGM_MODEL", "BGM_MODEL"),
    bgmApiKey: secret(
      Array.isArray(policy?.bgm_credential_keys)
        ? (policy.bgm_credential_keys as unknown[]).map(String)
        : ["BGM_API_KEY"],
    ),
    bgmDucking: policy && "bgm_ducking" in policy
      ? asBoolean(policy.bgm_ducking, true)
      : pick("BGM_DUCKING", "BGM_DUCKING", "true") !== "false",
    subtitleMode: subtitleMode(
      policy && "subtitle_mode" in policy ? policy.subtitle_mode : pick("SUBTITLE_MODE", "SUBTITLE_MODE", "off"),
    ),
    subtitleFont: policy && "subtitle_font" in policy
      ? String(policy.subtitle_font ?? "Smiley Sans") || "Smiley Sans"
      : pick("SUBTITLE_FONT", "SUBTITLE_FONT", "Smiley Sans"),
    textProvider,
    staticDir,
  };
}

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
  const digest = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="100%" height="100%" fill="#1e1b4b"/><text x="50%" y="45%" fill="#fbbf24" font-size="36" text-anchor="middle" font-family="sans-serif">Fake Image</text><text x="50%" y="58%" fill="#ffffff" font-size="20" text-anchor="middle" font-family="sans-serif">${label}</text><text x="50%" y="68%" fill="#94a3b8" font-size="14" text-anchor="middle" font-family="sans-serif">Prompt ${digest}</text></svg>`;
}

const FAKE_VIDEO_COLORS = [
  "0x111827",
  "0x1e1b4b",
  "0x422006",
  "0x052e16",
  "0x3b0764",
  "0x0f172a",
];

function promptLabel(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const ascii = compact.replace(/[^\x20-\x7E]/g, "").trim();
  if (ascii.length >= 3) return ascii.slice(0, 36);
  const digest = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
  return `local prompt ${digest}`;
}

/**
 * Join a provider base URL and endpoint path the way the Python services do
 * (`base.rstrip("/") + "/" + endpoint`). `new URL("/v1/x", "https://h/api")`
 * would drop the base path, so a base of `…/v1` lost its `/v1`.
 */
export function joinEndpoint(baseUrl: string, endpoint: string): string {
  const trimmed = endpoint.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = baseUrl.replace(/\/+$/, "");
  if (!trimmed) return base;
  return `${base}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
}

/**
 * Providers return media URLs relative to their own host (`/v1/media/x.webp`)
 * or to the API base. Anything that is not already absolute is resolved
 * against the provider base URL.
 */
export function absoluteMediaUrl(url: string, baseUrl: string): string {
  if (/^(https?:|data:)/i.test(url)) return url;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(url, base).toString();
}

/** Identify an image by its magic bytes; providers often serve octet-stream. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  const head = bytes.subarray(0, 512).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

/**
 * Whole seconds for every video provider (an OpenAI-compatible endpoint may
 * reject `4.5`); doubao only accepts 5 or 10; vendor-native providers snap to
 * the values their model allows (e.g. Veo 4/6/8, MiniMax 6/10).
 */
export function normalizeVideoDuration(provider: string, duration: number, model = ""): number {
  const vendor = videoJobDuration(provider, model, duration);
  if (vendor !== null) return vendor;
  const seconds = Math.max(1, Math.round(Number.isFinite(duration) ? duration : 5));
  if (provider === "doubao") return seconds === 10 ? 10 : 5;
  return seconds;
}

const VIDEO_TASK_PENDING = new Set([
  "",
  "queued",
  "pending",
  "submitted",
  "created",
  "running",
  "processing",
  "in_progress",
]);
const VIDEO_TASK_DONE = new Set(["completed", "succeeded", "success", "done"]);
const VIDEO_TASK_FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

/** First media URL in a provider result: `url`, `video_url`, `data[0].url`, `result.url`… */
export function extractMediaUrl(body: Record<string, unknown>): string | null {
  const pick = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  for (const key of ["video_url", "url", "output_url", "result_url"]) {
    const found = pick(body[key]);
    if (found) return found;
  }
  for (const key of ["output", "result", "video", "data", "content"]) {
    const container = body[key];
    const item = Array.isArray(container) ? container[0] : container;
    if (item && typeof item === "object") {
      for (const inner of ["url", "video_url"]) {
        const found = pick((item as Record<string, unknown>)[inner]);
        if (found) return found;
      }
    }
  }
  return null;
}

function extractTaskId(body: Record<string, unknown>): string | null {
  for (const key of ["id", "task_id", "request_id"]) {
    const value = body[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Where to poll an async video task created at `endpoint`: the OpenAI-style
 * resource (`/v1/videos/{id}` for `/v1/videos/generations`, the Python
 * backend's convention) first, then the create path itself plus the id.
 */
export function videoTaskPollUrls(baseUrl: string, endpoint: string, taskId: string): string[] {
  const create = joinEndpoint(baseUrl, endpoint).replace(/\/+$/, "");
  const id = encodeURIComponent(taskId);
  const urls: string[] = [];
  if (create.endsWith("/video/create")) {
    urls.push(`${create.slice(0, -"/create".length)}/query?id=${id}`);
  } else if (create.includes("/generations")) {
    urls.push(`${create.split("/generations")[0]}/${id}`);
  }
  urls.push(`${create}/${id}`);
  return [...new Set(urls)];
}

export class MediaService {
  private idempotencyKey: string | null = null;
  private abortSignal: AbortSignal | null = null;
  private retryNotice: ((message: string) => Promise<void> | void) | null = null;
  private registerMedia: ((relativePath: string) => void) | null = null;
  /**
   * Current operation identity, when the caller supplied one.
   *
   * Provider requests get their idempotency header and cancellation from this
   * single object instead of from separate fields, matching the contract text
   * operations already use (`ai-operation.ts`).
   */
  private operation: AiOperation | null = null;

  constructor(private readonly settings: MediaSettings) {}

  /** Bind the operation the following media requests belong to. */
  /**
   * Bind the operation the following media requests belong to. Its idempotency
   * key and deadline apply to every provider call until it is cleared, so
   * identity and cancellation come from one object (see `ai-operation.ts`).
   */
  setOperation(operation: AiOperation | null): void {
    this.operation = operation;
    this.idempotencyKey = operation?.idempotencyKey ?? null;
  }

  /**
   * Bind the run's cancellation signal. Every provider request and every
   * in-process wait then observes it, so cancel stops the work instead of
   * merely marking the run cancelled while the request keeps running.
   */
  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  /** Report each transient-failure retry to the run (shown in chat). */
  setRetryNotice(notice: (message: string) => Promise<void> | void): void {
    this.retryNotice = notice;
  }

  setMediaRegistrar(register: (relativePath: string) => void): void {
    this.registerMedia = register;
  }

  private managedMediaDirectory(): string {
    mkdirSync(this.settings.staticDir, { recursive: true });
    const root = realpathSync(this.settings.staticDir);
    const dir = join(root, "managed-v1");
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) {
      throw new Error("managed media directory must be a real directory inside static storage");
    }
    return dir;
  }

  private publishManagedFile(source: string, extension: string): string {
    if (!this.registerMedia) throw new Error("managed media registration requires an execution fence");
    const dir = this.managedMediaDirectory();
    const filename = `${randomUUID()}${extension}`;
    const relativePath = `managed-v1/${filename}`;
    const destination = join(dir, filename);
    linkSync(source, destination);
    try {
      this.registerMedia(relativePath);
      return `/static/${relativePath}`;
    } catch (error) {
      unlinkSync(destination);
      throw error;
    }
  }

  private writeManagedFile(contents: string, extension: string): string {
    if (!this.registerMedia) throw new Error("managed media registration requires an execution fence");
    const dir = this.managedMediaDirectory();
    const filename = `${randomUUID()}${extension}`;
    const relativePath = `managed-v1/${filename}`;
    const destination = join(dir, filename);
    writeFileSync(destination, contents, { encoding: "utf8", flag: "wx" });
    try {
      this.registerMedia(relativePath);
      return `/static/${relativePath}`;
    } catch (error) {
      unlinkSync(destination);
      throw error;
    }
  }

  /** Reject if the run was cancelled, before starting more provider work. */
  private throwIfAborted(): void {
    if (this.operation) {
      assertOperationInFlight(this.operation);
      return;
    }
    if (this.abortSignal?.aborted) {
      throw new AiOperationError("aborted", "media", "run cancelled: provider request aborted");
    }
  }

  private requestInit(init: RequestInit = {}): RequestInit {
    return this.abortSignal ? { ...init, signal: this.abortSignal } : init;
  }

  /**
   * POST to a media provider, retrying transient failures the way the Python
   * services do (408/429/5xx, plus Cloudflare's 520–524/530 origin errors and
   * network errors; other 4xx are not retried). The idempotency key is reused across attempts.
   */
  private async postProvider(endpoint: string, init: RequestInit): Promise<Response> {
    const base = providerRetryBaseMs();
    for (let attempt = 0; ; attempt += 1) {
      this.throwIfAborted();
      let response: Response | null = null;
      let error: unknown = null;
      try {
        response = await fetch(endpoint, this.requestInit(init));
      } catch (caught) {
        if (this.abortSignal?.aborted) throw caught;
        error = caught;
      }
      const retryable = response ? RETRYABLE_PROVIDER_STATUS.has(response.status) : true;
      if (!retryable || attempt >= PROVIDER_MAX_RETRIES) {
        if (response) return response;
        throw error;
      }
      const reason = response ? `HTTP ${response.status}` : "连接失败";
      console.warn(
        `media provider ${response ? `returned ${response.status}` : "request failed"}; retry ${attempt + 1}/${PROVIDER_MAX_RETRIES}`,
      );
      await response?.body?.cancel().catch(() => undefined);
      const delay = base * 3 ** attempt;
      await Promise.resolve(
        this.retryNotice?.(
          `上游暂时不可用（${reason}），${Math.round(delay / 1000)} 秒后第${attempt + 1}次重试（共${PROVIDER_MAX_RETRIES}次）`,
        ),
      ).catch(() => undefined);
      await this.wait(delay);
    }
  }

  /** Cancellable wait: a pending backoff or poll must not outlive the run. */
  private async wait(ms: number): Promise<void> {
    const signal = this.abortSignal;
    if (!signal) {
      await sleep(ms);
      return;
    }
    if (signal.aborted) {
      throw new AiOperationError("aborted", "media", "run cancelled: provider request aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(
          new AiOperationError("aborted", "media", "run cancelled: provider request aborted"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** GenAI span attributes for a media provider request. */
  private providerSpanAttributes(kind: "image" | "video", system: string, model: string) {
    const identity = this.operation ? operationSpanAttributes(this.operation) : {};
    return {
      ...identity,
      "gen_ai.system": system,
      "gen_ai.operation.name": kind === "image" ? "image_generation" : "video_generation",
      "gen_ai.request.model": model,
    };
  }

  private idempotencyHeaders(): Record<string, string> {
    // One header contract for every provider that accepts operation identity.
    if (this.operation) return operationHeaders(this.operation);
    return this.idempotencyKey ? { "Idempotency-Key": this.idempotencyKey } : {};
  }

  get staticDir(): string {
    return this.settings.staticDir;
  }

  get audioEnabled(): boolean {
    return this.settings.ttsEnabled || this.settings.bgmEnabled;
  }

  async readImageBytes(url: string): Promise<Buffer> {
    this.throwIfAborted();
    if (url.startsWith("/static/")) {
      const root = realpathSync(this.settings.staticDir);
      const path = realpathSync(resolve(root, url.slice("/static/".length)));
      if (!path.startsWith(`${root}${sep}`)) throw new Error("image path is outside static storage");
      return readFileSync(path);
    }
    if (url.startsWith("data:image/")) {
      const comma = url.indexOf(",");
      if (comma < 0 || !url.slice(0, comma).endsWith(";base64")) {
        throw new Error("unsupported image data URL");
      }
      return Buffer.from(url.slice(comma + 1), "base64");
    }
    if (!/^https?:\/\//i.test(url)) throw new Error("unsupported image URL");
    const timeout = AbortSignal.timeout(30_000);
    const signal = this.abortSignal ? AbortSignal.any([this.abortSignal, timeout]) : timeout;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`image download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  saveImageBytes(image: Buffer, prefix: string): string {
    const dir = join(this.settings.staticDir, "images");
    mkdirSync(dir, { recursive: true });
    const digest = createHash("sha1").update(image).digest("hex").slice(0, 12);
    const filename = `${safeSlug(prefix, "reference")}_${digest}.png`;
    const path = join(dir, filename);
    if (!existsSync(path)) writeFileSync(path, image);
    return `/static/images/${filename}`;
  }

  async generateImageUrl(args: {
    prompt: string;
    size?: string;
    imageBytes?: Buffer | null;
  }): Promise<string> {
    // One provider span per image request, nested under its stage span.
    return withAiActivity(this.operation ?? undefined, "图像生成", () =>
      withProviderSpan(
        "gen_ai.image.generate",
        this.providerSpanAttributes("image", this.settings.imageProvider, this.settings.imageModel),
        () => this.generateImageUrlInner(args),
      ),
    );
  }

  private async generateImageUrlInner(args: {
    prompt: string;
    size?: string;
    imageBytes?: Buffer | null;
  }): Promise<string> {
    const { prompt } = args;
    if (this.settings.fakeImageFixtureUrl) return this.settings.fakeImageFixtureUrl;

    if (this.settings.imageProvider === "fake") {
      return this.writeManagedFile(placeholderSvg(prompt), ".svg");
    }

    if (!this.settings.imageApiKey) throw new Error("IMAGE_API_KEY is required");
    this.throwIfAborted();
    const endpoint = joinEndpoint(this.settings.imageBaseUrl, this.settings.imageEndpoint);
    const payload: Record<string, unknown> = {
      model: this.settings.imageModel,
      prompt,
      size: args.size ?? "1024x1024",
    };
    if (args.imageBytes && this.settings.enableImageToImage) {
      const mime = sniffImageMime(args.imageBytes) ?? "image/png";
      payload.image = `data:${mime};base64,${args.imageBytes.toString("base64")}`;
    }
    const modelscope = this.settings.imageProvider === "modelscope";
    if (modelscope && payload.image) {
      // ModelScope 的图生图参数叫 image_url
      payload.image_url = payload.image;
      delete payload.image;
    }
    const response = await this.postProvider(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.imageApiKey}`,
        // ModelScope API-Inference 只支持异步出图：提交返回 task_id，再轮询 /v1/tasks/{id}
        ...(modelscope ? { "X-ModelScope-Async-Mode": "true" } : {}),
        ...this.idempotencyHeaders(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`image provider failed: ${response.status}`);
    let body = (await response.json()) as Record<string, unknown>;
    if (modelscope && typeof body.task_id === "string" && body.task_id && !Array.isArray(body.data)) {
      body = { data: [{ url: await this.pollModelScopeImage(body.task_id) }] };
    }
    const data = Array.isArray(body.data) ? body.data[0] : null;
    const item = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    if (item && typeof item.b64_json === "string" && item.b64_json) {
      const bytes = Buffer.from(item.b64_json, "base64");
      return this.persistBytes(bytes, IMAGE_EXTENSIONS[sniffImageMime(bytes) ?? ""] ?? ".png");
    }
    const url = item?.url;
    if (typeof url !== "string" || !url) throw new Error("image provider returned no URL");
    return this.persistProviderMedia(
      this.providerMediaUrl(url, this.settings.imageBaseUrl),
      "image",
      this.settings.imageBaseUrl,
    );
  }

  /**
   * Keep generated media on our side at generation time. Provider URLs expire,
   * may be relative, served as octet-stream, or (behind fake-IP DNS) fail the
   * public-address check when compose downloads them much later. A URL on the
   * provider's own host is fetched directly (it is the endpoint the operator
   * configured); any other host goes through the public-address guard.
   * If the copy fails the remote URL is kept, as before.
   */
  /**
   * Where a provider-returned URL points. A relative `/static/...` path that
   * already exists in our static directory is ours (a local gateway or proxy
   * may have written the file there), so it is kept as a local path; any other
   * relative URL belongs to the provider host.
   */
  private providerMediaUrl(url: string, providerBaseUrl: string): string {
    if (url.startsWith("/static/")) {
      const relative = url.slice("/static/".length).split(/[?#]/)[0] ?? "";
      const root = resolve(this.settings.staticDir);
      const candidate = resolve(root, relative);
      if (relative && candidate.startsWith(root + sep) && existsSync(candidate)) return url;
    }
    return absoluteMediaUrl(url, providerBaseUrl);
  }

  private async persistProviderMedia(
    url: string,
    kind: "image" | "video",
    providerBaseUrl: string,
  ): Promise<string> {
    if (url.startsWith("/static/")) return url;
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      if (comma > 0 && url.slice(0, comma).endsWith(";base64")) {
        const bytes = Buffer.from(url.slice(comma + 1), "base64");
        return this.persistBytes(bytes, kind === "video" ? ".mp4" : IMAGE_EXTENSIONS[sniffImageMime(bytes) ?? ""] ?? ".png");
      }
      return url;
    }
    if (!this.registerMedia) return url;
    // A provider URL expires (or its tunnel goes away), so a copy that fails
    // is retried and then fails the step loudly instead of keeping the URL.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.copyProviderMedia(url, kind, providerBaseUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Cancellation and the operation deadline are not download errors.
        if (this.abortSignal?.aborted || /exceeded its deadline|aborted: run cancelled/.test(message)) throw error;
        if (attempt >= 3) {
          throw new Error(
            `生成的${kind === "image" ? "图片" : "视频"}没能存到本地（已重试 3 次：${message.slice(0, 160)}），这一步算失败，点继续会重新生成`,
          );
        }
        console.warn(`media: local copy of ${kind} failed (attempt ${attempt}/3): ${message.slice(0, 200)}`);
        await this.wait(1000 * attempt);
      }
    }
  }

  private async copyProviderMedia(url: string, kind: "image" | "video", providerBaseUrl: string): Promise<string> {
    let tempDir: string | null = null;
    try {
      tempDir = mkdtempSync(join(this.managedMediaDirectory(), `.${kind}-`));
      const destination = join(tempDir, "download");
      const sameHost = sameOrigin(url, providerBaseUrl);
      const maxBytes = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (sameHost || (await resolvesOnlyToFakeIp(url))) {
        await this.downloadTrusted(url, destination, maxBytes);
      } else {
        await downloadPublicMedia(url, destination, Date.now() + MAX_DOWNLOAD_MS, 0, this.abortSignal ?? undefined, maxBytes);
      }
      this.throwIfAborted();
      let extension = ".mp4";
      if (kind === "image") {
        const head = readFileSync(destination).subarray(0, 512);
        const mime = sniffImageMime(head);
        if (!mime) throw new Error("downloaded file is not an image");
        extension = IMAGE_EXTENSIONS[mime] ?? ".png";
      }
      return this.publishManagedFile(destination, extension);
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private persistBytes(bytes: Buffer, extension: string): string {
    if (!this.registerMedia) {
      // No execution fence (direct service use): hand the bytes back inline.
      const mime = sniffImageMime(bytes) ?? (extension === ".mp4" ? "video/mp4" : "image/png");
      return `data:${mime};base64,${bytes.toString("base64")}`;
    }
    const tempDir = mkdtempSync(join(this.managedMediaDirectory(), ".inline-"));
    try {
      const destination = join(tempDir, `file${extension}`);
      writeFileSync(destination, bytes, { flag: "wx" });
      return this.publishManagedFile(destination, extension);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async downloadTrusted(url: string, destination: string, maxBytes: number): Promise<void> {
    const timeout = AbortSignal.timeout(MAX_DOWNLOAD_MS);
    const signal = this.abortSignal ? AbortSignal.any([this.abortSignal, timeout]) : timeout;
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`media download failed: ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("media exceeds download size limit");
    let bytes = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) source.destroy(new Error("media exceeds download size limit"));
    });
    await pipeline(source, createWriteStream(destination, { flags: "wx" }));
  }

  async generateVideoUrl(args: {
    prompt: string;
    imageUrl?: string | null;
    duration?: number;
    negativePrompt?: string;
  }): Promise<string> {
    return withAiActivity(this.operation ?? undefined, "视频生成", () =>
      withProviderSpan(
        "gen_ai.video.generate",
        this.providerSpanAttributes("video", this.settings.videoProvider, this.settings.videoModel),
        () => this.generateVideoUrlInner(args),
      ),
    );
  }

  private async generateVideoUrlInner(args: {
    prompt: string;
    imageUrl?: string | null;
    duration?: number;
    negativePrompt?: string;
  }): Promise<string> {
    const { prompt } = args;
    if (this.settings.fakeVideoFixtureUrl) return this.settings.fakeVideoFixtureUrl;

    if (this.settings.videoProvider === "fake") {
      if (this.settings.fakeVideoFixturePath) {
        const source = resolve(this.settings.fakeVideoFixturePath);
        if (!existsSync(source)) {
          throw new Error(`Fake video fixture file not found: ${source}`);
        }
        return this.publishManagedFile(source, ".mp4");
      }
      return this.ensureDefaultFakeClip(prompt, args.duration);
    }

    if (this.settings.videoProvider === "doubao") {
      if (!this.settings.doubaoApiKey) throw new Error("DOUBAO_API_KEY is required");
      this.throwIfAborted();
      const payload: Record<string, unknown> = {
        model: this.settings.doubaoVideoModel,
        content: [{ type: "text", text: prompt }],
        duration: normalizeVideoDuration("doubao", args.duration ?? this.settings.doubaoVideoDuration),
        ratio: this.settings.doubaoVideoRatio,
      };
      if (args.imageUrl && this.settings.enableImageToVideo) {
        const imageUrl = await this.videoImageUrl(args.imageUrl);
        (payload.content as unknown[]).push({
          type: "image_url",
          image_url: { url: imageUrl },
        });
      }
      const createResponse = await fetch(
        "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
        this.requestInit({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.settings.doubaoApiKey}`,
            ...this.idempotencyHeaders(),
          },
          body: JSON.stringify(payload),
        }),
      );
      if (!createResponse.ok) {
        throw new Error(`doubao create failed: ${createResponse.status}`);
      }
      const created = (await createResponse.json()) as Record<string, unknown>;
      const taskId = String(created.id ?? "");
      if (!taskId) throw new Error("doubao returned no task id");
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await this.wait(2000);
        const poll = await fetch(
          `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${taskId}`,
          this.requestInit({
            headers: { Authorization: `Bearer ${this.settings.doubaoApiKey}` },
          }),
        );
        if (!poll.ok) throw new Error(`doubao poll failed: ${poll.status}`);
        const state = (await poll.json()) as Record<string, unknown>;
        const status = String(state.status ?? "");
        if (status === "succeeded") {
          const content = state.content as Record<string, unknown> | undefined;
          const videoUrl =
            content && typeof content.video_url === "string" ? content.video_url : null;
          if (!videoUrl) throw new Error("doubao returned no video URL");
          return this.persistProviderMedia(videoUrl, "video", "https://ark.cn-beijing.volces.com");
        }
        if (["failed", "cancelled"].includes(status)) {
          throw new Error(`doubao task ${status}: ${String(state.error ?? "unknown")}`);
        }
      }
      throw new Error("doubao video generation timed out");
    }

    const adapter = VIDEO_JOB_ADAPTERS[this.settings.videoProvider];
    if (adapter) return this.generateVendorVideo(adapter, args);

    if (!this.settings.videoApiKey) throw new Error("VIDEO_API_KEY is required");
    this.throwIfAborted();
    const endpoint = joinEndpoint(this.settings.videoBaseUrl, this.settings.videoEndpoint);
    const payload: Record<string, unknown> = {
      model: this.settings.videoModel,
      prompt,
      duration:
        args.duration === undefined ? undefined : normalizeVideoDuration("openai", args.duration),
    };
    if (args.imageUrl && this.settings.enableImageToVideo) {
      payload.image_url = await this.videoImageUrl(args.imageUrl);
    }
    const response = await this.postProvider(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.videoApiKey}`,
        ...this.idempotencyHeaders(),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`video provider failed: ${response.status}`);
    let body = (await response.json()) as Record<string, unknown>;
    let url = extractMediaUrl(body);
    const taskId = extractTaskId(body);
    if (!url && taskId && VIDEO_TASK_PENDING.has(String(body.status ?? "").toLowerCase())) {
      body = await this.pollVideoTask(taskId);
      url = extractMediaUrl(body);
    }
    if (!url) throw new Error("video provider returned no URL");
    return this.persistProviderMedia(
      this.providerMediaUrl(url, this.settings.videoBaseUrl),
      "video",
      this.settings.videoBaseUrl,
    );
  }

  /**
   * Vendor-native async video (Kling, Vidu, CogVideoX, MiniMax, Wan, Veo):
   * the adapter shapes submit / poll, the runner owns pacing, backoff,
   * timeout and cancellation; the result is stored locally (public-address
   * check for foreign hosts) or written from inline bytes.
   */
  private async generateVendorVideo(
    adapter: VideoJobAdapter,
    args: { prompt: string; imageUrl?: string | null; duration?: number; negativePrompt?: string },
  ): Promise<string> {
    const apiKey = this.settings.videoApiKey;
    if (!apiKey) throw new Error(`${adapter.label}需要 VIDEO_API_KEY`);
    const baseUrl = this.settings.videoBaseUrl;
    const model = this.settings.videoModel;
    const image = args.imageUrl && this.settings.enableImageToVideo ? await this.videoImageUrl(args.imageUrl) : null;
    const result = await runVideoJob(
      adapter,
      {
        baseUrl,
        apiKey,
        post: (url, init) =>
          this.postProvider(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...this.idempotencyHeaders() } }),
        request: (url, init = {}) => fetch(url, this.requestInit(init)),
      },
      {
        model,
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        image,
        duration: normalizeVideoDuration(adapter.id, args.duration ?? 5, model),
        ratio: this.settings.videoRatio,
      },
      {
        pollMs: videoTaskPollMs(),
        maxWaitMs: VIDEO_TASK_MAX_WAIT_MS,
        wait: (ms) => this.wait(ms),
        throwIfAborted: () => this.throwIfAborted(),
        isAborted: () => Boolean(this.abortSignal?.aborted),
      },
    );
    if ("bytes" in result) return this.persistBytes(result.bytes, ".mp4");
    return this.persistProviderMedia(result.url, "video", baseUrl);
  }

  /**
   * ModelScope async image task: GET {base}/v1/tasks/{id} with the
   * image_generation task-type header until task_status is SUCCEED / FAILED
   * (same contract as the Python backend's _modelscope_generate).
   */
  private async pollModelScopeImage(taskId: string): Promise<string> {
    const pollUrl = modelScopeTaskUrl(this.settings.imageBaseUrl, taskId);
    const deadline = Date.now() + IMAGE_TASK_MAX_WAIT_MS;
    let failures = 0;
    while (Date.now() < deadline) {
      await this.wait(imageTaskPollMs());
      this.throwIfAborted();
      let poll: Response;
      try {
        poll = await fetch(
          pollUrl,
          this.requestInit({
            headers: {
              Authorization: `Bearer ${this.settings.imageApiKey}`,
              "X-ModelScope-Task-Type": "image_generation",
            },
          }),
        );
      } catch (error) {
        if (this.abortSignal?.aborted) throw error;
        if (++failures >= 5) throw error;
        continue;
      }
      if (!poll.ok) {
        if (poll.status >= 500 && ++failures < 5) continue;
        throw new Error(`image task poll failed: ${poll.status}`);
      }
      failures = 0;
      const state = (await poll.json()) as Record<string, unknown>;
      const status = String(state.task_status ?? "").toUpperCase();
      if (status === "SUCCEED") {
        const images = Array.isArray(state.output_images) ? state.output_images : [];
        const first = images[0];
        if (typeof first === "string" && first) return first;
        throw new Error("image task succeeded without output_images");
      }
      if (status === "FAILED") {
        const errors = state.errors;
        const detail =
          errors && typeof errors === "object"
            ? String((errors as Record<string, unknown>).message ?? JSON.stringify(errors))
            : String(errors ?? "unknown");
        throw new Error(`image task failed: ${detail.slice(0, 200)}`);
      }
    }
    throw new Error("image task timed out");
  }

  /** Poll an async OpenAI-compatible video task until it finishes. */
  private async pollVideoTask(taskId: string): Promise<Record<string, unknown>> {
    const candidates = videoTaskPollUrls(this.settings.videoBaseUrl, this.settings.videoEndpoint, taskId);
    let candidate = 0;
    let failures = 0;
    const deadline = Date.now() + VIDEO_TASK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await this.wait(videoTaskPollMs());
      this.throwIfAborted();
      const pollUrl = candidates[candidate]!;
      let poll: Response;
      try {
        poll = await fetch(
          pollUrl,
          this.requestInit({ headers: { Authorization: `Bearer ${this.settings.videoApiKey}` } }),
        );
      } catch (error) {
        if (this.abortSignal?.aborted) throw error;
        if (++failures >= 5) throw error;
        continue;
      }
      if ((poll.status === 404 || poll.status === 405) && candidate < candidates.length - 1) {
        candidate += 1;
        continue;
      }
      if (!poll.ok) {
        if (poll.status >= 500 && ++failures < 5) continue;
        throw new Error(`video task poll failed: ${poll.status}`);
      }
      failures = 0;
      const state = (await poll.json()) as Record<string, unknown>;
      const status = String(state.status ?? "").toLowerCase();
      if (VIDEO_TASK_DONE.has(status)) return state;
      if (VIDEO_TASK_FAILED.has(status)) {
        const error = state.error;
        const detail =
          error && typeof error === "object"
            ? String((error as Record<string, unknown>).message ?? JSON.stringify(error))
            : String(error ?? "unknown");
        throw new Error(`video task ${status}: ${detail}`);
      }
      if (!VIDEO_TASK_PENDING.has(status) && extractMediaUrl(state)) return state;
    }
    throw new Error(`video task ${taskId} timed out`);
  }

  /**
   * The reference frame goes to the provider inline whenever we can read it:
   * a `/static` file is not reachable from the provider at all, and a remote
   * URL (often the image provider's own media URL, served as octet-stream)
   * may be rejected by a different provider. The MIME type is sniffed so a
   * webp is not labelled png.
   */
  private async videoImageUrl(url: string): Promise<string> {
    if (url.startsWith("data:image/")) return url;
    const local = url.startsWith("/static/");
    if (local && !this.settings.videoInlineLocalImages) {
      return this.settings.publicBaseUrl ? new URL(url, this.settings.publicBaseUrl).toString() : url;
    }
    try {
      const bytes = await this.readImageBytes(url);
      return `data:${sniffImageMime(bytes) ?? "image/png"};base64,${bytes.toString("base64")}`;
    } catch (error) {
      if (local || this.abortSignal?.aborted) throw error;
      return url;
    }
  }

  private async ensureDefaultFakeClip(prompt: string, durationArg?: number): Promise<string> {
    if (!this.registerMedia) throw new Error("managed media registration requires an execution fence");
    const tempDir = mkdtempSync(join(this.managedMediaDirectory(), ".fake-video-"));
    const destination = join(tempDir, "output.mp4");

    const digest = parseInt(createHash("sha1").update(prompt).digest("hex").slice(0, 8), 16);
    const color = FAKE_VIDEO_COLORS[digest % FAKE_VIDEO_COLORS.length] ?? "0x111827";
    const label = promptLabel(prompt).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
    const duration = Math.max(1, Math.min(durationArg ?? 2, 10));
    const command = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=960x540:d=${duration}`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf",
      [
        "drawtext=text='Fake Video':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=150",
        `drawtext=text='${label}':fontcolor=white@0.82:fontsize=24:x=(w-text_w)/2:y=315`,
        "drawtext=text='no external API call':fontcolor=white@0.62:fontsize=22:x=(w-text_w)/2:y=370",
      ].join(","),
      "-shortest",
      "-c:v",
      "libx264",
      "-t",
      String(duration),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      destination,
    ];
    try {
      try {
        await execFileAsync("ffmpeg", command, { signal: this.abortSignal ?? undefined });
      } catch (error) {
        if (this.abortSignal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Fake video provider needs ffmpeg: ${message.slice(0, 300)}`);
      }
      if (this.abortSignal?.aborted) throw new Error("run cancelled");
      return this.publishManagedFile(destination, ".mp4");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async mergeVideos(videoUrls: string[]): Promise<string> {
    if (videoUrls.length === 0) throw new Error("No video URLs provided");
    const outputDir = join(this.settings.staticDir, "videos");
    mkdirSync(outputDir, { recursive: true });
    const tempDir = mkdtempSync(join(outputDir, ".merge-"));
    const tempOutput = join(tempDir, "output.mp4");
    const downloadDeadline = Date.now() + MAX_DOWNLOAD_MS;
    let downloadedBytes = 0;
    try {
      const localPaths: string[] = [];
      for (let i = 0; i < videoUrls.length; i++) {
        const url = videoUrls[i]!;
        const localPath = this.localPathFor(url);
        if (localPath) {
          if (!existsSync(localPath)) throw new Error("Local video file is missing");
          localPaths.push(localPath);
        } else {
          const dest = join(tempDir, `video_${i}.mp4`);
          downloadedBytes += await downloadPublicVideo(url, dest, downloadDeadline, downloadedBytes, this.abortSignal ?? undefined);
          localPaths.push(dest);
        }
      }
      if (this.abortSignal?.aborted) throw new Error("run cancelled");
      if (localPaths.length === 1) {
        copyFileSync(localPaths[0]!, tempOutput);
      } else {
        const concatFile = join(tempDir, "concat.txt");
        writeFileSync(concatFile, localPaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n", "utf8");
        try {
          await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", tempOutput], { signal: this.abortSignal ?? undefined });
        } catch (error) {
          if (this.abortSignal?.aborted) throw error;
          await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tempOutput], { signal: this.abortSignal ?? undefined });
        }
      }
      if (this.abortSignal?.aborted) throw new Error("run cancelled");
      return this.publishManagedFile(tempOutput, ".mp4");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Duration in seconds of a local media file (clip or voice track); null when unknown. */
  async mediaDuration(url: string | null | undefined): Promise<number | null> {
    if (!url) return null;
    const path = this.localPathFor(url);
    if (!path || !existsSync(path)) return null;
    try {
      const probe = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        { signal: this.abortSignal ?? undefined },
      );
      const duration = Number(String(probe.stdout).trim());
      return Number.isFinite(duration) && duration > 0 ? duration : null;
    } catch (error) {
      if (this.abortSignal?.aborted) throw error;
      return null;
    }
  }

  /**
   * Add script subtitles to the merged film. soft = a mov_text track players can
   * switch off; burn = rendered into the picture with libass (brand font, safe
   * area). Also publishes the .srt. Returns null when there is nothing to add.
   */
  async addSubtitles(
    videoUrl: string,
    segments: SubtitleSegment[],
    mode: SubtitleMode,
    font: string,
  ): Promise<{ videoUrl: string; srtUrl: string; cues: number } | null> {
    if (mode === "off") return null;
    const source = this.localPathFor(videoUrl);
    if (!source || !existsSync(source)) throw new Error("字幕：找不到本地成片文件");
    const signal = this.abortSignal ?? undefined;
    const probe = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", source],
      { signal },
    );
    const [width, height] = String(probe.stdout).trim().split("x").map(Number);
    if (!width || !height) throw new Error("字幕：读不到画面尺寸");
    const { maxChars } = subtitleLayout(width, height);
    const cues = buildSubtitleCues(segments, maxChars);
    if (cues.length === 0) return null;
    const outputDir = join(this.settings.staticDir, "videos");
    mkdirSync(outputDir, { recursive: true });
    const dir = mkdtempSync(join(outputDir, ".subs-"));
    try {
      const srt = renderSrt(cues);
      const srtPath = join(dir, "subs.srt");
      writeFileSync(srtPath, srt, "utf8");
      const out = join(dir, "output.mp4");
      if (mode === "soft") {
        await execFileAsync(
          "ffmpeg",
          [
            "-v", "error", "-y", "-i", source, "-i", srtPath,
            "-map", "0:v", "-map", "0:a?", "-map", "1:0",
            "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
            "-metadata:s:s:0", "language=chi", "-metadata:s:s:0", "title=中文",
            "-movflags", "+faststart", out,
          ],
          { signal },
        );
      } else {
        const assPath = join(dir, "subs.ass");
        writeFileSync(assPath, renderAss(cues, width, height, font), "utf8");
        await execFileAsync(
          "ffmpeg",
          [
            "-v", "error", "-y", "-i", source,
            "-vf", `ass=${assPath}`,
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "copy", "-movflags", "+faststart", out,
          ],
          { signal },
        );
      }
      if (this.abortSignal?.aborted) throw new Error("run cancelled");
      const srtUrl = this.writeManagedFile(srt, ".srt");
      return { videoUrl: this.publishManagedFile(out, ".mp4"), srtUrl, cues: cues.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Lay one background track under the whole film: loop or trim to length, fade in
   * and out, and (ducking) compress it whenever a voice line plays. The sidechain is
   * the voice tracks placed at their offsets; without them, the film's own audio.
   */
  async addBackgroundMusic(
    videoUrl: string,
    trackUrl: string,
    voices: Array<{ url: string; offset: number }>,
    volume: number,
    ducking: boolean,
  ): Promise<string> {
    const source = this.localPathFor(videoUrl);
    if (!source || !existsSync(source)) throw new Error("背景音乐：找不到本地成片文件");
    const track = this.localPathFor(trackUrl);
    if (!track || !existsSync(track)) throw new Error("背景音乐：找不到曲目文件");
    const signal = this.abortSignal ?? undefined;
    const probe = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source],
      { signal },
    );
    const info = JSON.parse(String(probe.stdout)) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string };
    };
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("背景音乐：读不到成片时长");
    const hasAudio = (info.streams ?? []).some((stream) => stream.codec_type === "audio");
    const voiceFiles = voices
      .map((voice) => ({ path: this.localPathFor(voice.url), offset: voice.offset }))
      .filter((voice): voice is { path: string; offset: number } => Boolean(voice.path && existsSync(voice.path)));
    const d = duration.toFixed(3);
    const fadeOut = Math.max(0, duration - 2).toFixed(3);
    const gain = Math.max(0, Math.min(1, volume)).toFixed(3);
    const fmt = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo";
    const inputs = ["-i", source, "-stream_loop", "-1", "-i", track];
    const graph: string[] = [
      `[1:a]${fmt},atrim=0:${d},asetpts=N/SR/TB,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=2,volume=${gain}[bg]`,
    ];
    let sidechain: string | null = null;
    if (ducking && voiceFiles.length > 0) {
      const labels: string[] = [];
      voiceFiles.forEach((voice, i) => {
        inputs.push("-i", voice.path);
        const ms = Math.max(0, Math.round(voice.offset * 1000));
        graph.push(`[${i + 2}:a]${fmt},adelay=${ms}|${ms}[v${i}]`);
        labels.push(`[v${i}]`);
      });
      graph.push(
        `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad,atrim=0:${d}[sc]`,
      );
      sidechain = "[sc]";
    }
    if (hasAudio) {
      if (ducking && !sidechain) {
        graph.push(`[0:a]${fmt},apad,atrim=0:${d},asplit=2[main][sc]`);
        sidechain = "[sc]";
      } else {
        graph.push(`[0:a]${fmt},apad,atrim=0:${d}[main]`);
      }
    }
    let bed = "[bg]";
    if (sidechain) {
      graph.push(`[bg]${sidechain}sidechaincompress=threshold=0.02:ratio=10:attack=20:release=450[duck]`);
      bed = "[duck]";
    }
    if (hasAudio) {
      graph.push(`[main]${bed}amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
    } else {
      graph.push(`${bed}anull[aout]`);
    }
    const outputDir = join(this.settings.staticDir, "videos");
    mkdirSync(outputDir, { recursive: true });
    const dir = mkdtempSync(join(outputDir, ".bgm-"));
    try {
      const out = join(dir, "output.mp4");
      await execFileAsync(
        "ffmpeg",
        [
          "-v", "error", "-y", ...inputs,
          "-filter_complex", graph.join(";"),
          "-map", "0:v:0", "-map", "[aout]",
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", d,
          "-movflags", "+faststart", out,
        ],
        { signal, maxBuffer: 8 * 1024 * 1024 },
      );
      if (this.abortSignal?.aborted) throw new Error("run cancelled");
      return this.publishManagedFile(out, ".mp4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Images side by side at one height (PNG), e.g. cast sheet + previous keyframe. */
  async stackImages(images: Buffer[]): Promise<Buffer> {
    if (images.length === 1) return images[0]!;
    const dir = mkdtempSync(join(this.settings.staticDir, ".stack-"));
    try {
      const inputs = images.map((image, i) => {
        const path = join(dir, `${i}.img`);
        writeFileSync(path, image);
        return path;
      });
      const scaled = inputs.map((_, i) => `[${i}:v]scale=-2:768[s${i}]`).join(";");
      const labels = inputs.map((_, i) => `[s${i}]`).join("");
      const out = join(dir, "board.png");
      await execFileAsync(
        "ffmpeg",
        [
          "-v", "error", "-y",
          ...inputs.flatMap((path) => ["-i", path]),
          "-filter_complex", `${scaled};${labels}hstack=inputs=${inputs.length}`,
          "-frames:v", "1",
          out,
        ],
        { signal: this.abortSignal ?? undefined },
      );
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * First, middle and last frame of a local clip side by side in one PNG, so
   * the clip check costs one image instead of three.
   */
  async videoFrameStrip(url: string): Promise<Buffer | null> {
    const path = this.localPathFor(url);
    if (!path) return null;
    const signal = this.abortSignal ?? undefined;
    const probe = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { signal },
    );
    const duration = Number(String(probe.stdout).trim());
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const times = [Math.min(0.1, duration / 2), duration / 2, Math.max(0, duration - 0.15)];
    const dir = mkdtempSync(join(this.settings.staticDir, ".frames-"));
    try {
      const out = join(dir, "strip.png");
      await execFileAsync(
        "ffmpeg",
        [
          "-v", "error", "-y",
          ...times.flatMap((t) => ["-ss", t.toFixed(2), "-i", path]),
          "-filter_complex",
          "[0:v]scale=512:-2[a];[1:v]scale=512:-2[b];[2:v]scale=512:-2[c];[a][b][c]hstack=inputs=3",
          "-frames:v", "1",
          out,
        ],
        { signal },
      );
      return readFileSync(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  localPathFor(url: string): string | null {
    if (!url.startsWith("/static/")) return null;
    const root = realpathSync(this.settings.staticDir);
    const path = resolve(root, url.slice("/static/".length));
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Invalid local video path");
    const actual = realpathSync(path);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Invalid local video path");
    return actual;
  }
}

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const RETRYABLE_PROVIDER_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 530]);
const PROVIDER_MAX_RETRIES = 3;
/**
 * Backoff base for provider retries (waits base, 3×, 9×: 5 s / 15 s / 45 s), so
 * a gateway blip of up to about a minute does not fail the stage.
 * OPENOII_PROVIDER_RETRY_MS overrides it (tests).
 */
function providerRetryBaseMs(): number {
  const raw = Number(process.env.OPENOII_PROVIDER_RETRY_MS ?? 5_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

/** Async video task poll interval; OPENOII_VIDEO_POLL_MS overrides it (tests, slow providers). */
function videoTaskPollMs(): number {
  const raw = Number(process.env.OPENOII_VIDEO_POLL_MS ?? 5_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}
const VIDEO_TASK_MAX_WAIT_MS = 15 * 60_000;
/** ModelScope image task poll interval; OPENOII_IMAGE_POLL_MS overrides it (tests). */
function imageTaskPollMs(): number {
  const raw = Number(process.env.OPENOII_IMAGE_POLL_MS ?? 5_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}
const IMAGE_TASK_MAX_WAIT_MS = 5 * 60_000;

/** `{base}/v1/tasks/{id}` whether or not the configured base already ends in /v1. */
export function modelScopeTaskUrl(baseUrl: string, taskId: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${base}/v1/tasks/${encodeURIComponent(taskId)}`;
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
const MAX_VIDEO_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_MS = 120_000;

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes(".")) return false;
  const parts = address.toLowerCase().split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const words = parts.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const value = words.reduce((result, word) => (result << 16n) | BigInt(`0x${word || "0"}`), 0n);
  const inRange = (network: bigint, bits: number) => value >> BigInt(128 - bits) === network >> BigInt(128 - bits);
  return inRange(0x2000n << 112n, 3) && !inRange(0x2001n << 112n, 23) && !inRange(0x2001_0db8n << 96n, 32) && !inRange(0x2002n << 112n, 16) && !inRange(0x3fffn << 112n, 20);
}

/**
 * Whether a host resolves only into 198.18.0.0/15, the range fake-IP DNS
 * proxies (Clash, Surge, sandbox egress) hand out for public hosts. Such a
 * host fails the public-address guard although it is public, so generated
 * media was left on expiring provider URLs; it is fetched through the proxy
 * instead (images are still checked to be images before they are kept).
 */
async function resolvesOnlyToFakeIp(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname;
    if (!host || isIP(host)) return false;
    const addresses = await lookup(host, { all: true, verbatim: true });
    return (
      addresses.length > 0 &&
      addresses.every(({ address }) => {
        const [a, b] = address.split(".").map(Number);
        return isIP(address) === 4 && a === 198 && (b === 18 || b === 19);
      })
    );
  } catch {
    return false;
  }
}

async function downloadPublicVideo(url: string, destination: string, deadline: number, previouslyDownloaded: number, signal?: AbortSignal): Promise<number> {
  return downloadPublicMedia(url, destination, deadline, previouslyDownloaded, signal, MAX_VIDEO_BYTES);
}

async function downloadPublicMedia(url: string, destination: string, deadline: number, previouslyDownloaded: number, signal: AbortSignal | undefined, maxBytes: number): Promise<number> {
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if ((current.protocol !== "http:" && current.protocol !== "https:") || current.username || current.password) throw new Error("Video URL must be public HTTP or HTTPS");
    let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(current.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimeout = setTimeout(() => reject(new Error("Video DNS lookup timed out")), Math.max(1, Math.min(10_000, deadline - Date.now())));
      }),
    ]).finally(() => clearTimeout(dnsTimeout));
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error("Video URL must resolve only to public IP addresses");
    const pinned = addresses[0]!;
    const response = await new Promise<{ location?: string; bytes: number }>((resolveResponse, reject) => {
      if (signal?.aborted) return reject(new Error("run cancelled"));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error("Video download timed out"));
      const requestFn = current.protocol === "https:" ? httpsRequest : httpRequest;
      const req = requestFn(current, { signal, timeout: remaining, lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family) }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolveResponse({ location: res.headers.location, bytes: 0 });
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Video server returned HTTP ${res.statusCode ?? 0}`)); return; }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) { res.resume(); reject(new Error("Video exceeds download size limit")); return; }
        let bytes = 0;
        const out = createWriteStream(destination, { flags: "wx" });
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes || previouslyDownloaded + bytes > MAX_VIDEO_TOTAL_BYTES) res.destroy(new Error("Video exceeds download size limit"));
          else if (Date.now() > deadline) res.destroy(new Error("Video download timed out"));
        });
        res.pipe(out);
        out.once("finish", () => resolveResponse({ bytes }));
        out.once("error", reject);
        res.once("error", reject);
      });
      req.once("timeout", () => req.destroy(new Error("Video download timed out")));
      req.once("error", reject);
      req.end();
    });
    if (response.location) {
      if (redirects >= MAX_REDIRECTS) throw new Error("Too many video redirects");
      current = new URL(response.location, current);
      continue;
    }
    return response.bytes;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
