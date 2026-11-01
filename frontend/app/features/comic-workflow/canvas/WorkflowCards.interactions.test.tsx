import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import { getStaticUrl } from "~/services/api";
import type { ComicWorkflowNode } from "../graph/types";
import { WorkflowCardView, WorkflowFrameView } from "./WorkflowCards";

const actions = vi.hoisted(() => ({
	saveShotPatch: vi.fn(),
	addCharacterReference: vi.fn(),
	removeCharacterReference: vi.fn(),
	computeCharacterEmbedding: vi.fn(),
}));
vi.mock("./cardActions", () => actions);

const shotNode = (over: Record<string, unknown> = {}, shot: Record<string, unknown> = {}) =>
	({
		id: "shot:7",
		kind: "shot",
		entityId: 7,
		title: "S03",
		subtitle: "镜头 3",
		status: "ready",
		imageUrl: null,
		videoUrl: null,
		gridCell: 3,
		characterNames: [],
		shot: { id: 7, order: 3, revision: 4, description: "雨夜街口", dialogue: null, camera: null, duration: null, ...shot },
		...over,
	}) as unknown as ComicWorkflowNode;

const characterNode = (character: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
	({
		id: "character:21",
		kind: "character",
		entityId: 21,
		title: "林夏",
		subtitle: "主角",
		status: "approved",
		imageUrl: null,
		character: { id: 21, project_id: 3, description: null, reference_images: [], has_embedding: false, visual_notes: null, ...character },
		...over,
	}) as unknown as ComicWorkflowNode;

const outputNode = (over: Record<string, unknown> = {}) =>
	({
		id: "output",
		kind: "output",
		projectId: 3,
		title: "成片",
		subtitle: "最终输出",
		status: "draft",
		videoUrl: null,
		outputState: "waiting",
		blockingClips: [],
		exports: [],
		...over,
	}) as unknown as ComicWorkflowNode;

let emit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.clearAllMocks();
	emit = vi.spyOn(canvasEvents, "emit");
});
afterEach(() => vi.restoreAllMocks());

describe("shot card inline editing", () => {
	it("saves an edited description on Enter with the shot revision", async () => {
		actions.saveShotPatch.mockResolvedValue(true);
		render(<WorkflowCardView node={shotNode()} />);
		fireEvent.click(screen.getByRole("button", { name: "编辑S03 画面描述" }));
		const box = screen.getByRole("textbox", { name: "S03 画面描述" });
		expect(box).toHaveValue("雨夜街口");
		fireEvent.change(box, { target: { value: "  雨停了  " } });
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
		expect(actions.saveShotPatch).toHaveBeenCalledWith(7, { expected_revision: 4, description: "雨停了" });
	});

	it("keeps the editor open when the save fails, and allows newlines with Shift+Enter", async () => {
		actions.saveShotPatch.mockResolvedValue(false);
		render(<WorkflowCardView node={shotNode()} />);
		fireEvent.click(screen.getByRole("button", { name: "编辑S03 对白" }));
		const box = screen.getByRole("textbox", { name: "S03 对白" });
		fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
		expect(actions.saveShotPatch).not.toHaveBeenCalled();
		fireEvent.change(box, { target: { value: "等等我" } });
		fireEvent.blur(box);
		await waitFor(() => expect(actions.saveShotPatch).toHaveBeenCalledWith(7, { expected_revision: 4, dialogue: "等等我" }));
		await waitFor(() => expect(box).not.toBeDisabled());
		expect(screen.getByRole("textbox", { name: "S03 对白" })).toBeInTheDocument();
	});

	it("clears a field to null, closes unchanged edits without saving, and cancels with Escape", async () => {
		actions.saveShotPatch.mockResolvedValue(true);
		render(<WorkflowCardView node={shotNode({}, { dialogue: "旧对白" })} />);
		fireEvent.click(screen.getByRole("button", { name: "编辑S03 画面描述" }));
		fireEvent.blur(screen.getByRole("textbox"));
		expect(screen.queryByRole("textbox")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "编辑S03 画面描述" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "改了" } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(actions.saveShotPatch).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "编辑S03 对白" }));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		await waitFor(() => expect(actions.saveShotPatch).toHaveBeenCalledWith(7, { expected_revision: 4, dialogue: null }));
	});

	it("does not bubble edit clicks to the card, and locks editing while the shot is generating", () => {
		const onCardClick = vi.fn();
		const { unmount } = render(
			<div onClick={onCardClick}>
				<WorkflowCardView node={shotNode()} />
			</div>,
		);
		fireEvent.click(screen.getByRole("button", { name: "编辑S03 画面描述" }));
		fireEvent.click(screen.getByRole("textbox"));
		expect(onCardClick).not.toHaveBeenCalled();
		unmount();
		render(<WorkflowCardView node={shotNode({ status: "generating" })} />);
		const edit = screen.getByRole("button", { name: "编辑S03 画面描述" });
		expect(edit).toBeDisabled();
		expect(screen.getByText("生成中…")).toBeInTheDocument();
		const dialogue = screen.getByRole("button", { name: "编辑S03 对白" });
		expect(dialogue).not.toHaveAttribute("title");
		expect(screen.getByText("添加对白")).toBeInTheDocument();
	});
});

describe("shot card media and tags", () => {
	it("previews the video when present, else the image, and shows cell, duration and cast", () => {
		const { unmount } = render(
			<WorkflowCardView node={shotNode({ imageUrl: "/static/s3.png", videoUrl: "/static/s3.mp4", characterNames: ["林夏", "周舟"] }, { duration: 6, camera: "低角度" })} />,
		);
		expect(screen.getByAltText("S03")).toHaveAttribute("src", getStaticUrl("/static/s3.png"));
		expect(screen.getByText("6s")).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByTitle("林夏、周舟")).toBeInTheDocument();
		expect(screen.getByTitle("低角度")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "预览视频" }));
		expect(emit).toHaveBeenCalledWith("preview-video", { src: getStaticUrl("/static/s3.mp4"), title: "S03" });
		unmount();

		render(<WorkflowCardView node={shotNode({ imageUrl: "/static/s3.png" }, { order: 1 })} />);
		expect(screen.getByAltText("S03")).toHaveAttribute("loading", "eager");
		expect(screen.getByText("未定时长")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "预览图片" }));
		expect(emit).toHaveBeenCalledWith("preview-image", { src: getStaticUrl("/static/s3.png"), alt: "S03" });
	});

	it("labels visual review results, keeping unchecked apart from passed", () => {
		const cases: Array<[string | null, string | null, string | null]> = [
			["unchecked", null, "未检查"],
			["failed", "人物脸不一致", "未通过"],
			["passed", null, "已检查"],
			[null, null, null],
		];
		for (const [status, note, label] of cases) {
			const { unmount } = render(<WorkflowCardView node={shotNode({}, { review_status: status, review_note: note })} />);
			if (label) expect(screen.getByText(label)).toBeInTheDocument();
			else for (const l of ["未检查", "未通过", "已检查"]) expect(screen.queryByText(l)).toBeNull();
			unmount();
		}
		render(<WorkflowCardView node={shotNode({}, { review_status: "failed", review_note: "人物脸不一致" })} />);
		expect(screen.getByText("未通过")).toHaveAttribute("title", "人物脸不一致");
	});

	it("marks selection and status on the card", () => {
		const { container } = render(<WorkflowCardView node={shotNode({ status: "blocked" })} selected draggable />);
		expect(container.firstElementChild).toHaveAttribute("data-selected", "true");
		const article = screen.getByRole("article", { name: "S03" });
		expect(article).toHaveAttribute("data-status", "blocked");
		expect(article.className).toContain("border-error/50");
		expect(article.className).toContain("cursor-grab");
	});
});

describe("character card references", () => {
	it("uploads a reference image and resets the picker", async () => {
		let finish!: () => void;
		actions.addCharacterReference.mockReturnValue(new Promise<void>((r) => (finish = r)));
		const { container } = render(<WorkflowCardView node={characterNode()} />);
		expect(screen.getByText("等待角色图")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "重算角色特征" })).toBeNull();
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		const click = vi.spyOn(input, "click");
		fireEvent.click(screen.getByRole("button", { name: "上传参考图" }));
		expect(click).toHaveBeenCalled();
		const file = new File(["x"], "ref.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [file] } });
		expect(actions.addCharacterReference).toHaveBeenCalledWith(21, 3, file);
		expect(screen.getByRole("button", { name: "上传参考图" })).toBeDisabled();
		await act(async () => finish());
		expect(screen.getByRole("button", { name: "上传参考图" })).not.toBeDisabled();
		fireEvent.change(input, { target: { files: [] } });
		expect(actions.addCharacterReference).toHaveBeenCalledTimes(1);
	});

	it("removes a reference, recomputes the embedding, and shows at most three thumbnails", async () => {
		actions.removeCharacterReference.mockResolvedValue(undefined);
		actions.computeCharacterEmbedding.mockResolvedValue(undefined);
		render(
			<WorkflowCardView
				node={characterNode(
					{ reference_images: ["/static/a.png", "/static/b.png", "/static/c.png", "/static/d.png"], has_embedding: true, visual_notes: "红围巾", description: "短发女孩" },
					{ imageUrl: "/static/lin.png" },
				)}
			/>,
		);
		expect(screen.getByText("4")).toBeInTheDocument();
		expect(screen.getAllByAltText(/参考图/)).toHaveLength(3);
		expect(screen.getByText("资产一致性")).toBeInTheDocument();
		expect(screen.getByText("视觉笔记")).toBeInTheDocument();
		expect(screen.getByTitle("短发女孩")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "删除参考图 2" }));
		expect(actions.removeCharacterReference).toHaveBeenCalledWith(21, 3, 1);
		await waitFor(() => expect(screen.getByRole("button", { name: "重算角色特征" })).not.toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "重算角色特征" }));
		expect(actions.computeCharacterEmbedding).toHaveBeenCalledWith(21);
		await waitFor(() => expect(screen.getByRole("button", { name: "上传参考图" })).not.toBeDisabled());

		fireEvent.click(screen.getByRole("button", { name: "预览图片" }));
		expect(emit).toHaveBeenCalledWith("preview-image", { src: getStaticUrl("/static/lin.png"), alt: "林夏" });
	});
});

describe("output card", () => {
	it("plays and downloads a ready film through the attachment endpoint, with recent exports", () => {
		const { container } = render(
			<WorkflowCardView
				node={outputNode({
					status: "ready",
					outputState: "ready",
					videoUrl: "/static/final.mp4",
					exports: ["/static/e1.zip", "/static/e2.pdf", "/static/e3.zip", "/static/e4.cbz"],
				})}
			/>,
		);
		expect(container.querySelector("video")).toHaveAttribute("src", getStaticUrl("/static/final.mp4"));
		expect(screen.getByRole("link", { name: /下载成片/ })).toHaveAttribute("href", getStaticUrl("/api/v1/projects/3/final-video"));
		expect(screen.queryByRole("button", { name: /重新合成/ })).toBeNull();
		expect(screen.getByText("成片可用")).toBeInTheDocument();
		expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["下载成片", "e2.pdf", "e3.zip", "e4.cbz"]);
		expect(container.querySelectorAll("svg[data-done]")).toHaveLength(2);
	});

	it("recomposes only the film when just the final cut is stale", () => {
		render(<WorkflowCardView node={outputNode({ outputState: "needs_recompose" })} />);
		expect(screen.getAllByText("需要重新合成").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: /重新合成/ }));
		expect(emit).toHaveBeenCalledWith("request-regenerate", { source: "output-card", mode: "recompose" });
	});

	it("lists blockers and asks for a full regenerate when blocked", () => {
		render(
			<WorkflowCardView
				node={outputNode({ status: "blocked", outputState: "blocked", blockingClips: [{ shot_id: 7, order: 3, reason: "视频缺失" }] })}
			/>,
		);
		expect(screen.getByText("S03 · 视频缺失")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /重新合成/ }));
		expect(emit).toHaveBeenCalledWith("request-regenerate", { source: "output-card" });
	});

	it("waits for composition without actions", () => {
		render(<WorkflowCardView node={outputNode()} />);
		expect(screen.getAllByText("等待合成").length).toBe(2);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("WorkflowFrameView", () => {
	it("guides an empty section and shows counts on a filled one", () => {
		const { rerender } = render(<WorkflowFrameView section="shotline" title="九宫格分镜" eyebrow="03" countLabel="" empty />);
		expect(screen.getByRole("region", { name: "九宫格分镜" })).toHaveClass("cursor-grab");
		expect(screen.getByText("规划完成后，分镜会出现在这里。")).toBeInTheDocument();
		rerender(<WorkflowFrameView section="shotline" title="九宫格分镜" eyebrow="03" countLabel="9 格" draggable={false} />);
		expect(screen.queryByText(/规划完成后/)).toBeNull();
		expect(screen.getByText("9 格")).toBeInTheDocument();
		expect(screen.getByRole("region")).toHaveClass("cursor-default");
		rerender(<WorkflowFrameView section="brief" title="故事" eyebrow="01" countLabel="" empty />);
		expect(screen.getByRole("region", { name: "故事" }).querySelector(".corner-marks")).toBeNull();
	});
});
