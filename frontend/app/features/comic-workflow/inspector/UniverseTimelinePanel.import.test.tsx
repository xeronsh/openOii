import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UniverseTimelinePanel } from "./UniverseTimelinePanel";

const api = vi.hoisted(() => ({ universesApi: { timeline: vi.fn(), importSharedCast: vi.fn() } }));
vi.mock("~/services/api", () => api);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("~/utils/toast", () => ({ toast }));

const timeline = (shared = 3) => ({
	universe_id: 5,
	universe_name: "赛博修仙录",
	world_setting: "灵气复苏的 2077 年",
	style_rules: null,
	shared_character_count: shared,
	chapters: [
		{ project_id: 11, chapter_number: 2, chapter_title: null, title: "雨夜", summary: "林夏回到旧城", status: "ready", is_main_story: true, is_current: true, character_count: 2, shot_count: 9, has_video: true, style: null },
	],
});

let client: QueryClient;
function renderPanel() {
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<UniverseTimelinePanel universeId={5} currentProjectId={11} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("UniverseTimelinePanel · shared cast import", () => {
	it("imports the shared cast and refreshes characters and the timeline", async () => {
		api.universesApi.timeline.mockResolvedValue(timeline());
		let finish!: (v: unknown) => void;
		api.universesApi.importSharedCast.mockReturnValue(new Promise((r) => (finish = r)));
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderPanel();
		expect(screen.getByRole("status", { name: "加载中" })).toBeInTheDocument();
		fireEvent.click(await screen.findByRole("button", { name: "沿用共享卡司到本章（3）" }));
		expect(await screen.findByRole("button", { name: "导入中…" })).toBeDisabled();
		finish({ imported_count: 2, skipped_existing: 1 });
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "已导入共享卡司", message: "新增 2 人，跳过已存在 1" }));
		expect(api.universesApi.importSharedCast).toHaveBeenCalledWith(11);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["characters", 11] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["universe-timeline", 5, 11] });
		expect(screen.getByText("灵气复苏的 2077 年")).toBeInTheDocument();
		expect(screen.getByText("林夏回到旧城")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /雨夜/ })).toHaveAttribute("href", "/project/11");
	});

	it("says the cast is already complete, or that the universe has none", async () => {
		api.universesApi.timeline.mockResolvedValue(timeline());
		api.universesApi.importSharedCast
			.mockResolvedValueOnce({ imported_count: 0, skipped_existing: 3 })
			.mockResolvedValueOnce({ imported_count: 0, skipped_existing: 0 })
			.mockResolvedValueOnce({ imported_count: 1, skipped_existing: 0 });
		renderPanel();
		const button = await screen.findByRole("button", { name: /沿用共享卡司/ });
		fireEvent.click(button);
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith({ title: "卡司已齐全", message: "本项目已有 3 个共享角色，无需再导入" }));
		fireEvent.click(await screen.findByRole("button", { name: /沿用共享卡司/ }));
		await waitFor(() => expect(toast.info).toHaveBeenLastCalledWith({ title: "卡司已齐全", message: "宇宙暂无共享角色可导入" }));
		fireEvent.click(await screen.findByRole("button", { name: /沿用共享卡司/ }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith({ title: "已导入共享卡司", message: "新增 1 人" }));
	});

	it("reports an import failure and disables import with no shared characters", async () => {
		api.universesApi.timeline.mockResolvedValueOnce(timeline());
		api.universesApi.importSharedCast.mockRejectedValueOnce(new Error("")).mockRejectedValueOnce(new Error("宇宙已归档"));
		const { unmount } = renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /沿用共享卡司/ }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith({ title: "导入失败", message: "请稍后重试" }));
		fireEvent.click(await screen.findByRole("button", { name: /沿用共享卡司/ }));
		await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith({ title: "导入失败", message: "宇宙已归档" }));
		unmount();
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		api.universesApi.timeline.mockResolvedValueOnce(timeline(0));
		renderPanel();
		expect(await screen.findByRole("button", { name: "沿用共享卡司到本章（0）" })).toBeDisabled();
	});

	it("shows an error state when the timeline cannot load", async () => {
		api.universesApi.timeline.mockRejectedValue(new Error("404"));
		renderPanel();
		expect(await screen.findByText("无法加载时间线")).toBeInTheDocument();
	});
});
