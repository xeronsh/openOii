import type { BlockingClip, Character, Project, Shot } from "~/types";
import type {
	ComicWorkflowEdge,
	ComicWorkflowGraph,
	ComicWorkflowNode,
	ComicWorkflowSection,
	ComicWorkflowSectionFrame,
	OutputState,
	WorkflowNodeStatus,
} from "./types";
import { styleLabel } from "~/features/projects/styleCategories";

const SECTION_COPY: Record<
	ComicWorkflowSection,
	{ title: string; eyebrow: string }
> = {
	brief: { title: "Brief", eyebrow: "01 / STORY" },
	elements: { title: "Elements", eyebrow: "02 / CAST" },
	shotline: { title: "九宫格分镜", eyebrow: "03 / GRID 3×N" },
	output: { title: "Output", eyebrow: "04 / FINAL" },
};

export interface BuildComicWorkflowInput {
	project: Project;
	characters: Character[];
	shots: Shot[];
	blockingClips?: BlockingClip[] | null;
	isGenerating: boolean;
	/** 当前运行停在审批门上：只有这时草稿卡片才算"待确认"。 */
	awaitingConfirm?: boolean;
}

function nodeStatusFromApproval(
	approvalState: "draft" | "approved" | "superseded",
	isGenerating: boolean,
	awaitingConfirm: boolean,
): WorkflowNodeStatus {
	if (approvalState === "approved") return "approved";
	if (approvalState === "superseded") return "superseded";
	if (awaitingConfirm) return "review";
	return isGenerating ? "generating" : "unconfirmed";
}

export function sortShots(shots: Shot[]): Shot[] {
	return [...shots].sort((a, b) => a.order - b.order || a.id - b.id);
}

export function getTotalDuration(shots: Shot[]): number | null {
	const total = shots.reduce((sum, shot) => sum + (shot.duration ?? 0), 0);
	return total > 0 ? total : null;
}

export function getOutputState({
	project,
	blockingClips,
}: {
	project: Project;
	blockingClips: BlockingClip[];
}): OutputState {
	if (blockingClips.length > 0) return "blocked";
	if (project.video_url && project.status === "superseded") {
		return "needs_recompose";
	}
	if (project.video_url) return "ready";
	return "waiting";
}

function outputStatus(state: OutputState, isGenerating: boolean): WorkflowNodeStatus {
	if (state === "ready") return "ready";
	if (state === "blocked") return "blocked";
	if (state === "needs_recompose") return "superseded";
	return isGenerating ? "generating" : "draft";
}

function briefStatus(project: Project, isGenerating: boolean): WorkflowNodeStatus {
	if (!project.summary && !project.story) return "draft";
	return isGenerating ? "generating" : "ready";
}

function outputSubtitle(state: OutputState): string {
	if (state === "ready") return "成片可用";
	if (state === "needs_recompose") return "需要重新合成";
	if (state === "blocked") return "阻塞";
	return "等待合成";
}

function hasText(value: string | null | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function hasBriefContent(project: Project): boolean {
	return (
		(hasText(project.title) && project.title.trim() !== "未命名项目") ||
		hasText(project.story) ||
		hasText(project.summary)
	);
}

function hasCharacterContent(character: Character): boolean {
	return (
		hasText(character.name) ||
		hasText(character.description) ||
		hasText(character.image_url) ||
		hasText(character.approved_name) ||
		hasText(character.approved_description) ||
		hasText(character.approved_image_url) ||
		hasText(character.visual_notes) ||
		(character.reference_images?.length ?? 0) > 0 ||
		Boolean(character.has_embedding)
	);
}

function hasShotContent(shot: Shot): boolean {
	return (
		hasText(shot.description) ||
		hasText(shot.prompt) ||
		hasText(shot.image_prompt) ||
		hasText(shot.image_url) ||
		hasText(shot.video_url) ||
		typeof shot.duration === "number" ||
		hasText(shot.camera) ||
		hasText(shot.motion_note) ||
		hasText(shot.scene) ||
		hasText(shot.action) ||
		hasText(shot.expression) ||
		hasText(shot.lighting) ||
		hasText(shot.dialogue) ||
		hasText(shot.sfx) ||
		shot.character_ids.length > 0
	);
}

function hasOutputContent({
	project,
	outputState,
	blockingClips,
}: {
	project: Project;
	outputState: OutputState;
	blockingClips: BlockingClip[];
}): boolean {
	return (
		hasText(project.video_url) ||
		outputState === "needs_recompose" ||
		blockingClips.length > 0
	);
}

function sectionStatus(
	section: ComicWorkflowSection,
	nodes: ComicWorkflowNode[],
	isGenerating: boolean,
): WorkflowNodeStatus {
	const sectionNodes = nodes.filter((node) => node.section === section);
	if (sectionNodes.some((node) => node.status === "blocked")) return "blocked";
	if (sectionNodes.some((node) => node.status === "superseded")) {
		return "superseded";
	}
	if (sectionNodes.length === 0) return isGenerating ? "generating" : "draft";
	if (sectionNodes.every((node) => ["approved", "ready"].includes(node.status))) {
		return "ready";
	}
	if (sectionNodes.some((node) => node.status === "generating")) {
		return "generating";
	}
	if (sectionNodes.some((node) => node.status === "review")) return "review";
	return "unconfirmed";
}

function sectionCountLabel(
	section: ComicWorkflowSection,
	nodes: ComicWorkflowNode[],
): string {
	if (section === "brief") {
		return nodes.some((node) => node.kind === "brief") ? "1 brief" : "0 brief";
	}
	if (section === "elements") {
		const count = nodes.filter((node) => node.kind === "character").length;
		return count === 1 ? "1 element" : `${count} elements`;
	}
	if (section === "shotline") {
		const count = nodes.filter((node) => node.kind === "shot").length;
		if (count === 0) return "0 格";
		const rows = Math.ceil(count / 3);
		return `${count} 格 · ${Math.min(3, count)}×${rows}`;
	}
	return nodes.some((node) => node.kind === "output") ? "final cut" : "0 final";
}

export function buildComicWorkflow({
	project,
	characters,
	shots,
	blockingClips,
	isGenerating,
	awaitingConfirm = false,
}: BuildComicWorkflowInput): ComicWorkflowGraph {
	const orderedShots = sortShots(shots);
	const visibleCharacters = characters.filter(hasCharacterContent);
	const visibleShots = orderedShots.filter(hasShotContent);
	const characterNameById = new Map(
		characters.map((character) => [character.id, character.name]),
	);
	const blockers = blockingClips ?? [];
	const outputState = getOutputState({ project, blockingClips: blockers });
	const nodes: ComicWorkflowNode[] = [];

	if (hasBriefContent(project)) {
		nodes.push({
			id: "brief",
			kind: "brief",
			section: "brief",
			title: project.title || "未命名项目",
			subtitle: styleLabel(project.style) || "故事起点",
			status: briefStatus(project, isGenerating),
			entityId: project.id,
			project,
			metrics: {
				characterCount: visibleCharacters.length,
				shotCount: visibleShots.length,
				totalDuration: getTotalDuration(visibleShots),
			},
		});
	}

	nodes.push(
		...visibleCharacters.map((character): ComicWorkflowNode => ({
			id: `character:${character.id}`,
			kind: "character",
			section: "elements",
			title: character.name || `角色 ${character.id}`,
			subtitle: character.has_embedding ? "可复用角色资产" : "角色设定",
			status: nodeStatusFromApproval(character.approval_state, isGenerating, awaitingConfirm),
			entityId: character.id,
			character,
			imageUrl:
				character.approval_state === "approved"
					? character.approved_image_url || character.image_url
					: character.image_url,
		})),
		...visibleShots.map((shot, index): ComicWorkflowNode => ({
			id: `shot:${shot.id}`,
			kind: "shot",
			section: "shotline",
			title: `S${String(shot.order).padStart(2, "0")}`,
			subtitle: shot.scene || shot.camera || "镜头节点",
			status: nodeStatusFromApproval(shot.approval_state, isGenerating, awaitingConfirm),
			entityId: shot.id,
			shot,
			imageUrl: shot.image_url,
			videoUrl: shot.video_url,
			characterNames: shot.character_ids
				.map((id) => characterNameById.get(id))
				.filter((name): name is string => Boolean(name)),
			gridIndex: index,
			gridCell: index + 1,
		})),
	);

	if (hasOutputContent({ project, outputState, blockingClips: blockers })) {
		nodes.push({
			id: "output",
			kind: "output",
			section: "output",
			title: "最终成片",
			subtitle: outputSubtitle(outputState),
			status: outputStatus(outputState, isGenerating),
			entityId: project.id,
			outputState,
			projectId: project.id,
			videoUrl: project.video_url,
			blockingClips: blockers,
			exports: project.exports ?? [],
		});
	}

	const edges = createWorkflowEdges({
		briefVisible: nodes.some((node) => node.kind === "brief"),
		characters: visibleCharacters,
		orderedShots: visibleShots,
		outputVisible: nodes.some((node) => node.kind === "output"),
		blockingClips: blockers,
	});

	const sections: ComicWorkflowSectionFrame[] = (
		["brief", "elements", "shotline", "output"] as const
	).map((section) => ({
		id: `section:${section}`,
		section,
		title: SECTION_COPY[section].title,
		eyebrow: SECTION_COPY[section].eyebrow,
		status: sectionStatus(section, nodes, isGenerating),
		countLabel: sectionCountLabel(section, nodes),
	}));

	return {
		projectId: project.id,
		sections,
		nodes,
		edges,
		orderedShotIds: visibleShots.map((shot) => shot.id),
	};
}

function createWorkflowEdges({
	briefVisible,
	characters,
	orderedShots,
	outputVisible,
	blockingClips,
}: {
	briefVisible: boolean;
	characters: Character[];
	orderedShots: Shot[];
	outputVisible: boolean;
	blockingClips: BlockingClip[];
}): ComicWorkflowEdge[] {
	const edges: ComicWorkflowEdge[] = [];

	for (const character of characters) {
		if (briefVisible) {
			edges.push({
				id: `edge:brief-character-${character.id}`,
				from: "brief",
				to: `character:${character.id}`,
				kind: "dependency",
				label: "角色设定",
			});
		}

		const firstShot = orderedShots.find((shot) =>
			shot.character_ids.includes(character.id),
		);
		if (firstShot) {
			edges.push({
				id: `edge:character-${character.id}-shot-${firstShot.id}`,
				from: `character:${character.id}`,
				to: `shot:${firstShot.id}`,
				kind: "reference",
				label: "出场",
			});
		}
	}

	if (briefVisible && orderedShots.length > 0) {
		edges.push({
			id: `edge:brief-shot-${orderedShots[0].id}`,
			from: "brief",
			to: `shot:${orderedShots[0].id}`,
			kind: "sequence",
			label: "开场",
		});
	}

	for (let index = 1; index < orderedShots.length; index += 1) {
		const previous = orderedShots[index - 1];
		const current = orderedShots[index];
		edges.push({
			id: `edge:shot-${previous.id}-shot-${current.id}`,
			from: `shot:${previous.id}`,
			to: `shot:${current.id}`,
			kind: "sequence",
			label: "下一镜",
		});
	}

	const lastShot = orderedShots[orderedShots.length - 1];
	if (outputVisible && (lastShot || briefVisible)) {
		edges.push({
			id: lastShot ? `edge:shot-${lastShot.id}-output` : "edge:brief-output",
			from: lastShot ? `shot:${lastShot.id}` : "brief",
			to: "output",
			kind: "sequence",
			label: "合成",
		});
	}

	for (const clip of blockingClips) {
		const shot = orderedShots.find((candidate) => candidate.order === clip.order);
		if (!shot || !outputVisible) continue;
		edges.push({
			id: `edge:blocking-shot-${shot.id}-output`,
			from: `shot:${shot.id}`,
			to: "output",
			kind: "blocking",
			label: "阻塞",
		});
	}

	return edges;
}
