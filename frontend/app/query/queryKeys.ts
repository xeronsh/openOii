export const projectQueryKeys = {
  project: (projectId: number) => ["project", projectId] as const,
  characters: (projectId: number) => ["characters", projectId] as const,
  shots: (projectId: number) => ["shots", projectId] as const,
  messages: (projectId: number) => ["messages", projectId] as const,
  /** Live chat feed appended from websocket events (not an HTTP query). */
  messageFeed: (projectId: number) => ["message-feed", projectId] as const,
  generationState: (projectId: number) => ["generation-state", projectId] as const,
  projects: () => ["projects"] as const,
};
