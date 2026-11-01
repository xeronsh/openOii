import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { charactersApi, projectsApi, shotsApi } from "~/services/api";
import { upsertCharacterInCache, upsertShotInCache } from "~/query/applyServerEvent";
import { projectQueryKeys } from "~/query/queryKeys";
import type { Character, CharacterUpdatePayload, MediaOptions, Project, Shot, ShotUpdatePayload } from "~/types";
import { toast } from "~/utils/toast";
import type { ComicWorkflowNode } from "../graph/types";
import { errorMessage, FormShell, NumberInput, SaveButton, SelectInput, TextArea, TextInput, textOrNull } from "./fields";

/** 属性：可编辑字段。 */
export function PropertiesSection({
	projectId,
	node,
	structureLocked,
	atGate = false,
}: {
	projectId: number;
	node: ComicWorkflowNode;
	structureLocked: boolean;
	/** 停在审批门：角色和分镜的属性可以改（这正是审的时候），项目简报不动 */
	atGate?: boolean;
}) {
	const entityLocked = structureLocked && !atGate;
	if (node.kind === "brief") {
		return (
			<div className="space-y-4">
				<ProjectDraftForm
					projectId={projectId}
					project={node.project as Project}
					disabled={structureLocked}
				/>
				<MediaOptionsForm projectId={projectId} project={node.project as Project} />
			</div>
		);
	}
	if (node.kind === "character") {
		return (
			<CharacterDraftForm character={node.character} disabled={entityLocked} />
		);
	}
	if (node.kind === "shot") {
		return <ShotDraftForm shot={node.shot} disabled={entityLocked} />;
	}
	return (
		<div className="space-y-3 text-sm text-ink-muted">
			<p className="m-0">输出节点不直接编辑内容。</p>
			{node.blockingClips.length > 0 ? (
				<div className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-warning-fg">
					{node.blockingClips.map((clip) => (
						<p key={clip.order} className="m-0">
							镜头 {clip.order}: {clip.reason}
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}

function ProjectDraftForm({
	projectId,
	project,
	disabled,
}: {
	projectId: number;
	project: Project;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState(project.title ?? "");
	const [story, setStory] = useState(project.story ?? "");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setTitle(project.title ?? "");
		setStory(project.story ?? "");
	}, [project.id, project.title, project.story]);

	const handleSave = async (auto = false) => {
		if (saving) return;
		setSaving(true);
		try {
			const updated = await projectsApi.update(projectId, {
				expected_revision: project.revision,
				title: title.trim() || project.title,
				story: story.trim() || null,
			});
			queryClient.setQueryData(
				projectQueryKeys.project(projectId),
				(current: typeof project | undefined) =>
					current ? { ...current, title: updated.title, story: updated.story, revision: updated.revision } : current,
			);
			queryClient.invalidateQueries({ queryKey: ["project", projectId] });
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			toast.success({ title: "Brief", message: auto ? "已自动保存" : "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell
			disabled={disabled}
			dirty={title !== (project.title ?? "") || story !== (project.story ?? "")}
			onAutoSave={() => handleSave(true)}
		>
			<TextInput label="标题" value={title} onChange={setTitle} />
			<TextArea label="故事" value={story} onChange={setStory} rows={8} />
			<SaveButton disabled={disabled} loading={saving} onClick={() => handleSave()} />
		</FormShell>
	);
}

type Toggle = "default" | "on" | "off";
const TOGGLE_OPTIONS = [
	["default", "跟随设置"],
	["on", "开"],
	["off", "关"],
] as const;

const SUBTITLE_OPTIONS = [
	["default", "跟随设置"],
	["off", "不要字幕"],
	["soft", "软字幕（可关）"],
	["burn", "烧进画面"],
] as const;
type SubtitleChoice = (typeof SUBTITLE_OPTIONS)[number][0];

const toToggle = (value: boolean | null | undefined): Toggle => (value == null ? "default" : value ? "on" : "off");
const fromToggle = (value: Toggle): boolean | null => (value === "default" ? null : value === "on");

/** 成片选项：配音 / 字幕 / 背景音乐。只影响之后的合成，运行中也可以改（下次运行生效）。 */
function MediaOptionsForm({ projectId, project }: { projectId: number; project: Project }) {
	const queryClient = useQueryClient();
	const [saving, setSaving] = useState(false);
	const current: MediaOptions = project.media_options ?? {};

	const save = async (patch: MediaOptions) => {
		if (saving) return;
		setSaving(true);
		try {
			const next = { ...current, ...patch };
			const updated = await projectsApi.update(projectId, {
				expected_revision: project.revision,
				media_options: next,
			});
			queryClient.setQueryData(
				projectQueryKeys.project(projectId),
				(cached: Project | undefined) =>
					cached ? { ...cached, media_options: updated.media_options, revision: updated.revision } : cached,
			);
			queryClient.invalidateQueries({ queryKey: ["project", projectId] });
			toast.success({ title: "成片选项", message: "已保存，下次合成时生效" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="space-y-2 border-t border-line pt-3" aria-label="成片选项">
			<h4 className="m-0 text-sm font-semibold">成片选项</h4>
			<SelectInput
				label="配音"
				value={toToggle(current.tts)}
				options={TOGGLE_OPTIONS}
				disabled={saving}
				onChange={(value) => save({ tts: fromToggle(value) })}
			/>
			<SelectInput<SubtitleChoice>
				label="字幕"
				value={current.subtitles ?? "default"}
				options={SUBTITLE_OPTIONS}
				disabled={saving}
				onChange={(value) => save({ subtitles: value === "default" ? null : value })}
			/>
			<SelectInput
				label="背景音乐"
				value={toToggle(current.bgm)}
				options={TOGGLE_OPTIONS}
				disabled={saving}
				onChange={(value) => save({ bgm: fromToggle(value) })}
			/>
			<p className="m-0 text-xs text-ink-muted">「跟随设置」用设置里的默认值；配音服务商在设置 → 配音里选。</p>
		</section>
	);
}

/** Edge 免费配音的中文音色；云端服务商的音色名直接填 */
const EDGE_VOICES = [
	"zh-CN-XiaoxiaoNeural",
	"zh-CN-XiaoyiNeural",
	"zh-CN-YunxiNeural",
	"zh-CN-YunjianNeural",
	"zh-CN-YunxiaNeural",
	"zh-CN-YunyangNeural",
];

function CharacterDraftForm({
	character,
	disabled,
}: {
	character: Character;
	disabled: boolean;
}) {
	const queryClient = useQueryClient();
	const original: CharacterUpdatePayload = {
		name: character.name,
		description: character.description ?? "",
		visual_notes: character.visual_notes ?? "",
		voice: character.voice ?? "",
	};
	const [draft, setDraft] = useState<CharacterUpdatePayload>(original);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setDraft({
			name: character.name,
			description: character.description ?? "",
			visual_notes: character.visual_notes ?? "",
			voice: character.voice ?? "",
		});
	}, [character.id, character.name, character.description, character.visual_notes, character.voice]);

	const handleSave = async (auto = false) => {
		if (saving) return;
		setSaving(true);
		try {
			const updated = await charactersApi.update(character.id, {
				expected_revision: character.revision,
				name: textOrNull(draft.name),
				description: textOrNull(draft.description),
				visual_notes: textOrNull(draft.visual_notes),
				voice: textOrNull(draft.voice),
			});
			upsertCharacterInCache(queryClient, character.project_id, updated);
			queryClient.invalidateQueries({ queryKey: ["characters", character.project_id] });
			toast.success({ title: "角色", message: auto ? "已自动保存" : "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell
			disabled={disabled}
			dirty={isDirty(draft, original)}
			onAutoSave={() => handleSave(true)}
		>
			<TextInput
				label="名称"
				value={draft.name ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, name: value }))}
			/>
			<TextArea
				label="描述"
				value={draft.description ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, description: value }))
				}
				rows={5}
			/>
			<TextArea
				label="视觉笔记"
				value={draft.visual_notes ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, visual_notes: value }))
				}
				rows={4}
			/>
			<TextInput
				label="配音音色"
				value={draft.voice ?? ""}
				list="character-voice-options"
				placeholder="留空自动挑选"
				help="留空按角色描述自动挑男女老少；用云端配音时填该服务商的音色名。"
				onChange={(value) => setDraft((state) => ({ ...state, voice: value }))}
			/>
			<datalist id="character-voice-options">
				{EDGE_VOICES.map((v) => (
					<option key={v} value={v} />
				))}
			</datalist>
			<SaveButton disabled={disabled} loading={saving} onClick={() => handleSave()} />
		</FormShell>
	);
}

function ShotDraftForm({ shot, disabled }: { shot: Shot; disabled: boolean }) {
	const queryClient = useQueryClient();
	const original: ShotUpdatePayload = {
		description: shot.description,
		scene: shot.scene ?? "",
		action: shot.action ?? "",
		dialogue: shot.dialogue ?? "",
		camera: shot.camera ?? "",
		duration: shot.duration,
		image_prompt: shot.image_prompt ?? "",
		prompt: shot.prompt ?? "",
	};
	const [draft, setDraft] = useState<ShotUpdatePayload>(original);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setDraft({
			description: shot.description,
			scene: shot.scene ?? "",
			action: shot.action ?? "",
			dialogue: shot.dialogue ?? "",
			camera: shot.camera ?? "",
			duration: shot.duration,
			image_prompt: shot.image_prompt ?? "",
			prompt: shot.prompt ?? "",
		});
	}, [
		shot.id,
		shot.description,
		shot.scene,
		shot.action,
		shot.dialogue,
		shot.camera,
		shot.duration,
		shot.image_prompt,
		shot.prompt,
	]);

	const handleSave = async (auto = false) => {
		if (saving) return;
		setSaving(true);
		try {
			const updated = await shotsApi.update(shot.id, {
				expected_revision: shot.revision,
				description: textOrNull(draft.description),
				scene: textOrNull(draft.scene),
				action: textOrNull(draft.action),
				dialogue: textOrNull(draft.dialogue),
				camera: textOrNull(draft.camera),
				duration: draft.duration ?? null,
				image_prompt: textOrNull(draft.image_prompt),
				prompt: textOrNull(draft.prompt),
			});
			upsertShotInCache(queryClient, shot.project_id, updated);
			queryClient.invalidateQueries({ queryKey: ["shots", shot.project_id] });
			toast.success({ title: "镜头", message: auto ? "已自动保存" : "已保存" });
		} catch (error) {
			toast.error({ title: "保存失败", message: errorMessage(error, "保存失败") });
		} finally {
			setSaving(false);
		}
	};

	return (
		<FormShell
			disabled={disabled}
			dirty={isDirty(draft, original)}
			onAutoSave={() => handleSave(true)}
		>
			<TextArea
				label="描述"
				value={draft.description ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, description: value }))
				}
				rows={4}
			/>
			<TextInput
				label="场景"
				value={draft.scene ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, scene: value }))}
			/>
			<TextInput
				label="动作"
				value={draft.action ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, action: value }))}
			/>
			<TextArea
				label="对白"
				value={draft.dialogue ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, dialogue: value }))
				}
				rows={3}
			/>
			<div className="grid grid-cols-2 gap-2">
				<TextInput
					label="机位"
					value={draft.camera ?? ""}
					onChange={(value) =>
						setDraft((state) => ({ ...state, camera: value }))
					}
				/>
				<NumberInput
					label="时长"
					value={draft.duration ?? null}
					onChange={(value) =>
						setDraft((state) => ({ ...state, duration: value }))
					}
				/>
			</div>
			<TextArea
				label="首帧提示词"
				value={draft.image_prompt ?? ""}
				onChange={(value) =>
					setDraft((state) => ({ ...state, image_prompt: value }))
				}
				rows={4}
			/>
			<TextArea
				label="视频提示词"
				value={draft.prompt ?? ""}
				onChange={(value) => setDraft((state) => ({ ...state, prompt: value }))}
				rows={4}
			/>
			<SaveButton disabled={disabled} loading={saving} onClick={() => handleSave()} />
		</FormShell>
	);
}

function isDirty<T extends object>(draft: T, original: T): boolean {
	return (Object.keys(original) as (keyof T)[]).some((key) => draft[key] !== original[key]);
}
