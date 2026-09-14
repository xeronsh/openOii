import type { QueryClient } from "@tanstack/react-query";
import type {
  AudioGeneratedEventData,
  Character,
  OutlineUpdatedEventData,
  Project,
  ProjectUpdatedPayload,
  Shot,
  ShotsReorderedEventData,
  WsEvent,
} from "~/types";
import { projectQueryKeys } from "./queryKeys";

function upsertById<T extends { id: number }>(items: T[] | undefined, item: T): T[] | undefined {
  if (!items) return undefined;
  const index = items.findIndex((current) => current.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

function removeById<T extends { id: number }>(items: T[] | undefined, id: number): T[] | undefined {
  return items?.filter((item) => item.id !== id);
}

function patchProject(
  queryClient: QueryClient,
  projectId: number,
  patch: Partial<Project>,
): void {
  let hadCachedProject = false;
  queryClient.setQueryData<Project>(projectQueryKeys.project(projectId), (current) => {
    if (!current) return current;
    hadCachedProject = true;
    return { ...current, ...patch };
  });
  if (!hadCachedProject) {
    void queryClient.invalidateQueries({ queryKey: projectQueryKeys.project(projectId) });
  }
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.projects() });
}

/**
 * The only transport → server-state projection boundary.
 *
 * Zustand owns local interaction/run UI only. Durable project entities live in
 * TanStack Query and websocket events update the same cache that HTTP queries
 * hydrate, preventing two competing server-state sources of truth.
 */
export function applyServerEvent(
  queryClient: QueryClient,
  projectId: number,
  event: WsEvent,
): void {
  switch (event.type) {
    case "character_created":
    case "character_updated": {
      const character = event.data.character as Character | undefined;
      if (!character) return;
      queryClient.setQueryData<Character[]>(
        projectQueryKeys.characters(projectId),
        (current) => upsertById(current, character),
      );
      return;
    }

    case "character_deleted": {
      const id = event.data.character_id as number | undefined;
      if (id === undefined) return;
      queryClient.setQueryData<Character[]>(
        projectQueryKeys.characters(projectId),
        (current) => removeById(current, id),
      );
      return;
    }

    case "shot_created":
    case "shot_updated": {
      const shot = event.data.shot as Shot | undefined;
      if (!shot) return;
      queryClient.setQueryData<Shot[]>(projectQueryKeys.shots(projectId), (current) =>
        upsertById(current, shot),
      );
      return;
    }

    case "shots_reordered": {
      const data = event.data as unknown as ShotsReorderedEventData;
      if (!Array.isArray(data.shots)) return;
      queryClient.setQueryData<Shot[]>(
        projectQueryKeys.shots(projectId),
        [...data.shots].sort((a, b) => a.order - b.order || a.id - b.id),
      );
      return;
    }

    case "shot_deleted": {
      const id = event.data.shot_id as number | undefined;
      if (id === undefined) return;
      queryClient.setQueryData<Shot[]>(projectQueryKeys.shots(projectId), (current) =>
        removeById(current, id),
      );
      return;
    }

    case "project_updated": {
      const project = event.data.project as ProjectUpdatedPayload | undefined;
      if (!project) return;
      const { id: _id, ...patch } = project;
      patchProject(queryClient, projectId, patch as Partial<Project>);
      return;
    }

    case "outline_updated": {
      const data = event.data as unknown as OutlineUpdatedEventData;
      patchProject(queryClient, projectId, {
        story_outline: data.story_outline,
        visual_bible: data.visual_bible ?? null,
        outline_approved: data.outline_approved,
      });
      return;
    }

    case "audio_generated": {
      const data = event.data as unknown as AudioGeneratedEventData;
      queryClient.setQueryData<Shot[]>(projectQueryKeys.shots(projectId), (current) => {
        if (!current || !data.shot_id) return current;
        return current.map((shot) =>
          shot.id === data.shot_id
            ? {
                ...shot,
                tts_url: data.tts_url ?? shot.tts_url,
                bgm_type: data.bgm_type ?? shot.bgm_type,
              }
            : shot,
        );
      });
      return;
    }

    case "data_cleared": {
      const cleared = event.data.cleared_types as string[] | undefined;
      if (cleared?.includes("characters")) {
        queryClient.setQueryData<Character[]>(projectQueryKeys.characters(projectId), []);
      }
      if (cleared?.includes("shots")) {
        queryClient.setQueryData<Shot[]>(projectQueryKeys.shots(projectId), []);
      }
      patchProject(queryClient, projectId, { video_url: null });
      return;
    }

    case "run_completed":
    case "run_failed":
    case "run_cancelled": {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.generationState(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.project(projectId) });
      return;
    }

    case "version_rollback": {
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.characters(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.shots(projectId) });
      return;
    }

    default:
      return;
  }
}
