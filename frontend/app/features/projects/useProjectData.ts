import { useEffect, useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clearMessageFeed, replaceMessageFeed } from "~/query/messageFeed";
import { projectQueryKeys } from "~/query/queryKeys";
import { projectsApi } from "~/services/api";
import type { Character, Project, Shot } from "~/types";
import { ApiError } from "~/types/errors";
import { toast } from "~/utils/toast";

export function useProjectData(projectId: number): {
	project: Project | undefined;
	characters: Character[];
	shots: Shot[];
	projectLoading: boolean;
	projectError: unknown;
} {
	const queryClient = useQueryClient();
	const messagesLoadedRef = useRef(false);
	const { data: project, isLoading: projectLoading, error: projectError } = useQuery({
		queryKey: projectQueryKeys.project(projectId),
		queryFn: () => projectsApi.get(projectId),
		enabled: projectId > 0,
		retry: 1,
	});
	const { data: characters = [] } = useQuery({
		queryKey: projectQueryKeys.characters(projectId),
		queryFn: () => projectsApi.getCharacters(projectId),
		enabled: !!project,
	});
	const { data: shots = [] } = useQuery({
		queryKey: projectQueryKeys.shots(projectId),
		queryFn: () => projectsApi.getShots(projectId),
		enabled: !!project,
	});
	const { data: messages } = useQuery({
		queryKey: projectQueryKeys.messages(projectId),
		queryFn: () => projectsApi.getMessages(projectId),
		enabled: !!project,
	});

	useLayoutEffect(() => {
		messagesLoadedRef.current = false;
		clearMessageFeed(projectId);
	}, [projectId]);

	useEffect(() => {
		if (projectError) {
			const apiError = projectError instanceof ApiError ? projectError : null;
			toast.error({
				title: "无法加载项目",
				message: apiError?.message || "项目数据获取失败，请重试",
				actions: [
					{
						label: "重试",
						onClick: () =>
							queryClient.invalidateQueries({ queryKey: projectQueryKeys.project(projectId) }),
					},
				],
			});
		}
	}, [projectError, projectId, queryClient]);

	useEffect(() => {
		if (!messages || messagesLoadedRef.current) return;
		messagesLoadedRef.current = true;
		replaceMessageFeed(
			projectId,
			messages.map((message) => ({
				id: `db_${message.id}`,
				agent: message.agent,
				role: message.role,
				content: message.content,
				timestamp: message.created_at,
				progress: message.progress ?? undefined,
				isLoading: false,
			})),
		);
	}, [messages, projectId]);

	return { project, characters, shots, projectLoading, projectError };
}
