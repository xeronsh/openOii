import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { projectsApi } from "~/services/api";
import { ComicCanvasToolbar } from "./ComicCanvasToolbar";

const editorMock = {
	getCurrentToolId: vi.fn(() => "select"),
	getZoomLevel: vi.fn(() => 1),
	getViewportScreenCenter: vi.fn(() => ({ x: 0, y: 0 })),
	setCurrentTool: vi.fn(),
	zoomIn: vi.fn(),
	zoomOut: vi.fn(),
	resetZoom: vi.fn(),
	zoomToFit: vi.fn(),
};

vi.mock("tldraw", () => ({
	track: (component: unknown) => component,
	useEditor: () => editorMock,
}));

vi.mock("~/services/api", () => ({
	projectsApi: {
		fillEmptyShots: vi.fn(),
	},
}));

vi.mock("~/utils/toast", () => ({
	toast: {
		info: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
	},
}));

function renderToolbar(overrides = {}) {
	return render(
		<ComicCanvasToolbar
			projectId={15}
			onResetLayout={vi.fn()}
			{...overrides}
		/>,
	);
}

describe("ComicCanvasToolbar", () => {
	it("uses the dropdown z token and only shows alongside the canvas (lg+)", () => {
		renderToolbar();

		const toolbar = screen.getByRole("toolbar", { name: "画布工具栏" });
		// 不再裸写 z-50 压住 z-20 的抽屉；<lg 跟随画布一起不显示
		expect(toolbar.className).toContain("z-dropdown");
		expect(toolbar.className).not.toContain("z-50");
		expect(toolbar.className).toContain("hidden");
		expect(toolbar.className).toContain("lg:flex");
	});

	it("does not render the removed consistency evaluation button", () => {
		renderToolbar();

		expect(screen.queryByLabelText("一致性评估")).not.toBeInTheDocument();
	});

	it("does not render shot sorting controls when not provided", () => {
		renderToolbar();

		expect(screen.queryByLabelText("排序九宫格")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("完成分镜排序")).not.toBeInTheDocument();
	});

	it("does not keep export in canvas toolbar (moved to stage chrome)", () => {
		renderToolbar();

		expect(screen.queryByLabelText("导出 Webtoon 长图")).not.toBeInTheDocument();
	});

	it("fills empty first-frame cells", async () => {
		const user = userEvent.setup();
		vi.mocked(projectsApi.fillEmptyShots).mockResolvedValue({
			id: 1,
			project_id: 15,
			status: "queued",
		} as never);
		renderToolbar();

		await user.click(screen.getByLabelText("补齐空格 · 首帧"));

		expect(projectsApi.fillEmptyShots).toHaveBeenCalledWith(15, "image");
	});
});
