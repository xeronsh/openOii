import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasEvents } from "~/components/canvas/canvasEvents";
import type { ComicWorkflowNode } from "../graph/types";
import { GenerationSection } from "./GenerationSection";
import { HistorySection } from "./HistorySection";

const api = vi.hoisted(() => ({
	charactersApi: { approve: vi.fn(), regenerate: vi.fn(), delete: vi.fn() },
	shotsApi: { approve: vi.fn(), regenerate: vi.fn(), delete: vi.fn() },
	versionsApi: { list: vi.fn(), rollback: vi.fn() },
	assetsApi: { createFromCharacter: vi.fn(), createFromShot: vi.fn() },
	universesApi: { promoteCharacter: vi.fn(), syncCharacter: vi.fn() },
	getStaticUrl: (url: string | null | undefined) => (url ? `http://static${url}` : null),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("~/services/api", () => api);
vi.mock("~/utils/toast", () => ({ toast }));

const character = { id: 21, project_id: 3, name: "林夏", approval_version: 2, approved_at: "2026-10-31T16:05:00Z" };
const shot = { id: 31, project_id: 3, order: 2, approval_version: 0, approved_at: null };
const characterNode = { kind: "character", entityId: 21, status: "draft", title: "林夏", character };
const shotNode = { kind: "shot", entityId: 31, status: "draft", title: "S02", shot };

let client: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function renderSection(node: unknown, props: Partial<Parameters<typeof GenerationSection>[0]> = {}) {
	return render(
		<QueryClientProvider client={client}>
			<GenerationSection projectId={3} node={node as ComicWorkflowNode} structureLocked={false} {...props} />
		</QueryClientProvider>,
	);
}
const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	invalidate = vi.spyOn(client, "invalidateQueries");
});
afterEach(() => vi.restoreAllMocks());

describe("GenerationSection · shot", () => {
	it("explains single-cell scope and redoes only this cell's first frame or video", async () => {
		api.shotsApi.regenerate.mockResolvedValue(undefined);
		renderSection(shotNode);
		expect(screen.getByText("S02")).toBeInTheDocument();
		fireEvent.click(button("重做首帧 · S02"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "重做本格 · 首帧（S02）", message: "任务已启动，仅影响选中实体" }));
		expect(api.shotsApi.regenerate).toHaveBeenCalledWith(31, "image");
		fireEvent.click(button("重做视频 · S02"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "重做本格 · 视频（S02）" })));
		expect(api.shotsApi.regenerate).toHaveBeenLastCalledWith(31, "video");
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["shots", 3] });
	});

	it("approves a shot into the cache and disables approve once approved", async () => {
		client.setQueryData(["shots", 3], [{ ...shot, approval_state: "draft" }]);
		api.shotsApi.approve.mockResolvedValue({ ...shot, approval_version: 1, approval_state: "approved" });
		renderSection(shotNode);
		fireEvent.click(button("批准此节点"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "审阅", message: "已批准" }));
		expect((client.getQueryData(["shots", 3]) as Array<{ approval_state: string }>)[0]!.approval_state).toBe("approved");
	});

	it("is fully locked during a run, with the gate-specific explanation at a gate", () => {
		const { unmount } = renderSection({ ...shotNode, status: "approved" }, { structureLocked: true });
		expect(screen.getByRole("note")).toHaveTextContent("生成运行中，结构写入操作已锁定。");
		expect(button("已批准")).toBeDisabled();
		for (const name of ["重做首帧 · S02", "重做视频 · S02", "换回上一版", "保存到资产库", "删除"]) expect(button(name)).toBeDisabled();
		expect(button("删除").parentElement).toHaveAttribute("title", "生成运行中，暂不可用");
		unmount();
		renderSection(shotNode, { structureLocked: true, atGate: true });
		expect(screen.getByRole("note")).toHaveTextContent("正在等你确认这一步");
		expect(button("删除").parentElement).toHaveAttribute("title", "审批门待确认：请用修改意见，确认后可单独重做");
	});

	it("swaps to the previous version, or says there is none yet", async () => {
		api.versionsApi.list.mockResolvedValueOnce({ versions: [{ version: 1 }] });
		renderSection(shotNode);
		fireEvent.click(button("换回上一版"));
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith({ title: "版本", message: "还没有上一版，重做一次之后才能切换" }));
		expect(api.versionsApi.rollback).not.toHaveBeenCalled();

		api.versionsApi.list.mockResolvedValueOnce({ versions: [{ version: 2 }, { version: 3 }, { version: 1 }] });
		api.versionsApi.rollback.mockResolvedValue(undefined);
		fireEvent.click(button("换回上一版"));
		await waitFor(() => expect(api.versionsApi.rollback).toHaveBeenCalledWith("shot", 31, 2));
		expect(api.versionsApi.list).toHaveBeenLastCalledWith(3, "shot", 31);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "已换回上一版", message: "内容来自 v2，再点一次可切回" }));
	});

	it("deletes a shot only after confirmation and drops it from the cache", async () => {
		client.setQueryData(["shots", 3], [shot, { ...shot, id: 32 }]);
		const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
		api.shotsApi.delete.mockResolvedValue(undefined);
		renderSection(shotNode);
		fireEvent.click(button("删除"));
		await waitFor(() => expect(confirm).toHaveBeenCalledWith("确定删除这个镜头吗？镜头顺序和最终合成需要重新确认。"));
		expect(api.shotsApi.delete).not.toHaveBeenCalled();
		await waitFor(() => expect(button("删除")).not.toBeDisabled());
		fireEvent.click(button("删除"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "删除", message: "已删除" }));
		expect(api.shotsApi.delete).toHaveBeenCalledWith(31);
		expect((client.getQueryData(["shots", 3]) as Array<{ id: number }>).map((s) => s.id)).toEqual([32]);
	});

	it("saves a shot to the asset library and surfaces failures", async () => {
		api.assetsApi.createFromShot.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("资产库已满"));
		renderSection(shotNode);
		fireEvent.click(button("保存到资产库"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "资产库", message: "已保存" }));
		fireEvent.click(button("保存到资产库"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "操作失败", message: "资产库已满" }));
	});

	it("hides the single-cell explanation in the compact context menu", () => {
		renderSection(shotNode, { compact: true });
		expect(screen.queryByText(/重做只刷新这一格/)).toBeNull();
	});
});

describe("GenerationSection · character", () => {
	it("regenerates, approves, saves and deletes the character", async () => {
		client.setQueryData(["characters", 3], [character]);
		api.charactersApi.regenerate.mockResolvedValue(undefined);
		api.charactersApi.approve.mockResolvedValue({ ...character, approval_version: 3 });
		api.assetsApi.createFromCharacter.mockResolvedValue(undefined);
		api.charactersApi.delete.mockResolvedValue(undefined);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		renderSection(characterNode);
		expect(screen.queryByRole("button", { name: "提升到宇宙共享角色" })).toBeNull();

		fireEvent.click(button("重新生成当前角色"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "重新生成当前角色" })));
		expect(api.charactersApi.regenerate).toHaveBeenCalledWith(21);
		fireEvent.click(button("批准此节点"));
		await waitFor(() => expect(api.charactersApi.approve).toHaveBeenCalledWith(21));
		await waitFor(() => expect((client.getQueryData(["characters", 3]) as Array<{ approval_version: number }>)[0]!.approval_version).toBe(3));
		fireEvent.click(button("保存到资产库"));
		await waitFor(() => expect(api.assetsApi.createFromCharacter).toHaveBeenCalledWith(21));
		await waitFor(() => expect(button("删除")).not.toBeDisabled());
		fireEvent.click(button("删除"));
		await waitFor(() => expect(api.charactersApi.delete).toHaveBeenCalledWith(21));
		expect(window.confirm).toHaveBeenCalledWith("确定删除这个角色吗？引用它的镜头会失去角色关联。");
		await waitFor(() => expect(client.getQueryData(["characters", 3])).toEqual([]));
	});

	it("promotes to and syncs with the universe when the project belongs to one", async () => {
		api.universesApi.promoteCharacter.mockResolvedValue(undefined);
		api.universesApi.syncCharacter.mockResolvedValue(undefined);
		api.versionsApi.list.mockResolvedValue({ versions: [{ version: 4 }, { version: 5 }] });
		api.versionsApi.rollback.mockResolvedValue(undefined);
		renderSection(characterNode, { universeId: 9 });
		fireEvent.click(button("提升到宇宙共享角色"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "已提升到宇宙" })));
		expect(api.universesApi.promoteCharacter).toHaveBeenCalledWith(9, 21);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["universe", 9] });
		fireEvent.click(button("同步变更回宇宙"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "已同步回宇宙" })));
		expect(api.universesApi.syncCharacter).toHaveBeenCalledWith(21);
		fireEvent.click(button("换回上一版"));
		await waitFor(() => expect(api.versionsApi.rollback).toHaveBeenCalledWith("character", 21, 4));
	});
});

describe("GenerationSection · brief, output and multi-select", () => {
	it("points brief actions to the chat panel", () => {
		renderSection({ kind: "brief", status: "draft" });
		expect(screen.getByText(/Brief 只在内容页编辑/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("previews the final film only when one exists", () => {
		const emit = vi.spyOn(canvasEvents, "emit");
		const { unmount } = renderSection({ kind: "output", status: "draft", videoUrl: null });
		expect(button("预览成片")).toBeDisabled();
		unmount();
		renderSection({ kind: "output", status: "approved", videoUrl: "/static/final.mp4" });
		fireEvent.click(button("预览成片"));
		expect(emit).toHaveBeenCalledWith("preview-video", { src: "http://static/static/final.mp4", title: "最终成片" });
	});

	it("batches redo across the selected cells", async () => {
		api.shotsApi.regenerate.mockResolvedValue(undefined);
		renderSection(shotNode, { multiShotIds: [31, 32, 33] });
		expect(screen.getByText("已选 3 格")).toBeInTheDocument();
		fireEvent.click(button("重做首帧 · 3 格"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "批量重做首帧", message: "已为 3 格启动任务" }));
		expect(api.shotsApi.regenerate.mock.calls).toEqual([[31, "image"], [32, "image"], [33, "image"]]);
		fireEvent.click(button("重做视频 · 3 格"));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: "批量重做视频" })));
	});

	it("reports a failed batch and locks batches during a run", async () => {
		api.shotsApi.regenerate.mockRejectedValue("x");
		const { unmount } = renderSection(shotNode, { multiShotIds: [31, 32] });
		fireEvent.click(button("重做视频 · 2 格"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "批量重做失败", message: "请重试" }));
		unmount();
		renderSection(shotNode, { multiShotIds: [31, 32], structureLocked: true });
		expect(screen.getByRole("note")).toHaveTextContent("生成运行中，批量操作已锁定。");
		expect(button("重做首帧 · 2 格")).toBeDisabled();
	});
});

describe("HistorySection", () => {
	function renderHistory(node: unknown) {
		return render(
			<QueryClientProvider client={client}>
				<HistorySection projectId={3} node={node as ComicWorkflowNode} />
			</QueryClientProvider>,
		);
	}

	it("shows approval count, status and a local approval time from a UTC timestamp", async () => {
		api.versionsApi.list.mockResolvedValue({ versions: [{ version: 2, snapshot: { name: "林夏" } }, { version: 1, snapshot: { name: "旧名" } }] });
		const emit = vi.spyOn(canvasEvents, "emit");
		renderHistory(characterNode);
		expect(screen.getByText("2 次")).toBeInTheDocument();
		expect(screen.getByText(new Date("2026-10-31T16:05:00Z").toLocaleString("zh-CN", { hour12: false }))).toBeInTheDocument();
		await waitFor(() => expect(api.versionsApi.list).toHaveBeenCalledWith(3, "character", 21));
		await waitFor(() => expect(button("对比生成版本")).not.toBeDisabled());
		fireEvent.click(button("对比生成版本"));
		expect(emit).toHaveBeenCalledWith("version-history", { entityType: "character", entityId: 21 });
	});

	it("explains why there is nothing to compare", async () => {
		api.versionsApi.list.mockResolvedValue({ versions: [] });
		renderHistory(shotNode);
		expect(screen.getByText("未批准")).toBeInTheDocument();
		expect(await screen.findByText("还没有历史版本，重新生成或修改后才能对比。")).toBeInTheDocument();
		expect(button("对比生成版本")).toBeDisabled();
	});

	it("opens the project-wide comparison for other nodes without querying versions", () => {
		const emit = vi.spyOn(canvasEvents, "emit");
		renderHistory({ kind: "output", status: "draft" });
		fireEvent.click(button("打开版本对比"));
		expect(emit).toHaveBeenCalledWith("version-history", {});
		expect(api.versionsApi.list).not.toHaveBeenCalled();
	});
});
