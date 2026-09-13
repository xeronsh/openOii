import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("~/utils/toast", () => ({ toast: toastMock }));
vi.mock("~/utils/runtimeBase", () => ({ getWsBase: () => "ws://example.test", getApiBase: () => "http://example.test" }));

import { useEditorStore } from "~/stores/editorStore";
import { applyWsEvent, useProjectWebSocket } from "~/hooks/useWebSocket";
import type { WsEvent } from "~/types";

const noopAutoConfirm = vi.fn();

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: null | (() => void) = null;
  onmessage: null | ((event: MessageEvent<string>) => void) = null;
  onerror: null | ((event: Event) => void) = null;
  onclose: null | ((event: Event) => void) = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

function shotForWs(id: number, order: number) {
  return {
    id,
    project_id: 1,
    order,
    description: `shot ${order}`,
    prompt: null,
    image_prompt: null,
    image_url: null,
    video_url: null,
    duration: null,
    camera: null,
    motion_note: null,
    scene: null,
    action: null,
    expression: null,
    lighting: null,
    dialogue: null,
    sfx: null,
    seed: null,
    character_ids: [],
    approval_state: "draft",
    approval_version: 0,
    approved_at: null,
    approved_description: null,
    approved_prompt: null,
    approved_image_prompt: null,
    approved_duration: null,
    approved_camera: null,
    approved_motion_note: null,
    approved_scene: null,
    approved_action: null,
    approved_expression: null,
    approved_lighting: null,
    approved_dialogue: null,
    approved_sfx: null,
    approved_character_ids: [],
  };
}

describe("useProjectWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.getState().reset();
    toastMock.success.mockClear();
    toastMock.warning.mockClear();
    toastMock.error.mockClear();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips connecting and sending when projectId is empty", () => {
    const { result } = renderHook(() => useProjectWebSocket(null));

    expect(MockWebSocket.instances).toHaveLength(0);

    act(() => {
      result.current.send({ ping: true });
      result.current.disconnect();
      result.current.reconnect();
    });

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("sends when open, closes and reconnects with the same project", () => {
    const { result } = renderHook(() => useProjectWebSocket(9));
    const ws = MockWebSocket.instances[0];

    act(() => {
      result.current.send({ hello: "world" });
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }));

    act(() => {
      result.current.disconnect();
    });

    expect(ws.close).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reconnect();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe("ws://example.test/ws/projects/9");
  });

  it("retries after close and reports reconnect success", () => {
    renderHook(() => useProjectWebSocket(11));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onclose?.(new Event("close"));
      vi.advanceTimersByTime(3000);
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "连接中断",
        duration: 3000,
      })
    );

    act(() => {
      MockWebSocket.instances[1].onopen?.();
    });

    expect(toastMock.success).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "重新连接成功",
      })
    );
  });

  it("shows connection error and exposes reconnect action", () => {
    renderHook(() => useProjectWebSocket(12));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onerror?.(new Event("error"));
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "无法连接到服务器",
        duration: 0,
        actions: expect.arrayContaining([
          expect.objectContaining({ label: "重新连接" }),
        ]),
      })
    );

    const action = toastMock.error.mock.calls[0]?.[0]?.actions?.[0];
    act(() => {
      action?.onClick();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("does not send when socket is not open", () => {
    const { result } = renderHook(() => useProjectWebSocket(13));
    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.CLOSED;

    act(() => {
      result.current.send({ ping: true });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("switches project id and creates a new websocket instance for new project", () => {
    const { rerender } = renderHook(({ projectId }) => useProjectWebSocket(projectId), {
      initialProps: { projectId: 21 },
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const firstSocket = MockWebSocket.instances[0];

    rerender({ projectId: 22 });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(firstSocket.url).toBe("ws://example.test/ws/projects/21");
    expect(MockWebSocket.instances[1].url).toBe("ws://example.test/ws/projects/22");
  });

  it("stops auto-reconnect at boundary and shows final failure toast", () => {
    renderHook(() => useProjectWebSocket(31));

    for (let i = 0; i < 6; i++) {
      const activeWs = MockWebSocket.instances.at(-1);
      act(() => {
        activeWs?.onclose?.(new Event("close"));
        vi.advanceTimersByTime(3000);
      });
    }

    expect(toastMock.warning).toHaveBeenCalledTimes(5);
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "连接失败",
      })
    );
    expect(MockWebSocket.instances).toHaveLength(6);
  });

  it("invokes reload action after connection failure", () => {
    const locationReloadMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      reload: locationReloadMock,
    } as unknown as Location);

    renderHook(() => useProjectWebSocket(32));

    for (let i = 0; i < 6; i++) {
      const activeWs = MockWebSocket.instances.at(-1);
      act(() => {
        activeWs?.onclose?.(new Event("close"));
        vi.advanceTimersByTime(3000);
      });
    }

    const action = toastMock.error.mock.calls.at(-1)?.[0]?.actions?.[0];
    act(() => {
      action?.onClick();
    });

    expect(locationReloadMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("replaces transient batch progress messages while run is active", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setMessages([
      {
        id: "old-progress",
        agent: "compose",
        role: "assistant",
        content: "正在生成视频 1/6...",
        isLoading: false,
      },
      {
        id: "stable-result",
        agent: "compose",
        role: "assistant",
        content: "漫剧制作完成！6 个分镜已拼接为完整视频。",
      },
    ]);

    applyWsEvent(
      {
        type: "run_message",
        data: {
          agent: "compose",
          role: "assistant",
          content: "正在生成视频 2/6...",
          isLoading: true,
        },
      } as never,
      store,
      noopAutoConfirm
    );

    const messages = useEditorStore.getState().messages;
    expect(messages.map((message) => message.content)).toEqual([
      "漫剧制作完成！6 个分镜已拼接为完整视频。",
      "正在生成视频 2/6...",
    ]);
  });

  it("removes transient batch progress messages after run completes", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setMessages([
      {
        id: "start-videos",
        agent: "compose",
        role: "assistant",
        content: "开始生成 6 个分镜生成视频（图生视频）...",
        isLoading: false,
      },
      {
        id: "progress-video",
        agent: "compose",
        role: "assistant",
        content: "正在生成视频 6/6...",
        isLoading: false,
      },
      {
        id: "merge-videos",
        agent: "compose",
        role: "assistant",
        content: "开始拼接 6 个分镜视频...",
        isLoading: false,
      },
      {
        id: "result",
        agent: "compose",
        role: "assistant",
        content: "漫剧制作完成！6 个分镜已拼接为完整视频。",
      },
    ]);

    applyWsEvent(
      {
        type: "run_completed",
        data: { current_stage: "compose" } as never,
      },
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().messages.map((message) => message.content)).toEqual([
      "漫剧制作完成！6 个分镜已拼接为完整视频。",
    ]);
  });

  it("clears loading messages when next run message arrives", () => {
    const initialStore = useEditorStore.getState();

    initialStore.reset();
    initialStore.setMessages([
      {
        id: "m-loading-plan",
        agent: "plan",
        role: "assistant",
        content: "waiting",
        isLoading: true,
      },
      {
        id: "m-loading-designer",
        agent: "designer",
        role: "assistant",
        content: "other loading",
        isLoading: true,
      },
      {
        id: "m-idle",
        agent: "plan",
        role: "assistant",
        content: "already done",
        isLoading: false,
      },
    ]);

    const store = useEditorStore.getState();
    const setMessagesSpy = vi.spyOn(store, "setMessages");

    applyWsEvent(
      {
        type: "run_message",
        data: {
          agent: "plan",
          role: "assistant",
          content: "plan new message",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(setMessagesSpy).toHaveBeenCalledTimes(1);
    const updatedMessages = setMessagesSpy.mock.calls.at(-1)?.[0] ?? [];
    const latestMessages = useEditorStore.getState().messages;

    expect(updatedMessages.at(0)).toMatchObject({
      id: "m-loading-plan",
      isLoading: false,
    });
    expect(updatedMessages.at(1)).toMatchObject({
      id: "m-loading-designer",
      isLoading: true,
    });
    expect(updatedMessages.at(2)).toMatchObject({
      id: "m-idle",
      isLoading: false,
    });
    expect(latestMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "plan new message",
      agent: "plan",
    });
  });

  it("maps websocket events and handles invalid message payloads", () => {
    renderHook(() => useProjectWebSocket(41));
    const ws = MockWebSocket.instances[0];

    const store = useEditorStore.getState();
    const setGeneratingSpy = vi.spyOn(store, "setGenerating");
    const setCurrentRunIdSpy = vi.spyOn(store, "setCurrentRunId");
    const addMessageSpy = vi.spyOn(store, "addMessage");

    const runStarted: WsEvent = {
      type: "run_started",
      data: {
        run_id: 101,
        stage: "plan",
        recovery_summary: { test: "summary" } as never,
      },
    };

    const runProgress: WsEvent = {
      type: "run_progress",
      data: {
        current_agent: "plan",
        progress: 0.42,
        stage: "character",
      },
    };

    const runMessage: WsEvent = {
      type: "run_message",
      data: {
        agent: "plan",
        role: "assistant",
        content: "分镜生成中",
        progress: 0.5,
        isLoading: true,
      },
    };

    act(() => {
      ws.onmessage?.({ data: JSON.stringify(runStarted) } as MessageEvent<string>);
      ws.onmessage?.({ data: JSON.stringify(runProgress) } as MessageEvent<string>);
      ws.onmessage?.({ data: JSON.stringify(runMessage) } as MessageEvent<string>);
      ws.onmessage?.({ data: "not-json" } as MessageEvent<string>);
    });

    expect(setGeneratingSpy).toHaveBeenCalledWith(true);
    expect(setCurrentRunIdSpy).toHaveBeenCalledWith(101);
    expect(addMessageSpy).toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "数据格式错误",
      })
    );
  });

  it("stores run_started provider snapshot into editor state", () => {
	const store = useEditorStore.getState();

	store.reset();

	applyWsEvent(
		{
			type: "run_started",
			data: {
				run_id: 101,
				provider_snapshot: {
					text: {
						selected_key: "openai",
						source: "project",
						resolved_key: "openai",
						valid: true,
						reason_code: null,
						reason_message: null,
					},
					image: {
						selected_key: "openai",
						source: "default",
						resolved_key: null,
						valid: false,
						reason_code: "provider_missing_credentials",
						reason_message: "缺少 OpenAI 图像凭据",
					},
					video: {
						selected_key: "doubao",
						source: "project",
						resolved_key: "doubao",
						valid: true,
						reason_code: null,
						reason_message: null,
					},
				},
			},
		} as never,
		store,
      noopAutoConfirm
	);

	expect(useEditorStore.getState().currentRunProviderSnapshot).toMatchObject({
		text: {
			selected_key: "openai",
		},
		image: {
			source: "default",
		},
		video: {
			resolved_key: "doubao",
		},
	});
	});

  it("asserts run_awaiting_confirm and run_confirmed state transitions", () => {
    const store = useEditorStore.getState();

    store.reset();

    applyWsEvent(
      {
        type: "run_awaiting_confirm",
        data: {
          agent: "plan",
          run_id: 202,
          message: "请确认",
          stage: "render",
          recovery_summary: { test: true } as never,
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState()).toMatchObject({
      awaitingConfirm: true,
      awaitingAgent: "plan",
      currentRunId: 202,
      recoveryGate: {
        agent: "plan",
        run_id: 202,
      },
      currentStage: "render",
    });

    expect(useEditorStore.getState().recoverySummary).toMatchObject({ test: true });
    expect(useEditorStore.getState().messages.at(-1)).toMatchObject({
      role: "info",
      agent: "system",
      content: "请确认",
    });

    applyWsEvent(
      {
        type: "run_confirmed",
        data: {
          agent: "plan",
          run_id: 202,
          stage: "compose",
          recovery_summary: { updated: true } as never,
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().awaitingConfirm).toBe(false);
    expect(useEditorStore.getState().recoveryGate).toBeNull();
    expect(useEditorStore.getState().currentStage).toBe("compose");
    expect(useEditorStore.getState().recoverySummary).toEqual({ updated: true });
    expect(useEditorStore.getState().messages.at(-1)).toMatchObject({
      role: "info",
      content: "已确认，继续执行...",
    });
  });

  it("auto_mode awaiting_confirm skips autoConfirm callback", () => {
    const store = useEditorStore.getState();
    store.reset();

    const autoConfirmSpy = vi.fn();

    applyWsEvent(
      {
        type: "run_awaiting_confirm",
        data: {
          agent: "plan",
          run_id: 303,
          message: "auto confirm",
          stage: "render",
          recovery_summary: { test: true } as never,
          auto_mode: true,
        },
      } as never,
      store,
      autoConfirmSpy
    );

    expect(autoConfirmSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().awaitingConfirm).toBe(true);
    expect(useEditorStore.getState().currentStage).toBe("render");

    applyWsEvent(
      {
        type: "run_confirmed",
        data: {
          agent: "plan",
          run_id: 303,
          stage: "render",
          auto_mode: true,
        },
      } as never,
      store,
      autoConfirmSpy
    );

    expect(useEditorStore.getState().awaitingConfirm).toBe(false);
    expect(useEditorStore.getState().messages.at(-1)).toMatchObject({
      role: "info",
      content: "自动确认，继续执行...",
    });
  });

  it("asserts run_completed and run_failed clear states and toasts", () => {
    const store = useEditorStore.getState();

    store.reset();
    store.setGenerating(true);
    store.setProgress(0.2);
    store.setCurrentAgent("plan");
    store.setCurrentRunId(111);
    store.setCurrentRunProviderSnapshot({
      text: { selected_key: "openai", source: "project", resolved_key: "openai", valid: true },
      image: { selected_key: "openai", source: "default", resolved_key: "openai", valid: true },
      video: { selected_key: "doubao", source: "project", resolved_key: "doubao", valid: true },
    } as never);
    store.setRecoveryControl({ type: "retry" } as never);
    store.setRecoverySummary({ from: "before" } as never);
    const addMessageSpy = vi.spyOn(store, "addMessage");
    store.setRecoveryGate({
      run_id: 111,
      agent: "plan",
      recovery_summary: {} as never,
      preserved_stages: [],
    } as never);
    store.setMessages([
      {
        id: "m1",
        agent: "plan",
        role: "assistant",
        content: "running",
        isLoading: true,
      },
    ]);

    applyWsEvent(
      {
        type: "run_completed",
        data: {
          message: "视频未配置，已完成文本和图片生成",
        } as never,
      },
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState()).toMatchObject({
      isGenerating: false,
      progress: 1,
      currentAgent: null,
      awaitingConfirm: false,
      currentRunId: null,
      recoveryControl: null,
      recoverySummary: null,
      recoveryGate: null,
      currentStage: "compose",
    });
    expect(useEditorStore.getState().currentRunProviderSnapshot).toBeNull();
    expect(addMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        agent: "system",
        content: "视频未配置，已完成文本和图片生成",
      })
    );

    applyWsEvent(
      {
        type: "run_failed",
        data: { error: "生成失败" } as never,
      },
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().isGenerating).toBe(false);
    expect(useEditorStore.getState().recoveryControl).toBeNull();
    expect(useEditorStore.getState().currentRunProviderSnapshot).toBeNull();
    expect(useEditorStore.getState().messages.at(-1)).toMatchObject({
      role: "error",
      content: "生成失败: 生成失败",
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "生成失败",
      })
    );
  });

  it("clears live state when run_cancelled arrives", () => {
    const store = useEditorStore.getState();

    store.reset();
    store.setGenerating(true);
    store.setProgress(0.48);
    store.setCurrentAgent("plan");
    store.setCurrentRunId(303);
    store.setRecoveryControl({ type: "retry" } as never);
    store.setRecoverySummary({ from: "before-cancel" } as never);
    store.setRecoveryGate({ run_id: 303, agent: "plan" } as never);
    store.setMessages([
      {
        id: "loading-plan",
        agent: "plan",
        role: "assistant",
        content: "still loading",
        isLoading: true,
      },
    ]);

    applyWsEvent(
      {
        type: "run_cancelled",
        data: { run_id: 303 } as never,
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState()).toMatchObject({
      isGenerating: false,
      progress: 0,
      currentAgent: null,
      awaitingConfirm: false,
      currentRunId: null,
      recoveryControl: null,
      recoverySummary: null,
      recoveryGate: null,
    });
    expect(useEditorStore.getState().currentRunProviderSnapshot).toBeNull();
    expect(useEditorStore.getState().messages.at(-1)).toMatchObject({
      role: "info",
      agent: "system",
      content: "生成已停止",
    });
    expect(useEditorStore.getState().messages[0]).toMatchObject({
      id: "loading-plan",
      isLoading: false,
    });
  });

  it("updates character and shot entities on event lifecycle", () => {
    const store = useEditorStore.getState();

    store.reset();

    applyWsEvent(
      {
        type: "character_created",
        data: {
          character: { id: 1, name: "Alice", image_url: "alice.png" },
        },
      } as never,
      store,
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "character_updated",
        data: {
          character: { id: 1, name: "Alice v2", image_url: "alice_v2.png" },
        },
      } as never,
      store,
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "character_deleted",
        data: { character_id: 1 },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().characters).toHaveLength(0);

    applyWsEvent(
      {
        type: "shot_created",
        data: { shot: { id: 21, title: "Shot-1" } },
      } as never,
      store,
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "shot_updated",
        data: { shot: { id: 21, title: "Shot-1 v2" } },
      } as never,
      store,
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "shot_deleted",
        data: { shot_id: 21 },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().shots).toHaveLength(0);

    // 兼容现状事件：当前分支无 character_approved / shot_approved 处理
    applyWsEvent(
      {
        type: "character_approved",
        data: { character: { id: 2, name: "Bob" } },
      } as never,
      store,
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "shot_approved",
        data: { shot: { id: 22, title: "Shot-2" } },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().characters).toHaveLength(0);
    expect(useEditorStore.getState().shots).toHaveLength(0);
  });

  it("handles data_cleared and project_updated cleanup", () => {
    const store = useEditorStore.getState();

    store.reset();
    store.setCharacters([{ id: 1, name: "Tom" }] as never);
    store.setShots([{ id: 1, title: "S1" }] as never);

    applyWsEvent(
      {
        type: "data_cleared",
        data: { cleared_types: ["characters", "shots"] },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().characters).toHaveLength(0);
    expect(useEditorStore.getState().shots).toHaveLength(0);

    const beforeProjectUpdatedAt = useEditorStore.getState().projectUpdatedAt;
    applyWsEvent(
      {
        type: "project_updated",
        data: { project: { video_url: "http://cdn/video.mp4" } },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectVideoUrl).toBe("http://cdn/video.mp4");
    expect(useEditorStore.getState().projectUpdatedAt).toBeTypeOf("number");
    if (beforeProjectUpdatedAt !== null) {
      expect(useEditorStore.getState().projectUpdatedAt).toBeGreaterThan(beforeProjectUpdatedAt);
    }
  });

  it("handles shots_reordered by replacing shots in backend order", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setShots([shotForWs(1, 1), shotForWs(2, 2)] as never);

    applyWsEvent(
      {
        type: "shots_reordered",
        data: {
          project_id: 1,
          shots: [shotForWs(1, 2), shotForWs(2, 1)],
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().shots.map((shot) => shot.id)).toEqual([2, 1]);
    expect(useEditorStore.getState().shots.map((shot) => shot.order)).toEqual([1, 2]);
  });

  it("does not reconnect after explicit disconnect close", () => {
    const { result } = renderHook(() => useProjectWebSocket(61));
    const ws = MockWebSocket.instances[0];

    act(() => {
      result.current.disconnect();
    });

    act(() => {
      ws.onclose?.(new Event("close"));
      vi.advanceTimersByTime(3000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("handles server-error events", () => {
    const store = useEditorStore.getState();

    store.reset();

    applyWsEvent(
      {
        type: "error",
        data: { message: "server error", code: "E_SERVER" },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(toastMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "服务器错误",
      })
    );
  });

  it("handles connected and run_progress recovery branches", () => {
    const store = useEditorStore.getState();

    store.reset();

    applyWsEvent(
      {
        type: "connected",
        data: {},
      } as never,
      store,
      noopAutoConfirm
    );

    applyWsEvent(
      {
        type: "run_progress",
        data: {
          current_agent: "plan",
          progress: 0.9,
          current_stage: "invalid_stage",
          recovery_summary: { step: "resume" },
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().currentAgent).toBe("plan");
    expect(useEditorStore.getState().progress).toBe(0.9);
    expect(useEditorStore.getState().recoverySummary).toMatchObject({ step: "resume" });
  });

  it("sets currentAgent from run_started event", () => {
    const store = useEditorStore.getState();
    store.reset();

    applyWsEvent(
      {
        type: "run_started",
        data: {
          run_id: 500,
          current_agent: "plan",
          stage: "plan",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().currentAgent).toBe("plan");
    expect(useEditorStore.getState().currentRunId).toBe(500);
  });

  it("recovers generating state from run_progress when not generating", () => {
    const store = useEditorStore.getState();
    store.reset();

    expect(store.isGenerating).toBe(false);

    applyWsEvent(
      {
        type: "run_progress",
        data: {
          run_id: 600,
          current_agent: "plan",
          progress: 0.5,
          stage: "character",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().isGenerating).toBe(true);
    expect(useEditorStore.getState().currentRunId).toBe(600);
    expect(useEditorStore.getState().currentAgent).toBe("plan");
  });

  it("recovers generating state from run_awaiting_confirm when not generating", () => {
    const store = useEditorStore.getState();
    store.reset();

    expect(store.isGenerating).toBe(false);

    applyWsEvent(
      {
        type: "run_awaiting_confirm",
        data: {
          run_id: 700,
          agent: "plan",
          message: "请确认",
          stage: "character",
          recovery_summary: {},
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().isGenerating).toBe(true);
    expect(useEditorStore.getState().currentRunId).toBe(700);
  });

  it("clears projectVideoUrl on data_cleared", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.patchProject({ id: 0, video_url: "http://cdn/old.mp4" });

    applyWsEvent(
      {
        type: "data_cleared",
        data: { cleared_types: ["characters"] },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectVideoUrl).toBeNull();
  });

  it("handles project_updated with video_url null and undefined", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.patchProject({ id: 0, video_url: "http://cdn/old.mp4" });

    applyWsEvent(
      {
        type: "project_updated",
        data: { project: { video_url: null } },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectVideoUrl).toBeNull();

    store.patchProject({ id: 0, video_url: "http://cdn/new.mp4" });

    applyWsEvent(
      {
        type: "project_updated",
        data: { project: { title: "updated" } },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectVideoUrl).toBe("http://cdn/new.mp4");
  });

  it("handles project_updated with status", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.patchProject({ id: 0, status: null });

    applyWsEvent(
      {
        type: "project_updated",
        data: { project: { status: "generating" } },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectStatus).toBe("generating");
  });

  it("handles full project_updated contract fields", () => {
    const store = useEditorStore.getState();
    store.reset();

    applyWsEvent(
      {
        type: "project_updated",
        data: {
          project: {
            id: 9,
            creation_mode: "universe",
            exports: ["/static/exports/story.pdf"],
            provider_settings: {
              text: {
                selected_key: "fake",
                source: "project",
                resolved_key: "fake",
                valid: true,
                reason_code: null,
                reason_message: null,
              },
              image: {
                selected_key: "fake",
                source: "project",
                resolved_key: "fake",
                valid: true,
                reason_code: null,
                reason_message: null,
              },
              video: {
                selected_key: "fake",
                source: "project",
                resolved_key: "fake",
                valid: true,
                reason_code: null,
                reason_message: null,
              },
            },
            universe_id: 3,
            chapter_number: 4,
            chapter_title: "第四章",
          },
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState()).toMatchObject({
      projectCreationMode: "universe",
      projectExports: ["/static/exports/story.pdf"],
      projectUniverseId: 3,
      projectChapterNumber: 4,
      projectChapterTitle: "第四章",
    });
    expect(useEditorStore.getState().projectProviderSettings?.text.selected_key).toBe("fake");
  });

  it("ignores project_updated status when project data is undefined", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.patchProject({ id: 0, status: "idle" });

    applyWsEvent(
      {
        type: "project_updated",
        data: {},
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().projectStatus).toBe("idle");
  });

  it("reads current_stage from run_completed event data", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setGenerating(true);
    store.setCurrentRunId(888);

    applyWsEvent(
      {
        type: "run_completed",
        data: {
          run_id: 888,
          current_stage: "compose",
          message: "完成片段阶段",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().isGenerating).toBe(false);
    expect(useEditorStore.getState().currentStage).toBe("compose");
  });

  it("reads summary from run_message event", () => {
    const store = useEditorStore.getState();
    store.reset();

    applyWsEvent(
      {
        type: "run_message",
        data: {
          agent: "plan",
          role: "assistant",
          content: "full content here",
          summary: "brief summary",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    const lastMsg = useEditorStore.getState().messages.at(-1);
    expect(lastMsg).toMatchObject({
      agent: "plan",
      content: "full content here",
      summary: "brief summary",
    });
  });

  it("handles run_cancelled with run_ids field", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setGenerating(true);
    store.setCurrentRunId(100);

    applyWsEvent(
      {
        type: "run_cancelled",
        data: { run_ids: [100, 101], cancelled_count: 2 },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().isGenerating).toBe(false);
    expect(useEditorStore.getState().currentRunId).toBeNull();
  });

  it("handles data_cleared with start_agent and mode fields", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setCharacters([{ id: 1, name: "A" }] as never);
    store.patchProject({ id: 0, video_url: "http://cdn/old.mp4" });

    applyWsEvent(
      {
        type: "data_cleared",
        data: { cleared_types: ["characters"], start_agent: "plan", mode: "full" },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().characters).toHaveLength(0);
    expect(useEditorStore.getState().projectVideoUrl).toBeNull();
  });

  it("recovers state from WS replay run_progress with current_stage and stage", () => {
    const store = useEditorStore.getState();
    store.reset();

    applyWsEvent(
      {
        type: "run_progress",
        data: {
          run_id: 999,
          current_agent: "animator",
          current_stage: "compose",
          stage: "compose",
          progress: 0.75,
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState()).toMatchObject({
      isGenerating: true,
      currentRunId: 999,
      currentAgent: "animator",
      progress: 0.75,
    });
  });

  it("reads current_stage from run_started event", () => {
    const store = useEditorStore.getState();
    store.reset();

    applyWsEvent(
      {
        type: "run_started",
        data: {
          run_id: 501,
          current_agent: "plan",
          current_stage: "plan",
          stage: "plan",
          next_stage: "character",
        },
      } as never,
      store,
      noopAutoConfirm
    );

    expect(useEditorStore.getState().currentStage).toBe("plan");
  });

  it("handles extended WS event contracts added after the base generation flow", () => {
    const store = useEditorStore.getState();
    store.reset();
    store.setShots([
      {
        id: 7,
        project_id: 1,
        order: 1,
        description: "shot",
        prompt: null,
        image_prompt: null,
        image_url: null,
        video_url: null,
        duration: null,
        camera: null,
        motion_note: null,
        scene: null,
        action: null,
        expression: null,
        lighting: null,
        dialogue: null,
        sfx: null,
        seed: null,
        character_ids: [],
        approval_state: "draft",
        approval_version: 0,
        approved_at: null,
        approved_description: null,
        approved_prompt: null,
        approved_image_prompt: null,
        approved_duration: null,
        approved_camera: null,
        approved_motion_note: null,
        approved_scene: null,
        approved_action: null,
        approved_expression: null,
        approved_lighting: null,
        approved_dialogue: null,
        approved_sfx: null,
        approved_character_ids: [],
      },
    ]);

    applyWsEvent(
      {
        type: "agent_thinking",
        data: {
          agent: "critic",
          phase: "reviewing",
          content: "checking consistency",
          details: "face match",
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "critique_result",
        data: {
          score: 8.6,
          dimensions: { quality: 9 },
          issues: [],
          suggestions: ["保持当前风格"],
          entity_type: "shot",
          entity_id: 7,
          will_regenerate: false,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "version_created",
        data: {
          entity_type: "shot",
          entity_id: 7,
          version: 2,
          trigger: "generation",
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "version_rollback",
        data: {
          entity_type: "shot",
          entity_id: 7,
          from_version: 3,
          to_version: 2,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "audio_generated",
        data: {
          shot_id: 7,
          tts_url: "/static/audio/shot7.mp3",
          bgm_type: "warm",
          duration: 4.2,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "bible_updated",
        data: {
          character_id: 1,
          visual_notes: true,
          reference_images_count: 2,
          has_embedding: true,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "consistency_eval_completed",
        data: {
          project_id: 1,
          overall_score: 91.25,
          character_count: 3,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );
    applyWsEvent(
      {
        type: "export_completed",
        data: {
          export_id: "exp-1",
          format: "pdf",
          download_url: "/static/exports/story.pdf",
          status: "completed",
          error: null,
        },
      } as never,
      useEditorStore.getState(),
      noopAutoConfirm
    );

    const messages = useEditorStore.getState().messages;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "critic",
          role: "thinking",
          phase: "reviewing",
          content: "checking consistency",
        }),
        expect.objectContaining({
          agent: "critic",
          role: "assistant",
          content: expect.stringContaining("总分 8.6/10"),
        }),
        expect.objectContaining({
          agent: "system",
          content: expect.stringContaining("已保存版本 v2"),
        }),
        expect.objectContaining({
          agent: "system",
          content: expect.stringContaining("已从 v3 回滚到 v2"),
        }),
        expect.objectContaining({
          agent: "critic",
          content: expect.stringContaining("角色圣经已更新"),
        }),
        expect.objectContaining({
          agent: "critic",
          content: expect.stringContaining("综合评分 91.3/100"),
        }),
      ])
    );
    expect(useEditorStore.getState().shots[0]).toMatchObject({
      tts_url: "/static/audio/shot7.mp3",
      bgm_type: "warm",
    });
    expect(toastMock.success).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: "导出完成",
      })
    );
  });
});

describe("project_updated patch coverage", () => {
  /**
   * 回归守卫：project_updated 曾用一个手写的 19 项映射表，
   * 而 payload 有 21 个字段 —— 没被列出的字段会被静默丢弃（skill_id 就是）。
   * 现在映射表是 Record<...>（编译器强制全覆盖），这里再断言运行时确实写入。
   */
  it("applies every payload field it is given", () => {
    const store = useEditorStore.getState();
    store.patchProject({
      id: 7,
      title: "标题",
      story: "故事",
      style: "anime",
      summary: "摘要",
      video_url: "/static/videos/a.mp4",
      status: "ready",
      target_shot_count: 6,
      character_hints: ["a"],
      creation_mode: "quick",
      reference_images: ["/static/r.png"],
      exports: ["/static/e.pdf"],
      universe_id: 3,
      chapter_number: 2,
      chapter_title: "第二章",
      skill_id: "quick-short",
      visual_bible: "visual",
      outline_approved: true,
    });

    const s = useEditorStore.getState();
    expect(s.projectTitle).toBe("标题");
    expect(s.projectStory).toBe("故事");
    expect(s.projectStyle).toBe("anime");
    expect(s.projectSummary).toBe("摘要");
    expect(s.projectVideoUrl).toBe("/static/videos/a.mp4");
    expect(s.projectStatus).toBe("ready");
    expect(s.projectTargetShotCount).toBe(6);
    expect(s.projectCharacterHints).toEqual(["a"]);
    expect(s.projectCreationMode).toBe("quick");
    expect(s.projectReferenceImages).toEqual(["/static/r.png"]);
    expect(s.projectExports).toEqual(["/static/e.pdf"]);
    expect(s.projectUniverseId).toBe(3);
    expect(s.projectChapterNumber).toBe(2);
    expect(s.projectChapterTitle).toBe("第二章");
    // 曾被静默丢弃的字段
    expect(s.projectSkillId).toBe("quick-short");
    expect(s.projectVisualBible).toBe("visual");
    expect(s.projectOutlineApproved).toBe(true);
  });

  it("leaves untouched fields alone (patch semantics, not replace)", () => {
    const store = useEditorStore.getState();
    store.patchProject({ id: 1, title: "A", status: "draft" });
    store.patchProject({ id: 1, summary: "只改摘要" });

    const s = useEditorStore.getState();
    expect(s.projectTitle).toBe("A");
    expect(s.projectStatus).toBe("draft");
    expect(s.projectSummary).toBe("只改摘要");
  });
});
