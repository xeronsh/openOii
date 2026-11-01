/**
 * Chat agent (ADR 0011): one long-lived pi-agent-core `Agent` per project.
 *
 * The 15-stage workflow (`src/pipeline/`) stays a deterministic state machine;
 * this module only lets the user talk to the project. The model picks a tool,
 * the tool calls the backend product API, the result goes back to the model.
 * Write tools wait for the user's confirmation (`beforeToolCall`). A workflow
 * stage never calls into this module.
 *
 * Clients learn about the chat through two durable events on the project's
 * event log (run_id 0, no run): `chat_message` (one finished, saved message)
 * and `chat_status` (busy flag, the reply streaming so far, the pending
 * confirmation). Only the newest `chat_status` row is kept.
 */
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { registerFauxProvider, streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { EngineDatabase } from "../db.js";
import { fakeStreamMs, type TextLlmService } from "../llm.js";
import { fakeChatReply } from "./fake.js";
import { chatTools, type BackendFetch, type ChatTool } from "./tools.js";

export const SYSTEM_PROMPT = `你是 openOii 漫剧工作台里的创作助手，用简洁的中文回答。
openOii 用一条固定的分阶段工作流做漫剧：大纲 → 角色 → 分镜 → 角色图 → 分镜画面 → 视频片段 → 成片，
每个规划和画面阶段之后都有一个审批门，必须由用户本人在界面上点「通过」。
你只能通过工具了解和修改项目，回答前先用工具读取最新状态，不要编造 id 或进度。
会改动项目或花钱的工具，系统会先请用户确认；用户拒绝后不要换个工具重试。
你永远不能替用户通过审批门；用户让你批准时，请他在审批区自己确认。`;

/** Messages the model sees per turn; older ones stay in the saved history. */
export const CONTEXT_MESSAGES = 40;
/** Model turns per user message, so a looping model cannot spend tokens forever. */
export const MAX_TURNS = 8;
/** An unanswered confirmation card counts as declined after this long. */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** Minimum gap between two streaming `chat_status` frames. */
const STREAM_FRAME_MS = 150;

export class ChatBusyError extends Error {
  constructor(readonly projectId: number) {
    super(`project ${projectId} chat is already answering`);
  }
}

/** What the UI shows for one saved message. */
export interface ChatItem {
  id: number;
  role: "user" | "assistant" | "tool";
  text: string;
  /** tool rows: the tool's label and whether it succeeded */
  tool?: string;
  ok?: boolean;
  /** assistant rows that ended in an error or a stop */
  error?: string;
}

export interface ChatConfirm {
  tool_call_id: string;
  tool: string;
  summary: string;
}

export interface ChatStatus {
  busy: boolean;
  text: string;
  pending: ChatConfirm | null;
}

export interface ChatAgentDeps {
  db: EngineDatabase;
  llm: TextLlmService;
  api: BackendFetch;
  /** Tests inject a scripted model; otherwise the configured text model is used. */
  streamFn?: StreamFn;
  tools?: (projectId: number, api: BackendFetch) => ChatTool[];
  confirmTimeoutMs?: number;
}

let fakeChat: ReturnType<typeof registerFauxProvider> | null = null;

/** Fake text provider: a scripted, context-driven reply streamed through pi-ai's faux provider. */
const fakeStream: StreamFn = (model, context, options) => {
  fakeChat!.appendResponses([(ctx) => fakeChatReply(ctx)]);
  return streamSimple(model, context, options);
};

function fakeChatModel(): Model<Api> {
  if (!fakeChat) {
    const ms = fakeStreamMs();
    fakeChat = registerFauxProvider({
      provider: "fake-chat",
      models: [{ id: "fake-chat", name: "Fake chat" }],
      tokenSize: { min: 1, max: 3 },
      tokensPerSecond: ms > 0 ? 2000 / ms : undefined,
    });
  }
  return fakeChat.getModel() as unknown as Model<Api>;
}

/** Keep the newest messages, starting at a user turn so no tool result is orphaned. */
export function recentContext(messages: AgentMessage[], limit = CONTEXT_MESSAGES): AgentMessage[] {
  if (messages.length <= limit) return messages;
  const tail = messages.slice(-limit);
  const start = tail.findIndex((message) => message.role === "user");
  return start < 0 ? tail : tail.slice(start);
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text : "")).join("")
      : "";

/** Provider errors can be whole HTML pages; the UI gets the first line, clipped. */
const shortError = (message: string): string => {
  const line = message.split("\n", 1)[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/** The UI form of a saved message, or null for a pure tool-call turn. */
export function chatItem(id: number, message: AgentMessage, labels: Map<string, string>): ChatItem | null {
  if (message.role === "user") return { id, role: "user", text: textOf(message.content) };
  if (message.role === "toolResult") {
    const text = textOf(message.content);
    return {
      id,
      role: "tool",
      tool: labels.get(message.toolName) ?? message.toolName,
      ok: !message.isError,
      text: message.isError ? shortError(text) : "",
    };
  }
  if (message.role !== "assistant") return null;
  const text = textOf(message.content);
  if (message.stopReason === "aborted") return { id, role: "assistant", text, error: "已停止" };
  if (message.stopReason === "error") {
    return { id, role: "assistant", text, error: shortError(message.errorMessage ?? "模型调用失败") };
  }
  return text ? { id, role: "assistant", text } : null;
}

export class ChatAgents {
  private readonly sessions = new Map<number, Agent>();
  private readonly turns = new Map<number, number>();
  private readonly streaming = new Map<number, string>();
  private readonly pending = new Map<number, { card: ChatConfirm; decide: (approved: boolean) => void }>();
  private readonly labels = new Map<string, string>();

  constructor(private readonly deps: ChatAgentDeps) {}

  /** The saved conversation in UI form. */
  history(projectId: number): ChatItem[] {
    this.session(projectId);
    return this.deps.db
      .chatMessages(projectId)
      .map((row) => chatItem(row.id, row.message as AgentMessage, this.labels))
      .filter((item): item is ChatItem => item !== null);
  }

  busy(projectId: number): boolean {
    return this.sessions.get(projectId)?.state.isStreaming ?? false;
  }

  status(projectId: number): ChatStatus {
    return {
      busy: this.busy(projectId),
      text: this.streaming.get(projectId) ?? "",
      pending: this.pending.get(projectId)?.card ?? null,
    };
  }

  /** Start answering `text`; `done` settles when the reply has finished. */
  send(projectId: number, text: string): { done: Promise<void> } {
    if (this.busy(projectId)) throw new ChatBusyError(projectId);
    const agent = this.session(projectId);
    // Settings may change between messages, so the model is resolved per message.
    const resolved = this.deps.llm.agentModel();
    agent.state.model = resolved.model ?? fakeChatModel();
    agent.streamFunction = this.deps.streamFn ?? (resolved.model ? streamSimple : fakeStream);
    agent.getApiKey = () => resolved.apiKey;
    agent.state.thinkingLevel = resolved.reasoning ?? "off";
    this.turns.set(projectId, 0);
    return { done: agent.prompt(text) };
  }

  abort(projectId: number): boolean {
    const agent = this.sessions.get(projectId);
    if (!agent?.state.isStreaming) return false;
    agent.abort();
    return true;
  }

  /** The user's answer to a confirmation card; false when no such card is open. */
  confirm(projectId: number, toolCallId: string, approved: boolean): boolean {
    const open = this.pending.get(projectId);
    if (!open || open.card.tool_call_id !== toolCallId) return false;
    open.decide(approved);
    return true;
  }

  private emit(projectId: number, type: "chat_message" | "chat_status", data: object): void {
    const seq = this.deps.db.appendEvent(0, projectId, type, { project_id: projectId, ...data });
    if (type === "chat_status") this.deps.db.compactChatStatus(projectId, seq);
  }

  private emitStatus(projectId: number): void {
    this.emit(projectId, "chat_status", this.status(projectId));
  }

  private ask(projectId: number, card: ChatConfirm, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const decide = (approved: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(projectId);
        this.emitStatus(projectId);
        resolve(approved);
      };
      const onAbort = () => decide(false);
      const timer = setTimeout(() => decide(false), this.deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(projectId, { card, decide });
      this.emitStatus(projectId);
    });
  }

  private session(projectId: number): Agent {
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const tools = (this.deps.tools ?? chatTools)(projectId, this.deps.api);
    for (const tool of tools) this.labels.set(tool.name, tool.label);
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        tools,
        messages: this.deps.db.chatMessages(projectId).map((row) => row.message as AgentMessage),
      },
      streamFn: streamSimple,
      transformContext: async (messages) => recentContext(messages),
      beforeToolCall: async ({ toolCall, args }, signal) => {
        const tool = tools.find((entry) => entry.name === toolCall.name);
        if (!tool?.confirm) return undefined;
        const card = {
          tool_call_id: toolCall.id,
          tool: tool.label,
          summary: tool.confirm(args as Record<string, unknown>),
        };
        if (await this.ask(projectId, card, signal)) return undefined;
        return { block: true, reason: "用户没有确认，这个操作没有执行。" };
      },
      finishTurn: () => {
        const turns = (this.turns.get(projectId) ?? 0) + 1;
        this.turns.set(projectId, turns);
        return turns >= MAX_TURNS ? { action: "end" } : undefined;
      },
      toolExecution: "sequential",
      sessionId: `project-${projectId}`,
    });
    let lastFrame = 0;
    agent.subscribe((event) => {
      if (event.type === "agent_start") {
        this.streaming.set(projectId, "");
        this.emit(projectId, "chat_status", { busy: true, text: "", pending: null });
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.streaming.set(projectId, textOf(event.message.content));
        if (Date.now() - lastFrame >= STREAM_FRAME_MS) {
          lastFrame = Date.now();
          this.emit(projectId, "chat_status", { busy: true, text: this.streaming.get(projectId), pending: null });
        }
      } else if (event.type === "message_end") {
        this.streaming.set(projectId, "");
        const id = this.deps.db.appendChatMessage(projectId, event.message);
        const item = chatItem(id, event.message, this.labels);
        if (item) this.emit(projectId, "chat_message", { message: item });
      } else if (event.type === "agent_end") {
        this.streaming.delete(projectId);
        this.emit(projectId, "chat_status", { busy: false, text: "", pending: null });
      }
    });
    this.sessions.set(projectId, agent);
    return agent;
  }
}
