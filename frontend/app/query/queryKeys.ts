export const projectQueryKeys = {
  project: (projectId: number) => ["project", projectId] as const,
  characters: (projectId: number) => ["characters", projectId] as const,
  shots: (projectId: number) => ["shots", projectId] as const,
  messages: (projectId: number) => ["messages", projectId] as const,
  /** Live chat feed appended from websocket events (not an HTTP query). */
  messageFeed: (projectId: number) => ["message-feed", projectId] as const,
  /** Live run UI projection (run_started/progress/awaiting_confirm/terminal). */
  runState: (projectId: number) => ["run-state", projectId] as const,
  runTiming: (runId: number) => ["run-timing", runId] as const,
  projects: () => ["projects"] as const,
  /** Project assistant conversation (GET /chat, patched by chat_* WS events). */
  chat: (projectId: number) => ["chat", projectId] as const,
  /** 重新生成确认框的计划 + 上一版（GET runs/regenerate-plan）。 */
  regeneratePlan: (projectId: number) => ["regenerate-plan", projectId] as const,
};
