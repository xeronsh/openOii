import type { AgentMessage } from "~/types";
import { appQueryClient } from "./client";
import { projectQueryKeys } from "./queryKeys";

/**
 * The project message feed lives in the query cache, not in Zustand.
 *
 * Messages are server-originated (hydrated once over HTTP, then appended from
 * durable websocket events), so keeping them in the UI store made them a second
 * copy of server state. Reads and writes now go through the same cache as every
 * other server-shaped value, which is what makes the single-reducer shape
 * possible: a websocket event updates the cache and components re-render.
 */
export function readMessageFeed(projectId: number): AgentMessage[] {
  return appQueryClient.getQueryData<AgentMessage[]>(projectQueryKeys.messageFeed(projectId)) ?? [];
}

export function appendMessage(projectId: number, message: AgentMessage): void {
  appQueryClient.setQueryData<AgentMessage[]>(
    projectQueryKeys.messageFeed(projectId),
    (current) => [...(current ?? []), message],
  );
}

export function replaceMessageFeed(projectId: number, messages: AgentMessage[]): void {
  appQueryClient.setQueryData<AgentMessage[]>(projectQueryKeys.messageFeed(projectId), messages);
}

export function clearMessageFeed(projectId: number): void {
  appQueryClient.setQueryData<AgentMessage[]>(projectQueryKeys.messageFeed(projectId), []);
}

/**
 * Apply a transformation only when it actually changes something, so a no-op
 * (e.g. "no loading messages to clear") does not churn the cache and re-render.
 */
export function updateMessageFeed(
  projectId: number,
  transform: (messages: AgentMessage[]) => AgentMessage[],
): void {
  const current = readMessageFeed(projectId);
  const next = transform(current);
  if (next.length === current.length && next.every((msg, index) => msg === current[index])) {
    return;
  }
  replaceMessageFeed(projectId, next);
}
