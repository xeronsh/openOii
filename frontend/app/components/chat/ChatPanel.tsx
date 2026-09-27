import { useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEditorStore } from "~/stores/editorStore";
import { readMessageFeed } from "~/query/messageFeed";
import { projectQueryKeys } from "~/query/queryKeys";
import { useRunState } from "~/hooks/useRunState";
import { MessageList } from "./MessageList";
import { Button } from "~/components/ui/Button";
import { AGENT_NAME_MAP, type WorkflowStage } from "~/types";
import {
  LightBulbIcon,
  PaintBrushIcon,
  RocketLaunchIcon,
  StopIcon,
  BoltIcon,
  AdjustmentsHorizontalIcon,
} from "@heroicons/react/24/outline";
import { getWorkflowStageInfo } from "~/utils/workflowStage";
import type { AgentMessage } from "~/types";

/** Stable empty array so the query's fallback does not churn identity. */
const EMPTY_MESSAGES: AgentMessage[] = [];

interface ChatPanelProps {
	projectId: number;
	onConfirm: (feedback?: string) => void;
	onCancel: () => void;
	isGenerating: boolean;
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
	onConfirm,
	onCancel,
	isGenerating,
}: ChatPanelProps) {
  const {
    currentAgent,
    awaitingConfirm,
    currentStage,
  } = useRunState(projectId);

  // The chat feed is server state, so it is read from the query cache rather
  // than mirrored in the UI store (ADR 0007).
  const messages = useQuery({
    queryKey: projectQueryKeys.messageFeed(projectId),
    queryFn: () => readMessageFeed(projectId),
    staleTime: Infinity,
  }).data ?? EMPTY_MESSAGES;

  const setRunMode = useEditorStore((s) => s.setRunMode);
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

  const fallbackStage = currentStage || "plan";
  const info = getWorkflowStageInfo(fallbackStage) ?? {
    title: "规划阶段",
    description: "正在生成剧本、角色与镜头规划",
  };
  const StageIcon = getStageIcon(fallbackStage);
  const hasMessages = messages.length > 0;
  const runMode = useEditorStore((s) => s.runMode);
  const isYolo = runMode === "yolo";

  const handleRunModeToggle = () => {
    const nextMode = isYolo ? "manual" : "yolo";
    setRunMode(nextMode);
    if (nextMode === "yolo" && awaitingConfirm) {
      onConfirm(undefined);
    }
  };

	return (
		<div className="flex h-full flex-col bg-paper-100" data-shell="activity-feed">
      <div className="flex items-center justify-between border-b border-ink/10 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <StageIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-heading text-xs font-bold">
            {info.title}
          </span>
        </div>

		<Button
			onClick={handleRunModeToggle}
			variant={isYolo ? "primary" : "ghost"}
		size="sm"
			className="h-8 min-h-8 border-2 px-2 text-2xs font-heading font-bold"
			aria-label={isYolo ? "切换交互模式" : "切换 YOLO 模式"}
			title={isYolo ? "YOLO 模式：自动确认" : "交互模式：逐阶段确认"}
		>
          {isYolo ? (
            <>
              <BoltIcon className="h-3.5 w-3.5" aria-hidden="true" />
				  YOLO
            </>
          ) : (
            <>
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
				  交互
            </>
          )}
		</Button>
      </div>

      {isGenerating && !awaitingConfirm && (
        <div className="flex items-center justify-between border-b border-ink/10 px-2 py-0.5">
          <div className="flex items-center gap-1.5 text-2xs text-ink-muted">
			<span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            {agentNameMap[currentAgent || ""] || currentAgent || "处理中"}…
            {isYolo && (
				<span className="inline-flex items-center gap-0.5 rounded-full border border-primary/30 px-1.5 text-2xs text-primary">
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
            <p className="m-0 text-2xs text-ink-muted">
              暂无活动记录
            </p>
          </div>
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

    </div>
  );
}
