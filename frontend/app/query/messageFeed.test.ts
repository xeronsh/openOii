import { beforeEach, describe, expect, it } from "vitest";
import { appQueryClient } from "./client";
import {
  appendMessage,
  clearMessageFeed,
  readMessageFeed,
  replaceMessageFeed,
  updateMessageFeed,
} from "./messageFeed";
import { projectQueryKeys } from "./queryKeys";
import type { AgentMessage } from "~/types";

function message(id: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id,
    agent: "plan",
    role: "assistant",
    content: `content ${id}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The chat feed is server-originated but used to live in the UI store, which
 * made it a second copy of server state. It now shares the query cache so a
 * websocket event and the HTTP hydration write to the same place.
 */
describe("message feed", () => {
  beforeEach(() => {
    appQueryClient.setQueryData(projectQueryKeys.messageFeed(7), []);
  });

  it("appends without dropping earlier messages", () => {
    appendMessage(7, message("a"));
    appendMessage(7, message("b"));

    expect(readMessageFeed(7).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("replaces the whole feed (HTTP hydration after a websocket append)", () => {
    appendMessage(7, message("live"));
    replaceMessageFeed(7, [message("db_1"), message("db_2")]);

    expect(readMessageFeed(7).map((m) => m.id)).toEqual(["db_1", "db_2"]);
  });

  it("clears the feed", () => {
    appendMessage(7, message("a"));
    clearMessageFeed(7);

    expect(readMessageFeed(7)).toEqual([]);
  });

  it("keeps feeds isolated per project", () => {
    appQueryClient.setQueryData(projectQueryKeys.messageFeed(8), []);
    appendMessage(7, message("p7"));
    appendMessage(8, message("p8"));

    expect(readMessageFeed(7).map((m) => m.id)).toEqual(["p7"]);
    expect(readMessageFeed(8).map((m) => m.id)).toEqual(["p8"]);
  });

  it("does not churn the cache when a transformation changes nothing", () => {
    appendMessage(7, message("a"));
    const before = readMessageFeed(7);

    updateMessageFeed(7, (messages) => messages);

    // Same array identity: subscribers must not re-render for a no-op.
    expect(readMessageFeed(7)).toBe(before);
  });

  it("writes when a transformation does change something", () => {
    appendMessage(7, message("a", { isLoading: true }));

    updateMessageFeed(7, (messages) =>
      messages.map((m) => (m.isLoading ? { ...m, isLoading: false } : m)),
    );

    expect(readMessageFeed(7)[0]?.isLoading).toBe(false);
  });

  it("treats an absent project feed as empty", () => {
    expect(readMessageFeed(999)).toEqual([]);
  });
});
