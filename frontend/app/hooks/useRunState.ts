import { useQuery } from "@tanstack/react-query";
import { projectQueryKeys } from "~/query/queryKeys";
import { readRunState, type RunState } from "~/query/runState";
import { projectsApi } from "~/services/api";
import { toSimplifiedStage } from "~/utils/workflowStage";

/**
 * Reactive read of the live run UI projection.
 *
 * HTTP recovery state and websocket events share one query-cache projection.
 */
export function useRunState(projectId: number): RunState {
	const { data } = useQuery({
		queryKey: projectQueryKeys.runState(projectId),
		enabled: projectId > 0,
		retry: 1,
		queryFn: async () => {
			const revision = readRunState(projectId).revision;
			const control = await projectsApi.currentRun(projectId);
			const live = readRunState(projectId);
			if (
				!control ||
				live.revision !== revision ||
				live.isGenerating ||
				live.currentRunId
			) return live;

			const summary = control.recovery_summary;
			const stage = toSimplifiedStage(summary.next_stage ?? summary.current_stage);
			return {
				...live,
				recoveryControl: control,
				recoverySummary: summary,
				...(stage ? { currentStage: stage } : {}),
				...(control.state === "active"
					? {
							isGenerating: true,
							currentRunId: control.active_run.id,
							currentAgent: control.active_run.current_agent,
							progress: control.active_run.progress,
							currentRunProviderSnapshot:
								control.active_run.provider_snapshot ?? null,
						}
					: {}),
			};
		},
		staleTime: 0,
		refetchOnWindowFocus: false,
	});
	return data ?? readRunState(projectId);
}
