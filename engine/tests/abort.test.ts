import { describe, expect, it, vi } from "vitest";
import { MediaService, type MediaSettings } from "../src/media/media.js";

function settings(overrides: Partial<MediaSettings>): MediaSettings {
  return {
    staticDir: "/tmp/openoii-abort-test",
    imageProvider: "openai",
    imageApiKey: "test-key",
    imageBaseUrl: "https://example.test",
    imageEndpoint: "/v1/images",
    imageModel: "test-model",
    enableImageToImage: false,
    fakeImageFixtureUrl: null,
    videoProvider: "openai",
    videoApiKey: "test-key",
    videoBaseUrl: "https://example.test",
    videoEndpoint: "/v1/videos",
    videoModel: "test-model",
    enableImageToVideo: false,
    videoMode: "auto",
    fakeVideoFixtureUrl: null,
    fakeVideoFixturePath: null,
    doubaoApiKey: null,
    doubaoVideoModel: "doubao-test",
    doubaoVideoDuration: 5,
    doubaoVideoRatio: "16:9",
    ttsEnabled: false,
    bgmEnabled: false,
    ...overrides,
  };
}

describe("provider cancellation", () => {
  it("aborts an in-flight image request instead of letting it finish", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        observedSignal = init?.signal;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("run cancelled: provider request aborted")),
          );
        });
      }),
    );

    const media = new MediaService(settings({}));
    media.setAbortSignal(controller.signal);

    const pending = media.generateImageUrl({ prompt: "a lighthouse at dawn" });
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(observedSignal).toBe(controller.signal);
    vi.unstubAllGlobals();
  });

  it("refuses to start provider work once the run is cancelled", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const media = new MediaService(settings({}));
    media.setAbortSignal(controller.signal);
    controller.abort();

    await expect(media.generateImageUrl({ prompt: "never sent" })).rejects.toThrow(/cancelled/);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("aborts a provider backoff wait instead of sleeping through it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "task-1" }),
        } as unknown as Response),
      ),
    );

    const media = new MediaService(
      settings({
        videoProvider: "doubao",
        doubaoApiKey: "test-key",
      }),
    );
    media.setAbortSignal(controller.signal);

    // The doubao path creates a task, then waits 2s before its first poll.
    const pending = media.generateVideoUrl({ prompt: "clip" });
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/cancelled/);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
