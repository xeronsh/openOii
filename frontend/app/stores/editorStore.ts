import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type RunMode = "manual" | "yolo";

/**
 * Client-owned workbench state only.
 *
 * Everything the server owns (project fields, characters, shots, the chat
 * feed and the live run UI) lives in the TanStack Query cache — see
 * `~/query` (ADR 0007). This store keeps selection, the highlighted message
 * and the manual/yolo run-mode preference.
 */
interface EditorState {
	selectedShotId: number | null;
	selectedCharacterId: number | null;
	highlightedMessageIndex: number | null;
	runMode: RunMode;

	setSelectedShot: (id: number | null) => void;
	setSelectedCharacter: (id: number | null) => void;
	setHighlightedMessage: (index: number | null) => void;
	setRunMode: (mode: RunMode) => void;
	reset: () => void;
}

const initialState = {
	selectedShotId: null,
	selectedCharacterId: null,
	highlightedMessageIndex: null,
	runMode: "manual" as RunMode,
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
			setRunMode: (mode) => set({ runMode: mode }, false, "setRunMode"),
			reset: () => set(initialState, false, "reset"),
		}),
		{ name: "EditorStore", enabled: import.meta.env.DEV },
	),
);
