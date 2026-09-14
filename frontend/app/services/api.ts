import { ApiError } from "~/types/errors";
import { getApiBase } from "~/utils/runtimeBase";
import type {
	Character,
	CharacterUpdatePayload,
	CreateProjectPayload,
	ExportResponse,
	Project,
	RollbackRequest,
	RollbackResponse,
	Shot,
	ShotReorderItem,
	ShotReorderResponse,
	ShotUpdatePayload,
	StoryOutline,
	StoryOutlineUpdatePayload,
	UpdateProjectPayload,
	VersionCompareRead,
	VersionEntityType,
	VersionListRead,
} from "~/types";

const API_BASE = getApiBase();

function getAdminHeaders(): Record<string, string> {
	try {
		const adminToken = localStorage.getItem("openoii_admin_token");
		return adminToken ? { "X-Admin-Token": adminToken } : {};
	} catch {
		return {};
	}
}

async function parseApiResponse<T>(
	res: Response,
	endpoint: string,
	method: string,
): Promise<T> {
	if (res.status === 204 || res.headers.get("content-length") === "0") {
		return undefined as T;
	}

	let data: T;
	try {
		data = await res.json();
	} catch {
		if (!res.ok) {
			throw new ApiError({
				code: "INVALID_RESPONSE",
				message: "服务器返回了无效的响应格式",
				status: res.status,
				request: { method, url: endpoint },
			});
		}
		return undefined as T;
	}

	if (!res.ok) {
		const errorObj = data as unknown as {
			error?: {
				code?: string;
				message?: string;
				details?: Record<string, unknown>;
			};
		};
		const errorData = errorObj.error || {};
		throw new ApiError({
			code: errorData.code || "API_ERROR",
			message: errorData.message || res.statusText || "请求失败",
			status: res.status,
			details: errorData.details as Record<string, unknown> | undefined,
			request: { method, url: endpoint },
			response: data as Record<string, unknown>,
		});
	}

	return data;
}

/**
 * 将后端静态文件路径转换为完整 URL
 * @param path 后端返回的路径，如 "/static/videos/xxx.mp4"
 * @returns 完整 URL，如 "http://localhost:18765/static/videos/xxx.mp4"
 */
export function getStaticUrl(path: string | null | undefined): string | null {
	if (!path) return null;

	// 安全检查：防止 XSS 和协议注入
	const trimmedPath = path.trim();

	// 只允许 http/https 协议
	if (trimmedPath.startsWith("http://") || trimmedPath.startsWith("https://")) {
		try {
			const url = new URL(trimmedPath);
			// 验证协议
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				console.warn(`[Security] Invalid protocol in URL: ${url.protocol}`);
				return null;
			}
			return trimmedPath;
		} catch {
			console.warn(`[Security] Invalid URL format: ${trimmedPath}`);
			return null;
		}
	}

	// 阻止危险协议
	const dangerousProtocols = [
		"javascript:",
		"data:",
		"vbscript:",
		"file:",
		"about:",
	];
	if (
		dangerousProtocols.some((proto) =>
			trimmedPath.toLowerCase().startsWith(proto),
		)
	) {
		console.warn(`[Security] Dangerous protocol detected: ${trimmedPath}`);
		return null;
	}

	// 拼接 API_BASE
	return `${API_BASE}${trimmedPath}`;
}

async function fetchApi<T>(
	endpoint: string,
	options?: RequestInit,
): Promise<T> {
	try {
		const method = options?.method || "GET";
		const res = await fetch(`${API_BASE}${endpoint}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...getAdminHeaders(),
				...options?.headers,
			},
		});

		return await parseApiResponse<T>(res, endpoint, method);
	} catch (error) {
		// 如果已经是 ApiError，直接抛出
		if (error instanceof ApiError) {
			throw error;
		}

		// 网络错误或其他错误
		throw new ApiError({
			code: "NETWORK_ERROR",
			message: "网络连接失败，请检查您的网络设置",
			details: { originalError: String(error) },
			request: {
				method: options?.method || "GET",
				url: endpoint,
			},
		});
	}
}

async function fetchFormApi<T>(
	endpoint: string,
	formData: FormData,
	method = "POST",
): Promise<T> {
	try {
		const res = await fetch(`${API_BASE}${endpoint}`, {
			method,
			body: formData,
			headers: getAdminHeaders(),
		});
		return await parseApiResponse<T>(res, endpoint, method);
	} catch (error) {
		if (error instanceof ApiError) {
			throw error;
		}

		throw new ApiError({
			code: "NETWORK_ERROR",
			message: "网络连接失败，请检查您的网络设置",
			details: { originalError: String(error) },
			request: { method, url: endpoint },
		});
	}
}

// Projects API
/**
 * run 级操作。run 是一等资源，取消/恢复按 run id 寻址 ——
 * 旧接口是 /projects/{id}/cancel|resume，服务端只能「猜该项目最新的活跃 run」，
 * 同项目存在多个 run（例如并行重绘）时会点错目标。
 */
export const runsApi = {
	cancel: (runId: number) =>
		fetchApi<{ status: string; cancelled: number; run_ids?: number[] }>(
			`/api/v1/runs/${runId}/cancel`,
			{ method: "POST" },
		),

	resume: (runId: number) =>
		fetchApi<import("~/types").AgentRun>(`/api/v1/runs/${runId}/resume`, {
			method: "POST",
		}),
};

export const projectsApi = {
	list: async () => {
		const data = await fetchApi<{ items: Project[]; total: number }>(
			"/api/v1/projects",
		);
		return data.items;
	},

	get: (id: number) => fetchApi<Project>(`/api/v1/projects/${id}`),

	create: (data: CreateProjectPayload) =>
		fetchApi<Project>("/api/v1/projects", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	update: (id: number, data: UpdateProjectPayload) =>
		fetchApi<Project>(`/api/v1/projects/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	delete: (id: number) =>
		fetchApi<void>(`/api/v1/projects/${id}`, { method: "DELETE" }),

	deleteMany: (ids: number[]) =>
		fetchApi<void>("/api/v1/projects/batch-delete", {
			method: "POST",
			body: JSON.stringify({ ids }),
		}),

	uploadReference: async (projectId: number, file: File) => {
		const formData = new FormData();
		formData.append("file", file);
		return fetchFormApi<{ url: string; reference_images: string[] }>(
			`/api/v1/projects/${projectId}/upload-reference`,
			formData,
		);
	},

	getCharacters: (id: number) =>
		fetchApi<Character[]>(`/api/v1/projects/${id}/characters`),

	getShots: (id: number) => fetchApi<Shot[]>(`/api/v1/projects/${id}/shots`),

	reorderShots: (id: number, items: ShotReorderItem[]) =>
		fetchApi<ShotReorderResponse>(`/api/v1/projects/${id}/shots/reorder`, {
			method: "PATCH",
			body: JSON.stringify({ items }),
		}),

	fillEmptyShots: (id: number, type: "image" | "video" = "image") =>
		fetchApi<import("~/types").AgentRun>(
			`/api/v1/projects/${id}/shots/fill-empty`,
			{
				method: "POST",
				body: JSON.stringify({ type }),
			},
		),

	getOutline: (id: number) =>
		fetchApi<StoryOutline | null>(`/api/v1/projects/${id}/outline`),

	updateOutline: (id: number, data: StoryOutlineUpdatePayload) =>
		fetchApi<StoryOutline>(`/api/v1/projects/${id}/outline`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	getMessages: (id: number) =>
		fetchApi<import("~/types").Message[]>(`/api/v1/projects/${id}/messages`),

	/** 创建一次生成 run（POST /projects/{id}/runs）。409 时返回恢复控制面。 */
	startRun: (
		id: number,
		data?: {
			seed?: number;
			notes?: string;
			auto_mode?: boolean;
			skill_id?: string;
			entity_type?: string;
			entity_id?: number;
			entity_ids?: number[];
		},
	) =>
		fetchApi<import("~/types").AgentRun>(`/api/v1/projects/${id}/runs`, {
			method: "POST",
			body: JSON.stringify(data || {}),
		}),

	/** 页面加载时水合运行态：与创建 run 的 409 分支同构的 RecoveryControlRead */
	currentRun: (id: number) =>
		fetchApi<import("~/types").RecoveryControlRead | null>(
			`/api/v1/projects/${id}/runs/current`,
		),

	feedback: (
		id: number,
		content: string,
		runId?: number,
		feedbackType?: string,
		entityType?: string,
		entityId?: number,
		entityIds?: number[],
	) =>
		fetchApi<{ status: string; run_id?: number }>(
			`/api/v1/projects/${id}/runs/feedback`,
			{
				method: "POST",
				body: JSON.stringify({
					content,
					run_id: runId,
					feedback_type: feedbackType,
					entity_type: entityType,
					entity_id: entityId,
					entity_ids: entityIds?.length ? entityIds : undefined,
				}),
			},
		),
};

// Shots API
export const shotsApi = {
	update: (id: number, data: ShotUpdatePayload) =>
		fetchApi<Shot>(`/api/v1/shots/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	approve: (id: number) =>
		fetchApi<Shot>(`/api/v1/shots/${id}/approve`, {
			method: "POST",
		}),
	regenerate: (id: number, type: "image" | "video") =>
		fetchApi<import("~/types").AgentRun>(`/api/v1/shots/${id}/regenerate`, {
			method: "POST",
			body: JSON.stringify({ type }),
		}),
	delete: (id: number) =>
		fetchApi<void>(`/api/v1/shots/${id}`, { method: "DELETE" }),
};

// Characters API
export const charactersApi = {
	update: (id: number, data: CharacterUpdatePayload) =>
		fetchApi<Character>(`/api/v1/characters/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	approve: (id: number) =>
		fetchApi<Character>(`/api/v1/characters/${id}/approve`, {
			method: "POST",
		}),
	regenerate: (id: number) =>
		fetchApi<import("~/types").AgentRun>(
			`/api/v1/characters/${id}/regenerate`,
			{
				method: "POST",
				body: JSON.stringify({ type: "image" }),
			},
		),
	delete: (id: number) =>
		fetchApi<void>(`/api/v1/characters/${id}`, { method: "DELETE" }),

	// Character Bible
	getBible: (id: number) =>
		fetchApi<import("~/types").CharacterBible>(
			`/api/v1/characters/${id}/bible`,
		),

	updateBible: (
		id: number,
		data: { visual_notes?: string | null; reference_images?: string[] },
	) =>
		fetchApi<import("~/types").CharacterBible>(
			`/api/v1/characters/${id}/bible`,
			{
				method: "PUT",
				body: JSON.stringify(data),
			},
		),

	addReferenceImage: (id: number, imageUrl: string) =>
		fetchApi<import("~/types").CharacterBible>(
			`/api/v1/characters/${id}/reference-images`,
			{
				method: "POST",
				body: JSON.stringify({ image_url: imageUrl }),
			},
		),

	deleteReferenceImage: (id: number, index: number) =>
		fetchApi<void>(
			`/api/v1/characters/${id}/reference-images/${index}`,
			{ method: "DELETE" },
		),

	computeEmbedding: (id: number) =>
		fetchApi<Character>(`/api/v1/characters/${id}/compute-embedding`, {
			method: "POST",
		}),
};

// Assets API
export const assetsApi = {
	list: (opts?: { assetType?: string; search?: string; tag?: string }) => {
		const params = new URLSearchParams();
		if (opts?.assetType) params.set("asset_type", opts.assetType);
		if (opts?.search) params.set("search", opts.search);
		if (opts?.tag) params.set("tag", opts.tag);
		const qs = params.toString();
		return fetchApi<import("~/types").AssetList>(
			`/api/v1/assets${qs ? `?${qs}` : ""}`,
		);
	},
	create: (data: import("~/types").AssetCreatePayload) =>
		fetchApi<import("~/types").Asset>("/api/v1/assets", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	createFromCharacter: (characterId: number) =>
		fetchApi<import("~/types").Asset>(
			`/api/v1/assets/from-character/${characterId}`,
			{
				method: "POST",
			},
		),
	createFromShot: (shotId: number) =>
		fetchApi<import("~/types").Asset>(`/api/v1/assets/from-shot/${shotId}`, {
			method: "POST",
		}),
	useInProject: (assetId: number, projectId: number) =>
		fetchApi<import("~/types").Character | import("~/types").Shot>(
			`/api/v1/assets/${assetId}/use-in-project`,
			{
				method: "POST",
				body: JSON.stringify({ project_id: projectId }),
			},
		),
	delete: (id: number) =>
		fetchApi<void>(`/api/v1/assets/${id}`, { method: "DELETE" }),

	uploadImage: async (file: File) => {
		const formData = new FormData();
		formData.append("file", file);
		return fetchFormApi<{ url: string }>("/api/v1/assets/upload-image", formData);
	},
};

// Config API
export const versionsApi = {
	list: (projectId: number, entityType: VersionEntityType, entityId: number) =>
		fetchApi<VersionListRead>(
			`/api/v1/projects/${projectId}/versions?entity_type=${entityType}&entity_id=${entityId}`,
		),
	get: (versionId: number) =>
		fetchApi<import("~/types").ArtifactVersion>(`/api/v1/versions/${versionId}`),
	rollback: (entityType: VersionEntityType, entityId: number, targetVersion: number) =>
		fetchApi<RollbackResponse>("/api/v1/versions/rollback", {
			method: "POST",
			body: JSON.stringify({
				entity_type: entityType,
				entity_id: entityId,
				target_version: targetVersion,
			} satisfies RollbackRequest),
		}),
	compare: (
		projectId: number,
		entityType: VersionEntityType,
		entityId: number,
		v1: number,
		v2: number,
	) =>
		fetchApi<VersionCompareRead>(
			`/api/v1/projects/${projectId}/versions/compare?entity_type=${entityType}&entity_id=${entityId}&v1=${v1}&v2=${v2}`,
		),
};

export type SkillApiRow = {
	id: string;
	title: string;
	description: string;
	badge: string | null;
	start_stage: string;
	start_agent: string;
	prefer_auto_mode: boolean;
	default_style: string | null;
	default_creation_mode: string | null;
	default_target_shot_count: number | null;
	story_prefix: string;
	story_template: string;
	directives: string;
	pipeline_hints: Record<string, unknown>;
	placeholder: string;
	available: boolean;
};

export const skillsApi = {
	list: () => fetchApi<SkillApiRow[]>("/api/v1/skills"),
};

export const configApi = {
	get: () => fetchApi<import("~/types").ConfigItem[]>("/api/v1/config"),
	update: (config: Record<string, import("~/types").ConfigValue>) => {
		const normalizedConfig = Object.fromEntries(
			Object.entries(config).map(([key, value]) => [
				key,
				value === null ? null : String(value),
			]),
		) as Record<string, string | null>;

		return (
			fetchApi<{
				updated: number;
				skipped: number;
				restart_required: boolean;
				restart_keys: string[];
				message: string;
			}>("/api/v1/config", {
				method: "PUT",
				body: JSON.stringify({ configs: normalizedConfig }),
			}).then((res) => {
				if ("ADMIN_TOKEN" in config) {
					const token = config.ADMIN_TOKEN;
					if (typeof token === "string" && token.length > 0) {
						localStorage.setItem("openoii_admin_token", token);
					} else {
						localStorage.removeItem("openoii_admin_token");
					}
				}
				return res;
			})
		);
	},
	testConnection: (
		service: "llm" | "image" | "video",
		configOverrides?: Record<string, string | null>,
	) =>
		fetchApi<{
			success: boolean;
			message: string;
			details: string | null;
			status?: "valid" | "degraded" | "invalid" | null;
			capabilities?: {
				generate?: boolean | null;
				stream?: boolean | null;
			} | null;
		}>("/api/v1/config/test-connection", {
			method: "POST",
			body: JSON.stringify({ service, config_overrides: configOverrides }),
		}),
	revealValue: (key: string) =>
		fetchApi<{ key: string; value: string | null }>("/api/v1/config/reveal", {
			method: "POST",
			body: JSON.stringify({ key }),
		}),
};

export const styleTemplatesApi = {
	list: (params?: { category?: string }) => {
		const qs = params?.category ? `?category=${params.category}` : "";
		return fetchApi<import("~/types").StyleTemplateList>(
			`/api/v1/style-templates${qs}`,
		).then((data) => data.items);
	},

	get: (slug: string) =>
		fetchApi<import("~/types").StyleTemplate>(
			`/api/v1/style-templates/${slug}`,
		),

	create: (data: import("~/types").StyleTemplateCreatePayload) =>
		fetchApi<import("~/types").StyleTemplate>("/api/v1/style-templates", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	update: (slug: string, data: import("~/types").StyleTemplateUpdatePayload) =>
		fetchApi<import("~/types").StyleTemplate>(
			`/api/v1/style-templates/${slug}`,
			{
				method: "PUT",
				body: JSON.stringify(data),
		},
	),

	delete: (slug: string) =>
		fetchApi<void>(`/api/v1/style-templates/${slug}`, {
			method: "DELETE",
		}),
};

// Export API
export const exportApi = {
	triggerWebtoon: (projectId: number) =>
		fetchApi<ExportResponse>(`/api/v1/projects/${projectId}/export/webtoon`, {
			method: "POST",
		}),

	getStatus: (projectId: number, exportId: string) =>
		fetchApi<ExportResponse>(
			`/api/v1/projects/${projectId}/export/${exportId}/status`,
		),
};

// Consistency Evaluation API
export const consistencyApi = {
	triggerEval: (projectId: number) =>
		fetchApi<import("~/types").ConsistencyEvalResponse>(
			`/api/v1/projects/${projectId}/consistency-eval`,
			{ method: "POST" },
		),

	getReport: (projectId: number) =>
		fetchApi<import("~/types").ConsistencyReportRead>(
			`/api/v1/projects/${projectId}/consistency-report`,
		),

	getHistory: (projectId: number, limit?: number) =>
		fetchApi<import("~/types").ConsistencyReportRead[]>(
			`/api/v1/projects/${projectId}/consistency-report/history${limit ? `?limit=${limit}` : ""}`,
		),
};

export const universesApi = {
	list: () =>
		fetchApi<import("~/types").Universe[]>("/api/v1/universes"),

	get: (id: number) =>
		fetchApi<import("~/types").UniverseDetail>(
			`/api/v1/universes/${id}`,
		),

	create: (data: {
		name: string;
		description?: string | null;
		world_setting?: string | null;
		style_rules?: string | null;
		cover_image_url?: string | null;
	}) =>
		fetchApi<import("~/types").Universe>("/api/v1/universes", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	update: (
		id: number,
		data: {
			name?: string | null;
			description?: string | null;
			world_setting?: string | null;
			style_rules?: string | null;
			cover_image_url?: string | null;
			is_active?: boolean | null;
		},
	) =>
		fetchApi<import("~/types").Universe>(`/api/v1/universes/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	delete: (id: number) =>
		fetchApi<void>(`/api/v1/universes/${id}`, { method: "DELETE" }),

	removeProject: (universeId: number, projectId: number) =>
		fetchApi<void>(
			`/api/v1/universes/${universeId}/projects/${projectId}`,
			{ method: "DELETE" },
		),

	listSharedCharacters: (universeId: number) =>
		fetchApi<import("~/types").SharedCharacterRead[]>(
			`/api/v1/universes/${universeId}/shared-characters`,
		),

	promoteCharacter: (universeId: number, characterId: number) =>
		fetchApi<import("~/types").SharedCharacterRead>(
			`/api/v1/universes/${universeId}/shared-characters`,
			{
				method: "POST",
				body: JSON.stringify({ character_id: characterId }),
			},
		),

	importCharacter: (projectId: number, sharedCharacterId: number) =>
		fetchApi<import("~/types").ImportedCharacterRead>(
			`/api/v1/universes/projects/${projectId}/import-character/${sharedCharacterId}`,
			{ method: "POST" },
		),

	importSharedCast: (projectId: number) =>
		fetchApi<import("~/types").ImportSharedCastRead>(
			`/api/v1/universes/projects/${projectId}/import-shared-cast`,
			{ method: "POST" },
		),

	syncCharacter: (characterId: number) =>
		fetchApi<import("~/types").SharedCharacterRead>(
			`/api/v1/universes/characters/${characterId}/sync-to-universe`,
			{ method: "POST" },
		),

	createSharedCharacter: (
		universeId: number,
		data: {
			name: string;
			description?: string | null;
			visual_notes?: string | null;
			canonical_image_url?: string | null;
			character_tags?: string | null;
		},
	) =>
		fetchApi<import("~/types").SharedCharacterRead>(
			`/api/v1/universes/${universeId}/shared-characters/manual`,
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		),

	timeline: (universeId: number, currentProjectId?: number | null) => {
		const q =
			currentProjectId != null
				? `?current_project_id=${currentProjectId}`
				: "";
		return fetchApi<import("~/types").UniverseTimelineRead>(
			`/api/v1/universes/${universeId}/timeline${q}`,
		);
	},
};
