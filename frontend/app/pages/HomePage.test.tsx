import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HomePage } from "./HomePage";

const mockMutate = vi.fn();
let mockIsPending = false;

vi.mock("~/services/api", () => ({
	projectsApi: { create: vi.fn() },
	universesApi: {
		list: vi.fn(() =>
			Promise.resolve([
				{
					id: 12,
					name: "测试宇宙",
					description: null,
					world_setting: null,
					style_rules: null,
					cover_image_url: null,
					is_active: true,
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
					projects_count: 2,
					shared_characters_count: 1,
				},
			])),
	},
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual = await importOriginal<any>();
	return {
		...actual,
		useMutation: vi.fn(() => ({ mutate: mockMutate, isPending: mockIsPending })),
		useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
	};
});

vi.mock("~/stores/themeStore", () => ({
	useThemeStore: vi.fn(() => ({ theme: "light", toggleTheme: vi.fn() })),
}));

vi.mock("~/stores/settingsStore", () => ({
	useSettingsStore: vi.fn(() => ({ openModal: vi.fn() })),
}));

function renderHomePage(initialEntry = "/") {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<HomePage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("HomePage", () => {
	beforeEach(() => {
		mockMutate.mockClear();
		mockIsPending = false;
	});

	it("starts with one story field and no workflow preset section", () => {
		const { container } = renderHomePage();
		expect(screen.getByRole("heading", { name: "把一句想法，变成一部漫剧。" })).toBeInTheDocument();
		expect(screen.getByLabelText("输入你的故事创意")).toBeInTheDocument();
		expect(container.querySelector('[data-shell="desk-section"]')).not.toBeNull();
		expect(screen.queryByRole("heading", { name: "工作流" })).toBeNull();
		expect(screen.queryByRole("heading", { name: "创作设置" })).toBeNull();
	});

	it("offers interactive and YOLO creation modes", async () => {
		const user = userEvent.setup();
		renderHomePage();
		const interactive = screen.getByRole("button", { name: /交互模式/ });
		const yolo = screen.getByRole("button", { name: /YOLO 模式/ });
		expect(interactive).toHaveAttribute("aria-pressed", "true");
		expect(yolo).toHaveAttribute("aria-pressed", "false");
		await user.click(yolo);
		expect(yolo).toHaveAttribute("aria-pressed", "true");
	});

	it("creates an interactive project from the story", () => {
		renderHomePage();
		fireEvent.change(screen.getByLabelText("输入你的故事创意"), {
			target: { value: "My story" },
		});
		fireEvent.click(screen.getByRole("button", { name: "进入画布，与 AI 开始访谈" }));
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({ story: "My story", creation_mode: "review" }),
		);
	});

	it("creates a YOLO project when that mode is selected", async () => {
		const user = userEvent.setup();
		renderHomePage();
		fireEvent.change(screen.getByLabelText("输入你的故事创意"), {
			target: { value: "A quick story" },
		});
		await user.click(screen.getByRole("button", { name: /YOLO 模式/ }));
		await user.click(screen.getByRole("button", { name: "进入画布，与 AI 开始访谈" }));
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({ story: "A quick story", creation_mode: "quick" }),
		);
	});

	it("uses a requested universe chapter from the route", async () => {
		renderHomePage("/?universeId=12&chapterNumber=5");
		await screen.findByText(/将加入「测试宇宙」宇宙 · 第 5 章/);
		fireEvent.change(screen.getByLabelText("输入你的故事创意"), {
			target: { value: "月台信号灯异常" },
		});
		fireEvent.click(screen.getByRole("button", { name: "进入画布，与 AI 开始访谈" }));
		await waitFor(() =>
			expect(mockMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					universe_id: 12,
					chapter_number: 5,
					chapter_title: "月台信号灯异常",
				}),
			),
		);
	});

	it("keeps the start button disabled until story text is entered", () => {
		renderHomePage();
		expect(screen.getByRole("button", { name: "进入画布，与 AI 开始访谈" })).toBeDisabled();
	});

	it("shows remaining characters near the limit", () => {
		renderHomePage();
		fireEvent.change(screen.getByLabelText("输入你的故事创意"), {
			target: { value: "a".repeat(4600) },
		});
		expect(screen.getByText(/还可输入 400 字/)).toBeInTheDocument();
	});
});
