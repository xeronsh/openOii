import { useQuery } from "@tanstack/react-query";
import { projectQueryKeys } from "~/query/queryKeys";
import { readRunState, type RunState } from "~/query/runState";

/**
 * Reactive read of the live run UI projection.
 *
 * The run state lives in the application query cache (a projection of the
 * durable event stream, written by `applyWsEvent` and HTTP hydration).
 * `staleTime: Infinity` because the cache is the source — the query only
 * subscribes the component to `setQueryData` updates.
 */
export function useRunState(projectId: number): RunState {
	const { data } = useQuery({
		queryKey: projectQueryKeys.runState(projectId),
		queryFn: () => readRunState(projectId),
		staleTime: Infinity,
	});
	return data ?? readRunState(projectId);
}
