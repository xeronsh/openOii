import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type {
	AgentMessage,
	BlockingClip,
	Character,
	ProjectProviderSettings,
	RecoveryControlRead,
	RecoverySummaryRead,
	ProjectUpdatedPayload,
	RunAwaitingConfirmEventData,
	Shot,
	StoryOutline,
	WorkflowStage,
} from "~/types";

export type RunMode = "manual" | "yolo";

/**
 * 服务端 project patch：WS `project_updated` 的 payload 形状。
 *
 * `id` 是 payload 的必填字段（用于标识项目），但 store 按当前路由项目存状态，
 * 不需要它，所以 patchProject 显式忽略 id —— 调用方可以整份 payload 直接透传。
 */
export type ProjectPatch = ProjectUpdatedPayload;

/**
 * patch key → store 字段。**必须覆盖 ProjectPatch 的每个可选字段**：
 * 它是 `Record<...>` 而非 Partial，少一个 key 会编译失败。
 * 旧实现用 `Partial<Record<...>>` + 运行时 if，新字段加进 payload 后
 * 没人记得来改这里，字段就被静默丢弃（skill_id 就是这么丢的）。
 * value 为 undefined 时跳过，保证 patch 的语义是「部分更新」。
 */
const PROJECT_PATCH_FIELDS: Record<
	Exclude<keyof ProjectPatch, "id">,
	keyof EditorState
> = {
	title: "projectTitle",
	story: "projectStory",
	style: "projectStyle",
	summary: "projectSummary",
	video_url: "projectVideoUrl",
	status: "projectStatus",
	target_shot_count: "projectTargetShotCount",
	character_hints: "projectCharacterHints",
	creation_mode: "projectCreationMode",
	reference_images: "projectReferenceImages",
	exports: "projectExports",
	provider_settings: "projectProviderSettings",
	universe_id: "projectUniverseId",
	chapter_number: "projectChapterNumber",
	chapter_title: "projectChapterTitle",
	skill_id: "projectSkillId",
	story_outline: "projectStoryOutline",
	visual_bible: "projectVisualBible",
	outline_approved: "projectOutlineApproved",
	blocking_clips: "blockingClips",
};

interface EditorState {
	selectedShotId: number | null;
	selectedCharacterId: number | null;
	highlightedMessageIndex: number | null;
	isGenerating: boolean;
	currentStage: WorkflowStage;
	currentAgent: string | null;
	progress: number;
	messages: AgentMessage[];
	recoveryControl: RecoveryControlRead | null;
	recoverySummary: RecoverySummaryRead | null;
	recoveryGate: RunAwaitingConfirmEventData | null;
	awaitingConfirm: boolean;
	awaitingAgent: string | null;
	currentRunId: number | null;
	currentRunProviderSnapshot: ProjectProviderSettings | null;
	runMode: RunMode;
	characters: Character[];
	shots: Shot[];
	projectVideoUrl: string | null;
	projectStatus: string | null;
	projectUpdatedAt: number | null;
	projectTitle: string | null;
	projectSummary: string | null;
	projectStoryOutline: StoryOutline | null;
	projectVisualBible: string | null;
	projectOutlineApproved: boolean;
	projectStory: string | null;
	projectStyle: string | null;
	projectTargetShotCount: number | null;
	projectCharacterHints: string[] | null;
	projectCreationMode: string | null;
	projectReferenceImages: string[] | null;
	projectExports: string[] | null;
	projectProviderSettings: ProjectProviderSettings | null;
	projectUniverseId: number | null;
	projectChapterNumber: number | null;
	projectChapterTitle: string | null;
	projectSkillId: string | null;
	blockingClips: BlockingClip[] | null;

	setSelectedShot: (id: number | null) => void;
	setSelectedCharacter: (id: number | null) => void;
	setHighlightedMessage: (index: number | null) => void;
	setGenerating: (isGenerating: boolean) => void;
	setCurrentStage: (stage: WorkflowStage) => void;
	setCurrentAgent: (agent: string | null) => void;
	setProgress: (progress: number) => void;
	addMessage: (message: AgentMessage) => void;
	setMessages: (messages: AgentMessage[]) => void;
	clearMessages: () => void;
	setRecoveryControl: (control: RecoveryControlRead | null) => void;
	setRecoverySummary: (summary: RecoverySummaryRead | null) => void;
	setRecoveryGate: (gate: RunAwaitingConfirmEventData | null) => void;
	setCharacters: (characters: Character[]) => void;
	setShots: (shots: Shot[]) => void;
	setProjectUpdatedAt: (timestamp: number) => void;
	/** 用一份 project patch 更新所有项目字段。
	 *  单一映射点：WS 的 project_updated 与页面水合都走它，
	 *  避免字段映射散落三处（曾漏掉 skill_id 导致静默丢字段）。 */
	patchProject: (patch: ProjectPatch) => void;
	setAwaitingConfirm: (
		awaiting: boolean,
		agent?: string | null,
		runId?: number | null,
	) => void;
	setCurrentRunId: (runId: number | null) => void;
	setCurrentRunProviderSnapshot: (
		snapshot: ProjectProviderSettings | null,
	) => void;
	setRunMode: (mode: RunMode) => void;
	updateCharacter: (character: Character) => void;
	updateShot: (shot: Shot) => void;
	removeCharacter: (characterId: number) => void;
	removeShot: (shotId: number) => void;
	resetRunState: () => void;
	reset: () => void;
}

const initialRunState = {
	isGenerating: false,
	currentAgent: null,
	progress: 0,
	recoveryControl: null,
	recoverySummary: null,
	recoveryGate: null,
	awaitingConfirm: false,
	awaitingAgent: null,
	currentRunId: null,
	currentRunProviderSnapshot: null,
};

const initialState = {
	selectedShotId: null,
	selectedCharacterId: null,
	highlightedMessageIndex: null,
	currentStage: "plan" as WorkflowStage,
	runMode: "manual" as RunMode,
	messages: [],
	characters: [],
	shots: [],
	projectVideoUrl: null,
	projectStatus: null,
	projectUpdatedAt: null,
	projectTitle: null,
	projectSummary: null,
	projectStoryOutline: null,
	projectVisualBible: null,
	projectOutlineApproved: false,
	projectStory: null,
	projectStyle: null,
	projectTargetShotCount: null,
	projectCharacterHints: null,
	projectCreationMode: null,
	projectReferenceImages: null,
	projectExports: null,
	projectProviderSettings: null,
	projectUniverseId: null,
	projectChapterNumber: null,
	projectChapterTitle: null,
	projectSkillId: null,
	blockingClips: null,
	...initialRunState,
};

export const useEditorStore = create<EditorState>()(
	devtools(
		(set) => ({
			...initialState,

			setSelectedShot: (id) =>
				set({ selectedShotId: id }, false, "setSelectedShot"),
			setSelectedCharacter: (id) =>
				set({ selectedCharacterId: id }, false, "setSelectedCharacter"),
			setHighlightedMessage: (index) =>
				set({ highlightedMessageIndex: index }, false, "setHighlightedMessage"),
			setGenerating: (isGenerating) =>
				set({ isGenerating }, false, "setGenerating"),
			setCurrentStage: (stage) =>
				set({ currentStage: stage }, false, "setCurrentStage"),
			setCurrentAgent: (agent) =>
				set({ currentAgent: agent }, false, "setCurrentAgent"),
			setProgress: (progress) => set({ progress }, false, "setProgress"),
			addMessage: (message) =>
				set(
					(state) => ({ messages: [...state.messages, message] }),
					false,
					"addMessage",
				),
			setMessages: (messages) => set({ messages }, false, "setMessages"),
			clearMessages: () =>
				set(
					{ messages: [], highlightedMessageIndex: null },
					false,
					"clearMessages",
				),
			setRecoveryControl: (control) =>
				set({ recoveryControl: control }, false, "setRecoveryControl"),
			setRecoverySummary: (summary) =>
				set({ recoverySummary: summary }, false, "setRecoverySummary"),
			setRecoveryGate: (gate) =>
				set({ recoveryGate: gate }, false, "setRecoveryGate"),
			setCharacters: (characters) =>
				set({ characters }, false, "setCharacters"),
			setShots: (shots) => set({ shots }, false, "setShots"),
			setProjectUpdatedAt: (timestamp) =>
				set({ projectUpdatedAt: timestamp }, false, "setProjectUpdatedAt"),
			patchProject: (patch) => {
				const next: Partial<EditorState> = {};
				for (const [key, value] of Object.entries(patch)) {
					if (key === "id") continue;
					const field =
						PROJECT_PATCH_FIELDS[key as Exclude<keyof ProjectPatch, "id">];
					if (field && value !== undefined) {
						(next as Record<string, unknown>)[field] =
							key === "outline_approved" ? Boolean(value) : value;
					}
				}
				if (Object.keys(next).length > 0) {
					set(next, false, "patchProject");
				}
			},
			setAwaitingConfirm: (awaiting, agent = null, runId) =>
				set(
					(state) => ({
						awaitingConfirm: awaiting,
						awaitingAgent: agent,
						currentRunId: runId !== undefined ? runId : state.currentRunId,
					}),
					false,
					"setAwaitingConfirm",
				),
			setCurrentRunId: (runId) =>
				set({ currentRunId: runId }, false, "setCurrentRunId"),
			setCurrentRunProviderSnapshot: (snapshot) =>
				set(
					{ currentRunProviderSnapshot: snapshot },
					false,
					"setCurrentRunProviderSnapshot",
				),
			setRunMode: (mode) => set({ runMode: mode }, false, "setRunMode"),
			updateCharacter: (character) =>
				set(
					(state) => ({
						characters: state.characters.some((c) => c.id === character.id)
							? state.characters.map((c) =>
									c.id === character.id ? character : c,
								)
							: [...state.characters, character],
					}),
					false,
					"updateCharacter",
				),
			updateShot: (shot) =>
				set(
					(state) => ({
						shots: state.shots.some((s) => s.id === shot.id)
							? state.shots.map((s) => (s.id === shot.id ? shot : s))
							: [...state.shots, shot],
					}),
					false,
					"updateShot",
				),
			removeCharacter: (characterId) =>
				set(
					(state) => ({
						characters: state.characters.filter((c) => c.id !== characterId),
					}),
					false,
					"removeCharacter",
				),
			removeShot: (shotId) =>
				set(
					(state) => ({
						shots: state.shots.filter((s) => s.id !== shotId),
					}),
					false,
					"removeShot",
				),
			resetRunState: () => set(initialRunState, false, "resetRunState"),
			reset: () => set(initialState, false, "reset"),
		}),
		{ name: "EditorStore", enabled: import.meta.env.DEV },
	),
);

export { useShallow };
