import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UniverseCard } from "./UniverseCard";
import type { Universe } from "~/types";

const buildUniverse = (overrides: Partial<Universe> = {}): Universe => ({
	id: 1,
	name: "赛博修仙录",
	description: "跨章节世界观",
	world_setting: null,
	style_rules: null,
	cover_image_url: null,
	is_active: true,
	created_at: "2026-07-01T08:00:00Z",
	updated_at: "2026-07-20T12:30:00Z",
	projects_count: 3,
	shared_characters_count: 2,
	...overrides,
});

const renderCard = (universe: Universe) =>
	render(
		<MemoryRouter>
			<UniverseCard universe={universe} onDelete={vi.fn()} />
		</MemoryRouter>,
	);

describe("UniverseCard", () => {
	it("无封面时显示宇宙编号和更新时间，不渲染旧装饰标签", () => {
		renderCard(buildUniverse());

		expect(screen.getByText(/universe\s*\/\s*1/i)).toBeInTheDocument();
		expect(screen.queryByText(/ip cosmos/i)).toBeNull();
		expect(screen.getByText(/^更新 /)).toBeInTheDocument();
	});

	it("有封面时渲染封面图", () => {
		renderCard(buildUniverse({ cover_image_url: "/static/cover.png" }));

		const img = screen.getByRole("img", { name: "赛博修仙录" });
		expect(img).toHaveAttribute("src", "/static/cover.png");
	});

	it("updated_at 非法时更新时间兜底为「未知」", () => {
		renderCard(buildUniverse({ updated_at: "not-a-date" }));

		expect(screen.getByText("更新 未知")).toBeInTheDocument();
	});

	it("量词使用「章节」", () => {
		renderCard(buildUniverse());

		expect(screen.getByText(/3 章节/)).toBeInTheDocument();
		expect(screen.getByText(/2 角色/)).toBeInTheDocument();
	});
});
