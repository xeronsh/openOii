import type {
  ProjectProviderSettings,
  RecoveryControlRead,
  RecoverySummaryRead,
  RunAwaitingConfirmEventData,
  WorkflowStage,
} from "~/types";
import { appQueryClient } from "./client";
import { projectQueryKeys } from "./queryKeys";

/**
 * Live run UI state lives in the query cache, not in Zustand.
 *
 * This is a projection of the durable event stream (run_started / run_progress
 * / run_awaiting_confirm / run_*), i.e. server-owned state. Keeping it in the UI
 * store made it a second home for the same data and forced every websocket
 * event to be written twice.
 */
export interface RunState {
  isGenerating: boolean;
  currentStage: WorkflowStage;
  currentAgent: string | null;
  progress: number;
  currentRunId: number | null;
  currentRunProviderSnapshot: ProjectProviderSettings | null;
  awaitingConfirm: boolean;
  awaitingAgent: string | null;
  recoveryControl: RecoveryControlRead | null;
  recoverySummary: RecoverySummaryRead | null;
  recoveryGate: RunAwaitingConfirmEventData | null;
}

export const INITIAL_RUN_STATE: RunState = {
  isGenerating: false,
  currentStage: "plan",
  currentAgent: null,
  progress: 0,
  currentRunId: null,
  currentRunProviderSnapshot: null,
  awaitingConfirm: false,
  awaitingAgent: null,
  recoveryControl: null,
  recoverySummary: null,
  recoveryGate: null,
};

export function readRunState(projectId: number): RunState {
  return (
    appQueryClient.getQueryData<RunState>(projectQueryKeys.runState(projectId)) ??
    INITIAL_RUN_STATE
  );
}

/** Shallow-merge a patch; a no-op patch keeps the previous object identity. */
export function patchRunState(projectId: number, patch: Partial<RunState>): void {
  const current = readRunState(projectId);
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof RunState>) {
    if (patch[key] !== undefined && patch[key] !== current[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  appQueryClient.setQueryData<RunState>(projectQueryKeys.runState(projectId), {
    ...current,
    ...patch,
  });
}

export function resetRunState(projectId: number): void {
  appQueryClient.setQueryData<RunState>(projectQueryKeys.runState(projectId), INITIAL_RUN_STATE);
}
