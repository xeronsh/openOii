import { useCallback, useRef, useEffect, useState } from "react";
import type { AgentMessage } from "~/types";
import { AGENT_NAME_MAP } from "~/types";
import { TypewriterText } from "~/components/ui/TypewriterText";
import {
  CogIcon,
  CpuChipIcon,
  HandRaisedIcon,
  LightBulbIcon,
  PaintBrushIcon,
  SparklesIcon,
  UserIcon,
  VideoCameraIcon,
} from "@heroicons/react/24/outline";

interface MessageListProps {
  messages: AgentMessage[];
}

const agentColors: Record<string, string> = {
  plan: "text-primary",
  render: "text-info",
  compose: "text-warning",
  review: "text-accent",
  system: "text-bc-subtle",
  user: "text-primary",
  audio: "text-secondary",
};

const agentIcons: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  plan: LightBulbIcon,
  render: PaintBrushIcon,
  compose: VideoCameraIcon,
  review: CogIcon,
  system: CogIcon,
  user: UserIcon,
  audio: HandRaisedIcon,
};

const MIN_TYPEWRITER_LENGTH = 50;

const agentNameMap = AGENT_NAME_MAP;

const phaseLabelMap: Record<string, string> = {
  reasoning: "REASONING",
  decision: "DECISION",
  planning: "PLANNING",
  reviewing: "REVIEWING",
};

const phaseColorMap: Record<string, string> = {
  reasoning: "badge-info",
  decision: "badge-warning",
  planning: "badge-primary",
  reviewing: "badge-accent",
};

function ThinkingMessage({ msg }: { msg: AgentMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const phaseLabel = msg.phase ? phaseLabelMap[msg.phase] || msg.phase.toUpperCase() : "";
  const phaseBadge = msg.phase ? phaseColorMap[msg.phase] || "badge-ghost" : "badge-ghost";
  const AgentIcon = agentIcons[msg.agent] || SparklesIcon;
  const firstLine = msg.content.split("\n")[0] || msg.content;

  return (
    <div className="group">
      <div className="flex items-center gap-1 mb-0.5">
        <AgentIcon className={`w-3 h-3 ${agentColors[msg.agent] || "text-base-content/30"}`} aria-hidden="true" />
        <span className="text-xs font-comic uppercase tracking-wide text-bc-muted">{agentNameMap[msg.agent] || msg.agent}</span>
        {phaseLabel && (
          <span className={`badge ${phaseBadge} badge-xs ml-1 font-mono text-2xs`}>{phaseLabel}</span>
        )}
      </div>
      <div
        className="ml-1 mr-3 rounded-lg px-3 py-2 bg-info/5 border border-info/10 select-text cursor-pointer hover:bg-info/10 transition-colors"
        onClick={() => setIsExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsExpanded((prev) => !prev);
          }
        }}
        aria-label="查看思考过程"
      >
        <div className="flex items-start gap-1.5">
          <LightBulbIcon className="w-4 h-4 flex-shrink-0 text-info/70" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            {isExpanded ? (
              <div className="whitespace-pre-wrap break-words text-xs text-bc-muted leading-relaxed">
                {msg.content}
                {msg.details && (
                  <div className="mt-1 text-bc-muted border-t border-info/10 pt-1">
                    {msg.details}
                  </div>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
                  className="mt-1 text-xs text-bc-muted hover:text-bc-muted transition-colors"
                >
                  收起思考
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs text-bc-muted leading-relaxed truncate">{firstLine}</p>
                <span className="text-2xs text-bc-muted hover:text-base-content transition-colors">
                  查看思考过程
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function shouldFilterOut(msg: AgentMessage): boolean {
  if (msg.role === "info" && msg.agent === "system") return true;
  if (msg.role === "separator") return false;
  if (msg.role === "handoff") return false;
  if (msg.role === "thinking") return false;
  if (!msg.content?.trim() && !msg.isLoading) return true;
  return false;
}

export function MessageList({ messages }: MessageListProps) {
  const completedMessagesRef = useRef<Set<string>>(new Set());
  const messageFirstSeenRef = useRef<Map<string, number>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const handleComplete = useCallback((messageId: string) => {
    completedMessagesRef.current.add(messageId);
  }, []);

  const toggleCollapse = useCallback((messageId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const shouldEnableTypewriter = useCallback((msg: AgentMessage, isLastMessage: boolean): boolean => {
    if (msg.role === "user") return false;
    if (msg.role === "separator" || msg.role === "handoff" || msg.role === "info" || msg.role === "thinking") return false;
    if (msg.content.length < MIN_TYPEWRITER_LENGTH) return false;
    if (completedMessagesRef.current.has(msg.id || "")) return false;
    if (msg.isLoading) return true;
    if (isLastMessage && msg.id) {
      const firstSeen = messageFirstSeenRef.current.get(msg.id);
      if (!firstSeen) {
        messageFirstSeenRef.current.set(msg.id, Date.now());
        return true;
      }
      return Date.now() - firstSeen < 1000;
    }
    return false;
  }, []);

  useEffect(() => {
    const currentIds = new Set(messages.map(m => m.id).filter(Boolean));
    messageFirstSeenRef.current.forEach((_, id) => {
      if (!currentIds.has(id)) {
        messageFirstSeenRef.current.delete(id);
      }
    });
  }, [messages]);

  useEffect(() => {
    if (messages.length <= 8) return;
    const toCollapse = new Set(collapsed);
    let changed = false;
    messages.forEach((msg, idx) => {
      if (idx < messages.length - 4 && msg.summary && msg.id && !toCollapse.has(msg.id)) {
        toCollapse.add(msg.id);
        changed = true;
      }
    });
    if (changed) setCollapsed(toCollapse);
  }, [messages, collapsed]);

  const filtered = messages.filter((m) => !shouldFilterOut(m));

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-bc-muted">
        <p className="text-xs">暂无消息</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map((msg, idx) => {
        const key = msg.id || `fallback_${idx}`;
        const isLastMessage = idx === filtered.length - 1;

        if (msg.role === "separator") {
          return (
            <div key={key} className="flex justify-center my-1">
              <div className="w-full border-t-2 border-dashed border-base-content/10" />
            </div>
          );
        }

        if (msg.role === "handoff") {
          return (
            <div key={key} className="flex justify-center my-1">
              <div className="badge badge-outline badge-sm gap-0.5 text-bc-muted border-dashed">
                <HandRaisedIcon className="w-3 h-3" aria-hidden="true" />
                <span className="text-xs">{msg.content}</span>
              </div>
            </div>
          );
        }

        if (msg.role === "thinking") {
          return (
            <ThinkingMessage key={key} msg={msg} />
          );
        }

        const isUserMessage = msg.role === "user";
        const enableTypewriter = shouldEnableTypewriter(msg, isLastMessage);
        const AgentIcon = agentIcons[msg.agent] || CpuChipIcon;
        const isCollapsed = msg.summary && !isLastMessage && !isUserMessage && collapsed.has(msg.id || "");
        const prevMsg = idx > 0 ? filtered[idx - 1] : null;
        const sameAgentAsPrev = prevMsg?.agent === msg.agent && !isUserMessage && prevMsg?.role !== "separator" && prevMsg?.role !== "handoff";

        const messageContent = (
          <>
            {!sameAgentAsPrev && (
              <div className="flex items-center gap-1 mb-0.5">
                <AgentIcon className={`w-3 h-3 ${agentColors[msg.agent] || "text-base-content/30"}`} aria-hidden="true" />
                <span className="text-xs font-comic uppercase tracking-wide text-bc-muted">{agentNameMap[msg.agent] || msg.agent}</span>
              </div>
            )}
            <div
              className={`${isUserMessage ? "speech-bubble-user ml-3" : "speech-bubble mr-3"} select-text text-sm leading-relaxed ${
                msg.role === "error"
                  ? "!bg-error/10 !text-error rounded-lg"
                  : ""
              }`}
            >
              {isCollapsed && msg.summary ? (
                <button
                  type="button"
                  onClick={() => toggleCollapse(msg.id || "")}
                  className="text-bc-muted hover:text-bc-muted transition-colors text-xs italic w-full text-left"
                >
                  {msg.summary}
                </button>
              ) : (
                <>
                  <div className="whitespace-pre-wrap break-words select-text" data-copyable="true">
                    {enableTypewriter ? (
                      <TypewriterText
                        text={msg.content}
                        enabled={true}
                        charDelay={20}
                        onComplete={() => handleComplete(msg.id || "")}
                      />
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.summary && !isLastMessage && !isUserMessage && msg.id && !collapsed.has(msg.id) && (
                    <button
                      type="button"
                      onClick={() => { if (msg.id) toggleCollapse(msg.id); }}
                      className="text-xs text-bc-subtle hover:text-bc-muted transition-colors mt-0.5"
                    >
                      收起
                    </button>
                  )}
                </>
              )}
              {msg.isLoading && (
                <div className="flex items-center gap-1 mt-1 text-bc-muted text-xs">
                  <span className="loading loading-dots loading-xs text-primary" />
                  处理中
                </div>
              )}
            </div>
          </>
        );

        return (
          <div key={key}>
            {messageContent}
          </div>
        );
      })}
    </div>
  );
}
