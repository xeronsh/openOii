import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "~/types/errors";
import type { ComicWorkflowNode } from "../graph/types";
import { PropertiesSection } from "./PropertiesSection";

const api = vi.hoisted(() => ({
	projectsApi: { update: vi.fn() },
	charactersApi: { update: vi.fn() },
	shotsApi: { update: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("~/services/api", () => api);
vi.mock("~/utils/toast", () => ({ toast }));

const project = { id: 3, title: "雨夜", story: "原故事", revision: 4, media_options: { tts: true } };
const character = { id: 21, project_id: 3, name: "林夏", description: "短发", visual_notes: null, voice: null, revision: 2 };
const shot = {
	id: 31,
	project_id: 3,
	order: 1,
	description: "雨中奔跑",
	scene: null,
	action: "跑",
	dialogue: null,
	camera: null,
	duration: 5,
	image_prompt: null,
	prompt: null,
	revision: 7,
};

let client: QueryClient;
function renderNode(node: unknown, opts: { structureLocked?: boolean; atGate?: boolean } = {}) {
	return render(
		<QueryClientProvider client={client}>
			<PropertiesSection projectId={3} node={node as ComicWorkflowNode} structureLocked={opts.structureLocked ?? false} atGate={opts.atGate} />
		</QueryClientProvider>,
	);
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient();
});

describe("PropertiesSection · brief", () => {
	it("saves the trimmed title and story with the expected revision and updates the cache", async () => {
		client.setQueryData(["project", 3], { ...project });
		api.projectsApi.update.mockResolvedValue({ ...project, title: "新标题", story: null, revision: 5 });
		renderNode({ kind: "brief", project });
		fireEvent.change(field("标题"), { target: { value: "  新标题 " } });
		fireEvent.change(field("故事"), { target: { value: "   " } });
		expect(screen.getByRole("status")).toHaveTextContent("有未保存的修改");
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "Brief", message: "已保存" }));
		expect(api.projectsApi.update).toHaveBeenCalledWith(3, { expected_revision: 4, title: "新标题", story: null });
		expect(client.getQueryData(["project", 3])).toMatchObject({ title: "新标题", story: null });
	});

	it("keeps the old title when the field is cleared and reports a conflict", async () => {
		api.projectsApi.update.mockRejectedValue(new ApiError({ code: "REVISION_CONFLICT", message: "项目已被修改", status: 409 }));
		renderNode({ kind: "brief", project });
		fireEvent.change(field("标题"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "保存失败", message: "项目已被修改" }));
		expect(api.projectsApi.update.mock.calls[0]![1].title).toBe("雨夜");
	});

	it("autosaves a dirty form when focus leaves it, and not when clean", async () => {
		api.projectsApi.update.mockResolvedValue({ ...project, story: "改" });
		renderNode({ kind: "brief", project });
		fireEvent.blur(field("标题"));
		expect(api.projectsApi.update).not.toHaveBeenCalled();
		fireEvent.change(field("故事"), { target: { value: "改" } });
		// Moving between fields of the same form is not leaving it.
		fireEvent.blur(field("故事"), { relatedTarget: field("标题") });
		expect(api.projectsApi.update).not.toHaveBeenCalled();
		fireEvent.blur(field("故事"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "Brief", message: "已自动保存" }));
	});

	it("warns before unload while dirty", () => {
		renderNode({ kind: "brief", project });
		const clean = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(clean);
		expect(clean.defaultPrevented).toBe(false);
		fireEvent.change(field("标题"), { target: { value: "x" } });
		const dirty = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(dirty);
		expect(dirty.defaultPrevented).toBe(true);
	});

	it("locks the brief during a run and at a gate", () => {
		renderNode({ kind: "brief", project }, { structureLocked: true, atGate: true });
		expect(screen.getByText("生成运行中，保存操作已锁定。")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
	});

	it("saves media options merged with the current ones, mapping 跟随设置 to null", async () => {
		client.setQueryData(["project", 3], { ...project });
		api.projectsApi.update.mockImplementation(async (_id: number, body: { media_options: unknown }) => ({
			...project,
			media_options: body.media_options,
			revision: 5,
		}));
		renderNode({ kind: "brief", project });
		fireEvent.change(field("字幕"), { target: { value: "burn" } });
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "成片选项", message: "已保存，下次合成时生效" }));
		expect(api.projectsApi.update).toHaveBeenLastCalledWith(3, { expected_revision: 4, media_options: { tts: true, subtitles: "burn" } });
		expect(client.getQueryData(["project", 3])).toMatchObject({ revision: 5, media_options: { subtitles: "burn" } });
		expect(field("配音").value).toBe("on");

		fireEvent.change(field("配音"), { target: { value: "default" } });
		await waitFor(() => expect(api.projectsApi.update).toHaveBeenCalledTimes(2));
		expect(api.projectsApi.update.mock.calls[1]![1].media_options).toEqual({ tts: null });
		fireEvent.change(field("背景音乐"), { target: { value: "off" } });
		await waitFor(() => expect(api.projectsApi.update).toHaveBeenCalledTimes(3));
		expect(api.projectsApi.update.mock.calls[2]![1].media_options).toEqual({ tts: true, bgm: false });
		fireEvent.change(field("字幕"), { target: { value: "default" } });
		await waitFor(() => expect(api.projectsApi.update).toHaveBeenCalledTimes(4));
		expect(api.projectsApi.update.mock.calls[3]![1].media_options).toEqual({ tts: true, subtitles: null });
	});

	it("reports a failed media option save", async () => {
		api.projectsApi.update.mockRejectedValue("weird");
		renderNode({ kind: "brief", project: { ...project, media_options: null } });
		expect(field("配音").value).toBe("default");
		fireEvent.change(field("配音"), { target: { value: "off" } });
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "保存失败", message: "保存失败" }));
	});
});

describe("PropertiesSection · character", () => {
	it("saves a character draft with blank fields as null and upserts the cache", async () => {
		client.setQueryData(["characters", 3], [character]);
		api.charactersApi.update.mockResolvedValue({ ...character, name: "林夏", voice: "zh-CN-XiaoyiNeural", revision: 3 });
		renderNode({ kind: "character", character });
		expect(document.querySelectorAll("#character-voice-options option")).toHaveLength(6);
		fireEvent.change((screen.getByLabelText(/^配音音色/) as HTMLInputElement), { target: { value: " zh-CN-XiaoyiNeural " } });
		fireEvent.change(field("描述"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "角色", message: "已保存" }));
		expect(api.charactersApi.update).toHaveBeenCalledWith(21, {
			expected_revision: 2,
			name: "林夏",
			description: null,
			visual_notes: null,
			voice: "zh-CN-XiaoyiNeural",
		});
		expect((client.getQueryData(["characters", 3]) as Array<{ voice: string }>)[0]!.voice).toBe("zh-CN-XiaoyiNeural");
	});

	it("can be edited at a gate but not during a run, and resets when another character is shown", () => {
		const { rerender } = renderNode({ kind: "character", character }, { structureLocked: true, atGate: true });
		expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
		fireEvent.change(field("视觉笔记"), { target: { value: "红围巾" } });
		rerender(
			<QueryClientProvider client={client}>
				<PropertiesSection projectId={3} node={{ kind: "character", character: { ...character, id: 22, name: "周舟" } } as never} structureLocked />
			</QueryClientProvider>,
		);
		expect(field("名称").value).toBe("周舟");
		expect(field("视觉笔记").value).toBe("");
		expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
	});

	it("reports a failed character save and autosaves on leave", async () => {
		api.charactersApi.update.mockRejectedValueOnce(new Error("名称重复"));
		renderNode({ kind: "character", character });
		fireEvent.change(field("名称"), { target: { value: "林秋" } });
		fireEvent.blur(field("名称"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "保存失败", message: "名称重复" }));
		api.charactersApi.update.mockResolvedValueOnce({ ...character, name: "林秋" });
		fireEvent.blur(field("名称"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "角色", message: "已自动保存" }));
	});
});

describe("PropertiesSection · shot", () => {
	it("saves every shot field, including a cleared duration", async () => {
		client.setQueryData(["shots", 3], [shot]);
		api.shotsApi.update.mockResolvedValue({ ...shot, duration: null, dialogue: "等等我" });
		renderNode({ kind: "shot", shot });
		fireEvent.change(field("对白"), { target: { value: "等等我" } });
		fireEvent.change(field("时长"), { target: { value: "" } });
		fireEvent.change(field("场景"), { target: { value: "街口" } });
		fireEvent.change(field("机位"), { target: { value: "低角度" } });
		fireEvent.change(field("首帧提示词"), { target: { value: "neon rain" } });
		fireEvent.change(field("视频提示词"), { target: { value: "run" } });
		fireEvent.change(field("动作"), { target: { value: "" } });
		fireEvent.change(field("描述"), { target: { value: "雨中奔跑" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "镜头", message: "已保存" }));
		expect(api.shotsApi.update).toHaveBeenCalledWith(31, {
			expected_revision: 7,
			description: "雨中奔跑",
			scene: "街口",
			action: null,
			dialogue: "等等我",
			camera: "低角度",
			duration: null,
			image_prompt: "neon rain",
			prompt: "run",
		});
		expect((client.getQueryData(["shots", 3]) as Array<{ dialogue: string }>)[0]!.dialogue).toBe("等等我");
	});

	it("parses a typed duration and reports save failures", async () => {
		api.shotsApi.update.mockRejectedValue(new ApiError({ code: "X", message: "时长超出", status: 422 }));
		renderNode({ kind: "shot", shot });
		fireEvent.change(field("时长"), { target: { value: "8" } });
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "保存失败", message: "时长超出" }));
		expect(api.shotsApi.update.mock.calls[0]![1].duration).toBe(8);
	});
});

describe("PropertiesSection · output", () => {
	it("explains that output is not editable and lists blocking clips", () => {
		renderNode({ kind: "output", blockingClips: [{ order: 2, reason: "视频生成失败" }] });
		expect(screen.getByText("输出节点不直接编辑内容。")).toBeInTheDocument();
		expect(screen.getByText("镜头 2: 视频生成失败")).toBeInTheDocument();
	});

	it("shows no blocker box when there are none", () => {
		const { container } = renderNode({ kind: "output", blockingClips: [] });
		expect(container.querySelector(".text-warning-fg")).toBeNull();
	});
});
