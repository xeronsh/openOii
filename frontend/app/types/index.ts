import type React from "react";

export interface ProjectProviderEntry {
	selected_key: string;
	source: "project" | "default";
	resolved_key: string | null;
	valid: boolean;
	status?: "valid" | "degraded" | "invalid" | null;
	reason_code: string | null;
	reason_message: string | null;
	capabilities?: {
		generate?: boolean | null;
		stream?: boolean | null;
	} | null;
}

export interface ProjectProviderSettings {
	text: ProjectProviderEntry;
	image: ProjectProviderEntry;
	video: ProjectProviderEntry;
}

export type TextProviderKey = "anthropic" | "openai" | "fake";
export type ImageProviderKey = "modelscope" | "openai" | "fake";
export type VideoProviderKey = "openai" | "doubao" | "fake";

export interface ProjectProviderOverridesPayload {
	text_provider_override?: TextProviderKey | null;
	image_provider_override?: ImageProviderKey | null;
	video_provider_override?: VideoProviderKey | null;
}

export interface CreateProjectPayload extends ProjectProviderOverridesPayload {
	skill_id?: string | null;
	title: string;
	story?: string;
	style?: string;
	status?: string | null;
	target_shot_count?: number;
	character_hints?: string[];
	creation_mode?: string;
	reference_images?: string[];
	exports?: string[] | null;
	universe_id?: number | null;
	chapter_number?: number | null;
	chapter_title?: string | null;
}

export type UpdateProjectPayload = { expected_revision?: number } & Partial<
	Pick<
		Project,
			| "title"
			| "story"
			| "style"
			| "status"
			| "target_shot_count"
			| "character_hints"
			| "creation_mode"
			| "reference_images"
			| "exports"
			| "universe_id"
			| "chapter_number"
			| "chapter_title"
			| "skill_id"
	> &
		ProjectProviderOverridesPayload
>;

export interface StoryOutlineAct {
	act: number;
	title: string;
	summary: string;
}

export interface StoryOutline {
	logline: string;
	genre: string[];
	themes: string[];
	setting: string;
	tone: string;
	acts: StoryOutlineAct[];
	emotional_arc: string;
}

export interface StoryOutlineUpdatePayload {
	expected_revision?: number;
	logline?: string | null;
	genre?: string[] | null;
	themes?: string[] | null;
	setting?: string | null;
	tone?: string | null;
	acts?: StoryOutlineAct[] | null;
	emotional_arc?: string | null;
	visual_bible?: string | null;
	summary?: string | null;
	outline_approved?: boolean | null;
}

// Project types
export interface Project {
	id: number;
	/** Optimistic-concurrency version; echoes on writes as expected_revision. */
	revision?: number;
	title: string;
	story: string | null;
	style: string | null;
	summary: string | null; // 剧情摘要
	story_outline?: StoryOutline | null;
	visual_bible?: string | null;
	outline_approved?: boolean;
	video_url: string | null; // 最终拼接视频
	status: string;
	target_shot_count: number | null;
	character_hints: string[];
	creation_mode: string | null;
	reference_images: string[];
	exports?: string[];
	/** Transient: only present on `project_updated` while compose is blocked. */
	blocking_clips?: BlockingClip[] | null;
	created_at: string;
	updated_at: string;
	provider_settings: ProjectProviderSettings;
	universe_id?: number | null;
	chapter_number?: number | null;
	chapter_title?: string | null;
	skill_id?: string | null;
}

export interface Character {
	id: number;
	/** Optimistic-concurrency version; echoes on writes as expected_revision. */
	revision?: number;
	project_id: number;
	name: string;
	description: string | null;
	image_url: string | null;
	reference_images?: string[];
	has_embedding?: boolean;
	visual_notes?: string | null;
	approval_state: ReviewState;
	approval_version: number;
	approved_at: string | null;
	approved_name: string | null;
	approved_description: string | null;
	approved_image_url: string | null;
}

export interface Shot {
	id: number;
	/** Optimistic-concurrency version; echoes on writes as expected_revision. */
	revision?: number;
	project_id: number;
	order: number;
	description: string;
	prompt: string | null; // 视频生成 prompt
	image_prompt: string | null; // 首帧图片生成 prompt
	image_url: string | null; // 首帧图片
	video_url: string | null; // 分镜视频
	duration: number | null;
	camera: string | null;
	motion_note: string | null;
	scene: string | null;
	action: string | null;
	expression: string | null;
	lighting: string | null;
	dialogue: string | null;
	sfx: string | null;
	tts_url?: string | null;
	bgm_type?: string | null;
	seed: number | null;
	character_ids: number[];
	approval_state: ReviewState;
	approval_version: number;
	approved_at: string | null;
	approved_description: string | null;
	approved_prompt: string | null;
	approved_image_prompt: string | null;
	approved_duration: number | null;
	approved_camera: string | null;
	approved_motion_note: string | null;
	approved_scene: string | null;
	approved_action: string | null;
	approved_expression: string | null;
	approved_lighting: string | null;
	approved_dialogue: string | null;
	approved_sfx: string | null;
	approved_character_ids: number[];
}

export type ReviewState = "draft" | "approved" | "superseded";

export interface CharacterUpdatePayload {
	expected_revision?: number;
	name?: string | null;
	description?: string | null;
	image_url?: string | null;
	visual_notes?: string | null;
	reference_images?: string[] | null;
}

export interface ShotUpdatePayload {
	expected_revision?: number;
	order?: number | null;
	description?: string | null;
	prompt?: string | null;
	image_prompt?: string | null;
	duration?: number | null;
	camera?: string | null;
	motion_note?: string | null;
	scene?: string | null;
	action?: string | null;
	expression?: string | null;
	lighting?: string | null;
	dialogue?: string | null;
	sfx?: string | null;
	seed?: number | null;
	character_ids?: number[] | null;
}

export interface ShotReorderItem {
	shot_id: number;
	order: number;
}

export interface ShotReorderResponse {
	shots: Shot[];
}

export type VersionEntityType = "character" | "shot";

export interface ArtifactVersion {
	id: number;
	entity_type: VersionEntityType;
	entity_id: number;
	version: number;
	snapshot: Record<string, unknown>;
	trigger: string;
	created_at: string;
}

export interface VersionListRead {
	entity_type: VersionEntityType;
	entity_id: number;
	versions: ArtifactVersion[];
}

export interface VersionDiff {
	field_name: string;
	old_value: unknown;
	new_value: unknown;
}

export interface VersionCompareRead {
	entity_type: VersionEntityType;
	entity_id: number;
	from_version: ArtifactVersion;
	to_version: ArtifactVersion;
	diffs: VersionDiff[];
}

export interface RollbackRequest {
	entity_type: VersionEntityType;
	entity_id: number;
	target_version: number;
}

export interface RollbackResponse {
	success: boolean;
	message: string;
	new_version: ArtifactVersion | null;
}

export interface AgentRun {
	id: number;
	project_id: number;
	status: string;
	current_agent: string | null;
	progress: number;
	error: string | null;
	resource_type: string | null;
	resource_id: number | null;
	provider_snapshot?: ProjectProviderSettings | null;
	created_at: string;
	updated_at: string;
}

export interface RecoveryStageRead {
	name: string;
	status: "completed" | "current" | "pending" | "blocked";
	artifact_count: number;
}

export interface RecoverySummaryRead {
	project_id: number;
	run_id: number;
	current_stage: string;
	next_stage: string | null;
	preserved_stages: string[];
	stage_history: RecoveryStageRead[];
	resumable: boolean;
}

export interface RecoveryControlRead {
	state: "active" | "recoverable";
	detail: string;
	available_actions: Array<"resume" | "cancel">;
	active_run: AgentRun;
	recovery_summary: RecoverySummaryRead;
}

export interface RunProgressEventData {
	run_id: number;
	project_id?: number;
	current_agent?: string | null;
	current_stage?: string | null;
	stage?: string | null;
	next_stage?: string | null;
	progress: number;
	recovery_summary?: RecoverySummaryRead | null;
}

export interface RunAwaitingConfirmEventData {
	run_id: number;
	project_id?: number;
	agent: string;
	gate?: string | null;
	current_stage?: string | null;
	stage?: string | null;
	next_stage?: string | null;
	recovery_summary: RecoverySummaryRead;
	preserved_stages?: string[];
	message?: string | null;
	completed?: string | null;
	next_step?: string | null;
	question?: string | null;
	auto_mode?: boolean;
	story_outline?: StoryOutline | null;
	visual_bible?: string | null;
}

export interface RunStartedEventData {
	run_id: number;
	project_id?: number;
	provider_snapshot?: ProjectProviderSettings | null;
	current_stage?: string | null;
	stage?: string | null;
	next_stage?: string | null;
	progress?: number;
	current_agent?: string | null;
	recovery_summary?: RecoverySummaryRead | null;
	preserved_stages?: string[];
}

export interface RunCompletedEventData {
	run_id?: number;
	project_id?: number;
	current_stage?: string | null;
	current_agent?: string | null;
	message?: string | null;
	video_generation_pending?: boolean | null;
}

export interface RunFailedEventData {
	run_id?: number;
	project_id?: number;
	error?: string | null;
	agent?: string | null;
	current_stage?: string | null;
}

export interface RunCancelledEventData {
	run_id?: number;
	project_id?: number;
	run_ids?: number[];
	cancelled_count?: number;
}

export interface RunConfirmedEventData {
	run_id: number;
	project_id?: number;
	agent: string;
	gate?: string | null;
	current_stage?: string | null;
	stage?: string | null;
	next_stage?: string | null;
	recovery_summary?: RecoverySummaryRead | null;
	auto_mode?: boolean;
}

export interface VersionCreatedEventData {
	entity_type: VersionEntityType;
	entity_id: number;
	version: number;
	trigger: string;
}

export interface VersionRollbackEventData {
	entity_type: VersionEntityType;
	entity_id: number;
	from_version: number;
	to_version: number;
}

// WebSocket event types
export type WsEventType =
	| "connected"
	| "pong"
	| "echo"
	| "error"
	| "run_started"
	| "run_progress"
	| "run_message"
	| "agent_thinking"
	| "run_completed"
	| "run_failed"
	| "run_awaiting_confirm"
	| "run_confirmed"
	| "run_cancelled"
	| "character_created"
	| "character_updated"
	| "character_deleted"
	| "shot_created"
	| "shot_updated"
	| "shots_reordered"
	| "shot_deleted"
	| "outline_updated"
	| "project_updated"
	| "data_cleared"
	| "critique_result"
	| "bible_updated"
	| "version_created"
	| "version_rollback"
	| "audio_generated"
	| "export_completed"
	| "consistency_eval_completed";

export interface WsEvent {
	type: WsEventType;
	data: Record<string, unknown>;
}

export interface ShotsReorderedEventData {
	project_id: number;
	shots: Shot[];
}

export interface OutlineUpdatedEventData {
	project_id: number;
	story_outline: StoryOutline | null;
	visual_bible?: string | null;
	outline_approved: boolean;
}

export interface CritiqueResultEventData {
	score: number;
	dimensions: Record<string, number>;
	issues: string[];
	suggestions: string[];
	entity_type: string;
	entity_id: number;
	will_regenerate: boolean;
}

export interface BibleUpdatedEventData {
	character_id: number;
	visual_notes: boolean;
	reference_images_count: number;
	has_embedding: boolean;
}

export interface AudioGeneratedEventData {
	shot_id: number;
	tts_url: string | null;
	bgm_type: string | null;
	duration: number | null;
}

export interface ExportResponse {
	export_id: string;
	project_id: number;
	format: string;
	status: "processing" | "completed" | "failed";
	download_url: string | null;
	created_at: string;
}

export interface ExportCompletedEventData {
	export_id: string;
	format: string;
	download_url: string | null;
	status: "completed" | "failed";
	error: string | null;
}

export interface AgentThinkingEventData {
	agent: string;
	phase: "reasoning" | "decision" | "planning" | "reviewing";
	content: string;
	details?: string | null;
}

export interface CharacterBible {
	character_id: number;
	name: string;
	description: string | null;
	visual_notes: string | null;
	reference_images: string[];
	has_embedding: boolean;
	similarity_scores: Array<{ character_id: number; name: string; similarity: number }>;
}

export interface AgentMessage {
	id?: string; // 唯一标识符（前端生成）
	agent: string;
	role: string;
	content: string;
	summary?: string; // 摘要（用于确认环节显示）
	icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
	timestamp?: string;
	progress?: number; // 0-1 之间的进度值
	isLoading?: boolean; // 是否正在加载
	phase?: "reasoning" | "decision" | "planning" | "reviewing"; // 思考链阶段
	details?: string | null; // 思考链补充详情
}

export interface BlockingClip {
	shot_id: number;
	order: number;
	status: string;
	reason: string;
}

export interface ProjectUpdatedPayload {
	id: number;
	title?: string | null;
	story?: string | null;
	style?: string | null;
	summary?: string | null;
	video_url?: string | null;
	status?: string | null;
	target_shot_count?: number | null;
	character_hints?: string[] | null;
	creation_mode?: string | null;
	reference_images?: string[] | null;
	exports?: string[] | null;
	provider_settings?: ProjectProviderSettings | null;
	universe_id?: number | null;
	chapter_number?: number | null;
	chapter_title?: string | null;
	skill_id?: string | null;
	story_outline?: StoryOutline | null;
	visual_bible?: string | null;
	outline_approved?: boolean | null;
	blocking_clips?: BlockingClip[] | null;
}

export interface DataClearedEventData {
	cleared_types: string[];
	start_agent?: string | null;
	mode?: string | null;
}

export interface UniverseTimelineChapter {
	project_id: number;
	chapter_number: number | null;
	chapter_title: string | null;
	title: string;
	summary: string | null;
	status: string;
	is_main_story: boolean;
	is_current: boolean;
	character_count: number;
	shot_count: number;
	has_video: boolean;
	style: string | null;
}

export interface UniverseTimelineRead {
	universe_id: number;
	universe_name: string;
	world_setting: string | null;
	style_rules: string | null;
	shared_character_count: number;
	chapters: UniverseTimelineChapter[];
	shared_characters?: SharedCharacterRead[];
}

export interface ImportSharedCastRead {
	project_id: number;
	imported_count: number;
	imported: ImportedCharacterRead[];
	skipped_existing: number;
}

export interface Message {
	id: number;
	project_id: number;
	run_id: number | null;
	agent: string;
	role: string;
	content: string;
	summary: string | null;
	progress: number | null;
	is_loading: boolean;
	created_at: string;
}

// 工作流阶段类型（与后端 Phase2 graph 对齐）
export type WorkflowStage =
	| "plan"
	| "plan_approval"
	| "render"
	| "render_approval"
	| "compose"
	| "review";

// Config types
export type ConfigValue = string | number | boolean | null;

// 后端 API 返回的配置项格式
export interface ConfigItem {
	key: string;
	value: string | null;
	is_sensitive: boolean;
	is_masked: boolean;
	source: "db" | "env" | "default";
}

export const AGENT_NAME_MAP: Record<string, string> = {
	outline: "大纲",
	plan: "规划",
	render: "渲染",
	character: "角色",
	shot: "分镜",
	compose: "合成",
	review: "审查",
	critic: "质量审查",
};

export interface Asset {
	id: number;
	name: string;
	asset_type: "character" | "scene";
	description: string | null;
	image_url: string | null;
	metadata_json: string | null;
	source_project_id: number | null;
	tags: string | null;
	created_at: string;
	updated_at: string;
}

export interface AssetList {
	items: Asset[];
	total: number;
}

export interface AssetCreatePayload {
	name: string;
	asset_type: "character" | "scene";
	description?: string | null;
	image_url?: string | null;
	metadata_json?: string | null;
	source_project_id?: number | null;
	tags?: string | null;
}

export interface StyleTemplateList {
	items: StyleTemplate[];
	total: number;
}

export interface StyleTemplate {
	id: number;
	name: string;
	slug: string;
	category: "builtin" | "custom";
	description: string | null;
	style_prompt: string;
	color_palette: string[];
	negative_prompt: string | null;
	preview_image_url: string | null;
	sort_order: number;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface StyleTemplateCreatePayload {
	name: string;
	slug: string;
	description?: string | null;
	style_prompt: string;
	color_palette?: string[];
	negative_prompt?: string | null;
	preview_image_url?: string | null;
}

export interface StyleTemplateUpdatePayload {
	name?: string | null;
	description?: string | null;
	style_prompt?: string | null;
	color_palette?: string[] | null;
	negative_prompt?: string | null;
	preview_image_url?: string | null;
}

// Consistency Evaluation Types
export interface FaceMatchDetailRead {
	shot_id: number;
	shot_order: number;
	similarity: number;
	detected: boolean;
}

export interface CharacterConsistencyRead {
	character_id: number;
	character_name: string;
	face_similarity_mean: number;
	face_similarity_std: number;
	presence_rate: number;
	overall_score: number;
	face_matches: FaceMatchDetailRead[];
	grade: string; // A/B/C/D/F
}

export interface ProjectConsistencyRead {
	project_id: number;
	overall_score: number;
	character_reports: CharacterConsistencyRead[];
	evaluated_at: string;
	eval_id?: number;
}

export interface ConsistencyEvalResponse {
	eval_id: number;
	status: string;
}

export interface ConsistencyReportRead {
	id: number;
	project_id: number;
	overall_score: number;
	created_at: string;
	report_data: ProjectConsistencyRead | null;
}

export interface ConsistencyEvalCompletedEventData {
	project_id: number;
	overall_score: number;
	character_count: number;
}

// ── Universe / IP 宇宙 ──────────────────────────────────────

export interface Universe {
	id: number;
	name: string;
	description: string | null;
	world_setting: string | null;
	style_rules: string | null;
	cover_image_url: string | null;
	is_active: boolean;
	created_at: string;
	updated_at: string;
	projects_count: number;
	shared_characters_count: number;
}

export interface UniverseDetail extends Universe {
	chapters: UniverseProjectLinkRead[];
	shared_characters: SharedCharacterRead[];
}

export interface UniverseProjectLinkRead {
	id: number;
	universe_id: number;
	project_id: number;
	chapter_number: number | null;
	chapter_title: string | null;
	is_main_story: boolean;
	created_at: string;
	project_title: string | null;
}

export interface ImportedCharacterRead {
	id: number;
	name: string;
	project_id: number;
}

export interface SharedCharacterRead {
	id: number;
	universe_id: number;
	name: string;
	description: string | null;
	visual_notes: string | null;
	canonical_image_url: string | null;
	reference_images: string[];
	has_embedding: boolean;
	// face_embedding 不返回给前端（安全考虑）
	character_tags: string | null;
	source_project_id: number | null;
	source_character_id: number | null;
	version: number;
	is_active: boolean;
	created_at: string;
	updated_at: string;
	reference_images_count: number;
}
