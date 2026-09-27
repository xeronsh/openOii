import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";

type PendingRequest = {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

export interface AudioResult {
  video_url: string;
  tts_url: string | null;
  bgm_type: string | null;
}

/** Reuse the backend's existing image, face, and audio helpers from Engine. */
export class BackendWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private pending: PendingRequest | null = null;
  private errors = "";
  private abort?: () => void;

  constructor(private readonly signal: AbortSignal) {}

  async faceEmbedding(image: Buffer): Promise<number[] | null> {
    const value = await this.request({
      action: "face_embedding",
      image: image.toString("base64"),
    });
    if (
      !Array.isArray(value) ||
      value.length !== 512 ||
      !value.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      return null;
    }
    return value as number[];
  }

  async characterReference(urls: string[]): Promise<Buffer> {
    return this.imageRequest({ action: "character_reference", urls });
  }

  async nineGridReference(args: {
    current: string;
    previous?: string | null;
    next?: string | null;
    characters: string[];
  }): Promise<Buffer> {
    return this.imageRequest({ action: "nine_grid_reference", ...args });
  }

  async processAudio(args: {
    video_url: string;
    dialogue: string | null;
    speaker: { name: string; description: string | null } | null;
    scene: string | null;
    expression: string | null;
    genre: string | null;
    settings: {
      text_provider: string;
      image_provider: string;
      video_provider: string;
      tts_enabled: boolean;
      tts_default_voice: string;
      tts_volume: number;
      bgm_enabled: boolean;
      bgm_volume: number;
      bgm_directory: string;
    };
  }): Promise<AudioResult> {
    const value = await this.request({ action: "process_audio", ...args });
    if (!value || typeof value !== "object") throw new Error("invalid audio result");
    const result = value as Partial<AudioResult>;
    if (typeof result.video_url !== "string") throw new Error("audio result has no video URL");
    return {
      video_url: result.video_url,
      tts_url: typeof result.tts_url === "string" ? result.tts_url : null,
      bgm_type: typeof result.bgm_type === "string" ? result.bgm_type : null,
    };
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
      child.stdin.end();
    });
  }

  private async imageRequest(request: Record<string, unknown>): Promise<Buffer> {
    const value = await this.request(request);
    if (typeof value !== "string") throw new Error("invalid image composition result");
    return Buffer.from(value, "base64");
  }

  private async request(request: Record<string, unknown>): Promise<unknown> {
    const child = this.start();
    const line = await new Promise<string>((resolveLine, reject) => {
      this.pending = { resolve: resolveLine, reject };
      child.stdin.write(`${JSON.stringify(request)}\n`, (error?: Error | null) => {
        if (error) this.fail(error);
      });
    });
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && "error" in value) {
      throw new Error(String((value as { error: unknown }).error));
    }
    return value;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.signal.aborted) throw new Error("backend worker cancelled");

    const python = process.env.ENGINE_PYTHON ?? "python";
    const cwd = process.env.ENGINE_BACKEND_DIR ?? resolve(process.cwd(), "../backend");
    const child = spawn(python, ["-m", "app.services.engine_media_cli"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.errors = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.errors = `${this.errors}${chunk}`.slice(-4000);
    });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      pending.resolve(line);
    });
    this.abort = () => {
      if (process.platform === "win32" || !child.pid) {
        child.kill("SIGTERM");
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    this.signal.addEventListener("abort", this.abort, { once: true });
    if (this.signal.aborted) this.abort();
    child.once("error", (error) => this.fail(error));
    child.once("close", (code) => this.fail(new Error(`backend worker exited ${code}: ${this.errors}`)));
    return child;
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.lines?.close();
    this.lines = null;
    this.child = null;
    if (this.abort) this.signal.removeEventListener("abort", this.abort);
    this.abort = undefined;
  }
}
