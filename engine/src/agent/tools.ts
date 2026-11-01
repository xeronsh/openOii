/**
 * Tools the chat agent may call. Every tool goes through the backend's product
 * API (the same endpoints the UI uses), so validation, run creation and gates
 * stay in one place; the agent never touches the database directly.
 *
 * A tool with `confirm` changes the project or spends money: the chat agent
 * shows the user that sentence and runs the tool only after they confirm.
 * There is deliberately no tool that approves a gate.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";

/** A chat tool; `confirm` (write tools only) says in one sentence what will happen. */
export type ChatTool = AgentTool & { confirm?: (args: Record<string, unknown>) => string };

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
      // The backend wraps errors as {"error": {"code", "message"}}.
      const body = (data as { error?: { message?: unknown }; detail?: unknown } | null) ?? {};
      throw new BackendError(res.status, String(body.error?.message ?? JSON.stringify(body.detail ?? data)));
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
export function readTools(projectId: number, api: BackendFetch): ChatTool[] {
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

/** Typed params for `execute`; pi-agent-core validates them against `parameters` first. */
const exec =
  <T>(fn: (args: T) => Promise<AgentToolResult<undefined>>) =>
  (_id: string, params: unknown) =>
    fn(params as T);
const Id = (description: string) => Type.Integer({ minimum: 1, description });
const Text = (description: string) => Type.Optional(Type.String({ description }));

/** Write tools bound to one project; each one needs the user's confirmation. */
export function writeTools(projectId: number, api: BackendFetch): ChatTool[] {
  const owned = async (kind: "shots" | "characters", id: number): Promise<Record<string, unknown>> => {
    const rows = (await api(`/projects/${projectId}/${kind}`)) as Array<Record<string, unknown>>;
    const row = rows.find((entry) => entry.id === id);
    if (!row) throw new Error(`${kind === "shots" ? "分镜" : "角色"} #${id} 不属于当前项目`);
    return row;
  };
  const currentRunId = async (): Promise<number> => {
    const current = (await api(`/projects/${projectId}/runs/current`)) as { active_run?: { id: number } } | null;
    if (!current?.active_run) throw new Error("当前没有可以继续或停止的运行");
    return current.active_run.id;
  };
  const fields = (args: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((key) => typeof args[key] === "string").map((key) => [key, args[key]]));
  const runResult = (run: unknown) => ok({ ok: true, run_id: (run as { id?: unknown } | null)?.id ?? null });

  return [
    {
      name: "start_run",
      label: "开始生成",
      description: "从大纲开始完整生成整个项目（会覆盖现有结果，停在每个审批门等用户确认）。",
      parameters: Type.Object({ notes: Text("给这次生成的补充要求") }),
      confirm: (args) => `从头完整生成这个项目${args.notes ? `，要求：${String(args.notes)}` : ""}`,
      execute: exec(async (args: { notes?: string }) =>
        runResult(await api(`/projects/${projectId}/runs`, { method: "POST", body: { notes: args.notes ?? null, auto_mode: false } }))),
    },
    {
      name: "resume_run",
      label: "继续运行",
      description: "继续当前中断的运行。",
      parameters: NoArgs,
      confirm: () => "继续当前中断的运行",
      execute: async () => runResult(await api(`/runs/${await currentRunId()}/resume`, { method: "POST" })),
    },
    {
      name: "cancel_run",
      label: "停止运行",
      description: "停止当前运行。",
      parameters: NoArgs,
      confirm: () => "停止当前运行",
      execute: async () => ok(await api(`/runs/${await currentRunId()}/cancel`, { method: "POST" })),
    },
    {
      name: "regenerate_shot",
      label: "重画分镜",
      description: "重新生成某个分镜的画面（image）或视频（video）。shot_id 先用 get_project_state 查。",
      parameters: Type.Object({
        shot_id: Id("分镜 id"),
        type: Type.Union([Type.Literal("image"), Type.Literal("video")]),
        description: Text("新的画面描述（可选）"),
      }),
      confirm: (args) =>
        `重新生成分镜 #${String(args.shot_id)} 的${args.type === "video" ? "视频" : "画面"}${args.description ? `：${String(args.description)}` : ""}`,
      execute: exec(async (args: { shot_id: number; type: "image" | "video"; description?: string }) => {
        await owned("shots", args.shot_id);
        return runResult(
          await api(`/shots/${args.shot_id}/regenerate`, {
            method: "POST",
            body: { type: args.type, description: args.description ?? null },
          }),
        );
      }),
    },
    {
      name: "regenerate_character",
      label: "重画角色",
      description: "重新生成某个角色的形象图。character_id 先用 get_project_state 查。",
      parameters: Type.Object({ character_id: Id("角色 id"), description: Text("新的形象描述（可选）") }),
      confirm: (args) =>
        `重新生成角色 #${String(args.character_id)} 的形象图${args.description ? `：${String(args.description)}` : ""}`,
      execute: exec(async (args: { character_id: number; description?: string }) => {
        await owned("characters", args.character_id);
        return runResult(
          await api(`/characters/${args.character_id}/regenerate`, {
            method: "POST",
            body: { type: "image", description: args.description ?? null },
          }),
        );
      }),
    },
    {
      name: "recompose",
      label: "重新合成",
      description: "用现有视频片段重新合成成片（不重画）。",
      parameters: NoArgs,
      confirm: () => "用现有片段重新合成成片",
      execute: async () => runResult(await api(`/projects/${projectId}/runs/recompose`, { method: "POST" })),
    },
    {
      name: "update_outline",
      label: "修改大纲",
      description: "修改故事大纲的文字字段；修改后大纲需要用户重新审批。",
      parameters: Type.Object({
        logline: Text("一句话故事"),
        summary: Text("故事梗概"),
        setting: Text("背景设定"),
        tone: Text("基调"),
      }),
      confirm: (args) => `修改大纲的 ${Object.keys(fields(args, ["logline", "summary", "setting", "tone"])).join("、")}`,
      execute: exec(async (args: Record<string, unknown>) => {
        await api(`/projects/${projectId}/outline`, {
          method: "PUT",
          body: fields(args, ["logline", "summary", "setting", "tone"]),
        });
        return ok({ ok: true });
      }),
    },
    {
      name: "update_shot",
      label: "修改分镜",
      description: "修改某个分镜的文字（描述、画面提示词、台词、镜头）。不会重画。",
      parameters: Type.Object({
        shot_id: Id("分镜 id"),
        description: Text("分镜描述"),
        image_prompt: Text("画面提示词"),
        dialogue: Text("台词"),
        camera: Text("镜头"),
      }),
      confirm: (args) =>
        `修改分镜 #${String(args.shot_id)} 的 ${Object.keys(fields(args, ["description", "image_prompt", "dialogue", "camera"])).join("、")}`,
      execute: exec(async (args: Record<string, unknown>) => {
        await owned("shots", args.shot_id as number);
        await api(`/shots/${String(args.shot_id)}`, {
          method: "PATCH",
          body: fields(args, ["description", "image_prompt", "dialogue", "camera"]),
        });
        return ok({ ok: true });
      }),
    },
    {
      name: "update_character",
      label: "修改角色",
      description: "修改某个角色的名字、描述或外形备注。不会重画。",
      parameters: Type.Object({
        character_id: Id("角色 id"),
        name: Text("名字"),
        description: Text("描述"),
        visual_notes: Text("外形备注"),
      }),
      confirm: (args) =>
        `修改角色 #${String(args.character_id)} 的 ${Object.keys(fields(args, ["name", "description", "visual_notes"])).join("、")}`,
      execute: exec(async (args: Record<string, unknown>) => {
        await owned("characters", args.character_id as number);
        await api(`/characters/${String(args.character_id)}`, {
          method: "PATCH",
          body: fields(args, ["name", "description", "visual_notes"]),
        });
        return ok({ ok: true });
      }),
    },
  ];
}

/** Every tool the chat agent has for one project. */
export function chatTools(projectId: number, api: BackendFetch): ChatTool[] {
  return [...readTools(projectId, api), ...writeTools(projectId, api)];
}
