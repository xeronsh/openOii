import { describe, expect, it } from "vitest";
import { styleLabel } from "./styleCategories";

describe("styleLabel", () => {
	it("shows the Chinese name for a built-in style and keeps custom ids as they are", () => {
		expect(styleLabel("anime")).toBe("日漫");
		expect(styleLabel("my-custom")).toBe("my-custom");
		expect(styleLabel(null)).toBeNull();
	});
});
