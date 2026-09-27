import { expect, test } from "@playwright/test";

test("homepage exposes the story bootstrap flow", async ({ page }) => {
	await page.goto("/");

	await expect(page).toHaveTitle(/openOii/);
	await expect(page.getByRole("heading", { name: "把一句想法，变成一部漫剧。" })).toBeVisible();

	const storyInput = page.getByLabel("输入你的故事创意");
	const startButton = page.getByRole("button", { name: "进入画布，与 AI 开始访谈" });

	await expect(storyInput).toBeVisible();
	await expect(startButton).toBeDisabled();

	await storyInput.fill("一个灯塔管理员发现会发光的地图。");
	await expect(startButton).toBeEnabled();
	await expect(page.getByRole("button", { name: /交互模式/ })).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("button", { name: /YOLO 模式/ })).toBeVisible();
});
