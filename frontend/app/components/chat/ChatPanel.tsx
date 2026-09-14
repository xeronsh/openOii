import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEditorStore } from "~/stores/editorStore";
import { readMessageFeed } from "~/query/messageFeed";
import { projectQueryKeys } from "~/query/queryKeys";
import { useRunState } from "~/hooks/useRunState";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { OutlinePreviewCard } from "./OutlinePreviewCard";
import { Button } from "~/components/ui/Button";
import type { WorkflowStage } from "~/types";
import { AGENT_NAME_MAP } from "~/types";
import {
  CheckIcon,
  LightBulbIcon,
  PaintBrushIcon,
  RocketLaunchIcon,
  StopIcon,
  BoltIcon,
  AdjustmentsHorizontalIcon,
} from "@heroicons/react/24/outline";
import { getWorkflowStageInfo } from "~/utils/workflowStage";
import { toast } from "~/utils/toast";
import type { AgentMessage } from "~/types";

/** Stable empty array so the query's fallback does not churn identity. */
const EMPTY_MESSAGES: AgentMessage[] = [];

interface ChatPanelProps {
  projectId: number;
  onSendFeedback: (content: string) => void;
  onConfirm: (feedback?: string) => void;
  onCancel: () => void;
  isGenerating: boolean;
  isPaused?: boolean;
  onPause?: () => void;
  onResume?: () => void;
}

function getStageIcon(stage: WorkflowStage) {
  if (stage === "compose") return RocketLaunchIcon;
  if (stage === "render" || stage === "render_approval") return PaintBrushIcon;
  if (stage === "plan" || stage === "plan_approval") return LightBulbIcon;
  return LightBulbIcon;
}

const agentNameMap = AGENT_NAME_MAP;

export function ChatPanel({
  projectId,
  onSendFeedback,
  onConfirm,
  onCancel,
  isGenerating,
  isPaused = false,
  onPause,
  onResume: _onResume,
}: ChatPanelProps) {
  const {
    currentAgent,
    awaitingConfirm,
    awaitingAgent,
    currentStage,
    currentRunId,
    recoveryGate,
  } = useRunState(projectId);

  // The chat feed is server state, so it is read from the query cache rather
  // than mirrored in the UI store (ADR 0007).
  const messages = useQuery({
    queryKey: projectQueryKeys.messageFeed(projectId),
    queryFn: () => readMessageFeed(projectId),
    staleTime: Infinity,
  }).data ?? EMPTY_MESSAGES;

  const setRunMode = useEditorStore((s) => s.setRunMode);
  const [input, setInput] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollContainerRef.current) {
      if (typeof scrollContainerRef.current.scrollTo === "function") {
        scrollContainerRef.current.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior: "smooth",
        });
      } else {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    // Only gate confirms go through WS confirm. Mid-run "confirm" was a bug:
    // it set Redis without a waiter, then the next gate cleared it — feedback lost.
    if (awaitingConfirm) {
      onConfirm(input.trim());
      setInput("");
      return;
    }
    if (isGenerating || currentRunId) {
      // Active run without a gate: wait for 通过 / stop first, then feedback.
      toast.info({
        title: "请稍候",
        message: "当前阶段进行中；待审阅确认后再反馈，或先停止任务。",
      });
      return;
    }
    onSendFeedback(input);
    setInput("");
  };

  const fallbackStage = currentStage || "plan";
  const info = getWorkflowStageInfo(fallbackStage) ?? {
    title: "规划阶段",
    description: "正在生成剧本、角色与镜头规划",
  };
  const StageIcon = getStageIcon(fallbackStage);
  const hasMessages = messages.length > 0;
  const agentDisplayName = awaitingAgent ? agentNameMap[awaitingAgent] || awaitingAgent : "";
  const runMode = useEditorStore((s) => s.runMode);
  const isYolo = runMode === "yolo";

  const showManualConfirm = awaitingConfirm && !isYolo;
  const showOutlinePreview =
    showManualConfirm && awaitingAgent === "outline" && recoveryGate?.story_outline;
  const handleRunModeToggle = () => {
    const nextMode = isYolo ? "manual" : "yolo";
    setRunMode(nextMode);
    if (nextMode === "yolo" && awaitingConfirm) {
      onConfirm(undefined);
      setInput("");
    }
  };

  return (
    <div className="flex h-full flex-col bg-base-100" data-shell="chat-panel">
      <div className="flex items-center justify-between border-b border-base-content/10 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <StageIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-heading text-xs font-bold">
            {info.title}
          </span>
        </div>

        <button
          type="button"
          onClick={handleRunModeToggle}
          className={`btn h-8 min-h-8 gap-1 border-2 px-2 text-2xs font-heading font-bold ${isYolo ? "btn-primary" : "btn-ghost"}`}
          aria-label={isYolo ? "切换精细审阅模式" : "切换快速生成模式"}
          title={isYolo ? "快速生成：自动确认" : "精细审阅：逐阶段确认"}
        >
          {isYolo ? (
            <>
              <BoltIcon className="h-3.5 w-3.5" aria-hidden="true" />
              快速
            </>
          ) : (
            <>
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
              审阅
            </>
          )}
        </button>
      </div>

      {isGenerating && !awaitingConfirm && (
        <div className="flex items-center justify-between border-b border-base-content/10 px-2 py-0.5">
          <div className="flex items-center gap-1.5 text-2xs text-bc-muted">
            <span className="loading loading-dots loading-xs text-primary" />
            {agentNameMap[currentAgent || ""] || currentAgent || "处理中"}…
            {isYolo && (
              <span className="badge badge-primary badge-outline badge-xs gap-0.5 border">
                <BoltIcon className="h-2 w-2" aria-hidden="true" /> 快速
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            className="h-8 min-h-8 gap-1 px-2 text-error hover:bg-error/10"
            aria-label="停止生成"
          >
            <StopIcon className="h-3.5 w-3.5" aria-hidden="true" /> 停止
          </Button>
        </div>
      )}

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1.5 halftone-bg"
      >
        {!hasMessages && !isGenerating ? (
          <div className="flex h-full flex-col items-center justify-center px-3 text-center">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary/30 bg-primary/10">
              <StageIcon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            </div>
            <p className="m-0 text-2xs text-bc-muted">
              当前阶段暂无对话
            </p>
          </div>
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

      {showOutlinePreview && recoveryGate?.story_outline && (
        <div className="border-t-2 border-primary/30 bg-primary/5 px-2 py-1.5">
          <OutlinePreviewCard
            outline={recoveryGate.story_outline}
            visualBible={recoveryGate.visual_bible}
            onConfirm={() => {
              onConfirm(undefined);
              setInput("");
            }}
            onRegenerate={(feedback) => {
              onConfirm(feedback);
              setInput("");
            }}
          />
        </div>
      )}

      {showManualConfirm && !showOutlinePreview && (
        <div className="border-t-2 border-primary/30 bg-primary/5 px-2 py-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-2xs font-medium text-bc-muted">
              {agentDisplayName} 已完成 — 确认继续？
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const feedback = input.trim();
                onConfirm(feedback || undefined);
                setInput("");
              }}
              className="h-8 min-h-8 gap-1 border-2 px-2 shadow-brutal-sm"
            >
              <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
              通过
            </Button>
          </div>
        </div>
      )}

      {awaitingConfirm && isYolo && isPaused && onPause && (
        <div className="flex items-center gap-1.5 border-t border-base-content/10 bg-primary/5 px-2 py-0.5 text-2xs text-bc-muted">
          <BoltIcon className="h-3.5 w-3.5" aria-hidden="true" />
          快速生成已暂停
          <Button
            size="sm"
            variant="ghost"
            onClick={onPause}
            className="ml-auto h-8 min-h-8 px-2"
          >
            继续
          </Button>
        </div>
      )}

      <div className="border-t border-base-content/10 p-1.5">
        <MessageInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={false}
          placeholder={
            awaitingConfirm
              ? "修改意见（可选）…"
              : isGenerating
                ? "反馈…"
                : "你的想法…"
          }
        />
      </div>
    </div>
  );
}
