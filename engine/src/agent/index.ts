/**
 * Chat agent (ADR 0011): one long-lived pi-agent-core `Agent` per project.
 *
 * The 15-stage workflow (`src/pipeline/`) stays a deterministic state machine;
 * this module only lets the user talk to the project. The model picks a tool,
 * the tool calls the backend product API, the result goes back to the model.
 * A workflow stage never calls into this module.
 */
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { registerFauxProvider, streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { EngineDatabase } from "../db.js";
import { fakeStreamMs, type TextLlmService } from "../llm.js";
import { fakeChatReply } from "./fake.js";
import { readTools, type BackendFetch } from "./tools.js";

export const SYSTEM_PROMPT = `你是 openOii 漫剧工作台里的创作助手，用简洁的中文回答。
openOii 用一条固定的分阶段工作流做漫剧：大纲 → 角色 → 分镜 → 角色图 → 分镜画面 → 视频片段 → 成片，
每个规划和画面阶段之后都有一个审批门，必须由用户本人在界面上点「通过」。
你只能通过工具了解项目，回答前先用工具读取最新状态，不要编造 id 或进度。
你永远不能替用户通过审批门；用户让你批准时，请他在审批区自己确认。`;

/** Messages the model sees per turn; older ones stay in the saved history. */
export const CONTEXT_MESSAGES = 40;
/** Model turns per user message, so a looping model cannot spend tokens forever. */
export const MAX_TURNS = 8;

export class ChatBusyError extends Error {
  constructor(readonly projectId: number) {
    super(`project ${projectId} chat is already answering`);
  }
}

export interface ChatAgentDeps {
  db: EngineDatabase;
  llm: TextLlmService;
  api: BackendFetch;
  /** Tests inject a scripted model; otherwise the configured text model is used. */
  streamFn?: StreamFn;
  tools?: (projectId: number, api: BackendFetch) => AgentTool[];
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

export class ChatAgents {
  private readonly sessions = new Map<number, Agent>();
  private readonly turns = new Map<number, number>();

  constructor(private readonly deps: ChatAgentDeps) {}

  history(projectId: number): AgentMessage[] {
    return this.deps.db.chatMessages(projectId) as AgentMessage[];
  }

  busy(projectId: number): boolean {
    return this.sessions.get(projectId)?.state.isStreaming ?? false;
  }

  /** Start answering `text`; resolves when the turn has started, not when it ends. */
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

  private session(projectId: number): Agent {
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        tools: (this.deps.tools ?? readTools)(projectId, this.deps.api),
        messages: this.history(projectId),
      },
      streamFn: streamSimple,
      transformContext: async (messages) => recentContext(messages),
      finishTurn: () => {
        const turns = (this.turns.get(projectId) ?? 0) + 1;
        this.turns.set(projectId, turns);
        return turns >= MAX_TURNS ? { action: "end" } : undefined;
      },
      toolExecution: "sequential",
      sessionId: `project-${projectId}`,
    });
    agent.subscribe((event) => {
      if (event.type === "message_end") this.deps.db.appendChatMessage(projectId, event.message);
    });
    this.sessions.set(projectId, agent);
    return agent;
  }
}
