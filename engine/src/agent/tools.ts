/**
 * Tools the chat agent may call. Every tool goes through the backend's product
 * API (the same endpoints the UI uses), so validation, run creation and gates
 * stay in one place; the agent never touches the database directly.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";

export type BackendFetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Loopback client for the backend product API (`OPENOII_BACKEND_URL`). */
export function backendFetch(baseUrl: string): BackendFetch {
  return async (path, init = {}) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = (data as { detail?: unknown; message?: unknown } | null) ?? {};
      throw new BackendError(res.status, String(detail.message ?? JSON.stringify(detail.detail ?? data)));
    }
    return data;
  };
}

/** Config keys whose values must never reach the model. */
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i;

const clip = (value: unknown, max = 120): unknown =>
  typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : value;

function ok(data: unknown): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
}

const NoArgs = Type.Object({});

/** Read-only tools bound to one project. */
export function readTools(projectId: number, api: BackendFetch): AgentTool[] {
  return [
    {
      name: "get_project_state",
      label: "读取项目",
      description:
        "读取当前项目：标题、状态、大纲摘要、角色（id/名字/是否有图）和分镜（id/序号/描述/有无画面与视频/审查结果）。",
      parameters: NoArgs,
      execute: async () => {
        const [project, characters, shots] = (await Promise.all([
          api(`/projects/${projectId}`),
          api(`/projects/${projectId}/characters`),
          api(`/projects/${projectId}/shots`),
        ])) as [Record<string, unknown>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
        const outline = (project.story_outline ?? {}) as Record<string, unknown>;
        return ok({
          project: {
            title: project.title,
            status: project.status,
            style: project.style,
            outline_approved: project.outline_approved,
            logline: clip(outline.logline),
            summary: clip(project.summary ?? outline.summary, 300),
            has_final_video: Boolean(project.video_url),
          },
          characters: characters.map((c) => ({
            id: c.id,
            name: c.name,
            has_image: Boolean(c.image_url),
            approval: c.approval_state,
          })),
          shots: shots.map((s) => ({
            id: s.id,
            order: s.order,
            description: clip(s.description),
            has_image: Boolean(s.image_url),
            has_video: Boolean(s.video_url),
            review: s.review_status ?? null,
            approval: s.approval_state,
          })),
        });
      },
    },
    {
      name: "get_run_status",
      label: "查看运行",
      description:
        "查看当前运行：是否在跑、所在阶段、是否停在审批门、已用时间和预计剩余时间。没有运行时返回 null。",
      parameters: NoArgs,
      execute: async () => {
        const current = (await api(`/projects/${projectId}/runs/current`)) as Record<string, unknown> | null;
        if (!current) return ok({ run: null });
        const run = current.active_run as Record<string, unknown>;
        const timing = (await api(`/runs/${String(run.id)}/timing`)) as Record<string, unknown>;
        return ok({
          run: {
            id: run.id,
            status: run.status,
            state: current.state,
            current_stage: timing.current_stage,
            at_gate: timing.at_gate,
            awaiting_gate: current.awaiting_gate ?? null,
            elapsed_seconds: timing.elapsed_seconds,
            remaining_seconds: timing.remaining_seconds ?? null,
          },
        });
      },
    },
    {
      name: "read_settings",
      label: "读取设置",
      description: "读取非敏感的模型与服务设置（提供商、模型名、地址等）；密钥类配置永远不会返回。",
      parameters: NoArgs,
      execute: async () => {
        const items = (await api("/config")) as Array<{ key: string; value: string | null; is_sensitive: boolean }>;
        return ok(
          Object.fromEntries(
            items
              .filter((item) => !item.is_sensitive && !SECRET_KEY.test(item.key))
              .map((item) => [item.key, item.value]),
          ),
        );
      },
    },
  ];
}
