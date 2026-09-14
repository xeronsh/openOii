import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type {
	ProjectProviderSettings,
	RecoveryControlRead,
	RecoverySummaryRead,
	RunAwaitingConfirmEventData,
	WorkflowStage,
} from "~/types";

export type RunMode = "manual" | "yolo";

/**
 * Server-owned state lives in TanStack Query (see `~/query`).
 *
 * This store keeps only what the server does not own: canvas selection and the
 * live run UI state. Project fields, characters, shots, blocking clips and the
 * chat feed are read from the query cache, so the workbench no longer maintains
 * a second server-state source of truth.
 */
interface EditorState {
	selectedShotId: number | null;
	selectedCharacterId: number | null;
	highlightedMessageIndex: number | null;
	isGenerating: boolean;
	currentStage: WorkflowStage;
	currentAgent: string | null;
	progress: number;
	recoveryControl: RecoveryControlRead | null;
	recoverySummary: RecoverySummaryRead | null;
	recoveryGate: RunAwaitingConfirmEventData | null;
	awaitingConfirm: boolean;
	awaitingAgent: string | null;
	currentRunId: number | null;
	currentRunProviderSnapshot: ProjectProviderSettings | null;
	runMode: RunMode;

	setSelectedShot: (id: number | null) => void;
	setSelectedCharacter: (id: number | null) => void;
	setHighlightedMessage: (index: number | null) => void;
	setGenerating: (isGenerating: boolean) => void;
	setCurrentStage: (stage: WorkflowStage) => void;
	setCurrentAgent: (agent: string | null) => void;
	setProgress: (progress: number) => void;
	setRecoveryControl: (control: RecoveryControlRead | null) => void;
	setRecoverySummary: (summary: RecoverySummaryRead | null) => void;
	setRecoveryGate: (gate: RunAwaitingConfirmEventData | null) => void;
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
			setRecoveryControl: (control) =>
				set({ recoveryControl: control }, false, "setRecoveryControl"),
			setRecoverySummary: (summary) =>
				set({ recoverySummary: summary }, false, "setRecoverySummary"),
			setRecoveryGate: (gate) =>
				set({ recoveryGate: gate }, false, "setRecoveryGate"),
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
			resetRunState: () => set(initialRunState, false, "resetRunState"),
			reset: () => set(initialState, false, "reset"),
		}),
		{ name: "EditorStore", enabled: import.meta.env.DEV },
	),
);

export { useShallow };
