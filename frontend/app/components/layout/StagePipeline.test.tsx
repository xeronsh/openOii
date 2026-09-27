import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { getWorkbenchStatusMeta } from "~/features/comic-workflow/state/deriveWorkbenchStatus";
import { StagePipeline } from "./StagePipeline";

function renderStagePipeline(props: Partial<Parameters<typeof StagePipeline>[0]> = {}) {
	return render(
		<StagePipeline
			currentStage="plan"
			isGenerating={false}
			workbenchStatus={getWorkbenchStatusMeta("idle")}
			awaitingConfirm={false}
			hasRecovery={false}
			onResume={vi.fn()}
			onCancel={vi.fn()}
			{...props}
		/>,
	);
}

describe("StagePipeline", () => {
	it("does not duplicate the sidebar chat entry while idle", () => {
		renderStagePipeline({ onToggleChat: vi.fn() });

		expect(
			screen.queryByRole("button", { name: "打开对话面板" }),
		).not.toBeInTheDocument();
	});

	it("opens the chat drawer from the confirmation action", async () => {
		const user = userEvent.setup();
		const onToggleChat = vi.fn();

		renderStagePipeline({ awaitingConfirm: true, onToggleChat });

		await user.click(screen.getByRole("button", { name: "打开对话面板" }));

		expect(onToggleChat).toHaveBeenCalledTimes(1);
	});

	it("omits the chat action when no handler is provided", () => {
		renderStagePipeline();

		expect(
			screen.queryByRole("button", { name: "打开对话面板" }),
		).not.toBeInTheDocument();
	});

	it("announces the current workbench status", () => {
		const { container } = renderStagePipeline({
			workbenchStatus: getWorkbenchStatusMeta("awaitingConfirm"),
		});

		expect(screen.getByText("工作台状态：待确认")).toBeInTheDocument();
		expect(
			screen.getByTitle("正在等待创作者确认后继续"),
		).toBeInTheDocument();
		expect(container.querySelector("[data-shell='stage-pipeline']")).toHaveClass(
			"chrome-toolbar",
		);
	});

	it("exposes unified workbench tools through the overflow menu", async () => {
		const user = userEvent.setup();
		const onOpenVersions = vi.fn();
		const onOpenConsistency = vi.fn();
		const onExport = vi.fn();

		renderStagePipeline({
			onOpenVersions,
			onOpenConsistency,
			onExport,
		});

		// 溢出菜单触发器在所有视口可见（不再是 hidden sm:flex 的按钮组）
		const trigger = screen.getByRole("button", { name: "工作台工具" });
		expect(trigger.className).not.toContain("hidden");

		await user.click(trigger);
		await user.click(screen.getByRole("menuitem", { name: "打开版本对比" }));
		await user.click(trigger);
		await user.click(screen.getByRole("menuitem", { name: "打开一致性报告" }));
		await user.click(trigger);
		await user.click(screen.getByRole("menuitem", { name: "导出 Webtoon 长图" }));

		expect(onOpenVersions).toHaveBeenCalledTimes(1);
		expect(onOpenConsistency).toHaveBeenCalledTimes(1);
		expect(onExport).toHaveBeenCalledTimes(1);
	});

	it("omits the overflow menu when no tool handlers are provided", () => {
		renderStagePipeline();

		expect(
			screen.queryByRole("button", { name: "工作台工具" }),
		).not.toBeInTheDocument();
	});

	it("disables the export menu item while generating", async () => {
		const user = userEvent.setup();
		const onExport = vi.fn();

		renderStagePipeline({ onExport, isGenerating: true });

		await user.click(screen.getByRole("button", { name: "工作台工具" }));
		const exportItem = screen.getByRole("menuitem", {
			name: "导出 Webtoon 长图",
		});

		expect(exportItem).toBeDisabled();
		await user.click(exportItem);
		expect(onExport).not.toHaveBeenCalled();
	});

	it("keeps the status label text visible on all viewports", () => {
		renderStagePipeline({
			workbenchStatus: getWorkbenchStatusMeta("ready"),
		});

		const label = screen.getByText("成片可用");
		// <sm 不再只剩色点：文案不能带 hidden
		expect(label.className).not.toContain("hidden");
	});
});
