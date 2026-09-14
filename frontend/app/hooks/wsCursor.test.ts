import { beforeEach, describe, expect, it } from "vitest";
import { readWsCursor, writeWsCursor } from "./useWebSocket";

describe("durable websocket cursor", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	it("persists a project-scoped cursor", () => {
		writeWsCursor(42, 123);
		expect(readWsCursor(42)).toBe(123);
		expect(readWsCursor(43)).toBeNull();
	});

	it("ignores malformed persisted values", () => {
		window.sessionStorage.setItem("openoii.ws.cursor.42", "not-a-number");
		expect(readWsCursor(42)).toBeNull();
	});

	it("never persists negative cursors", () => {
		writeWsCursor(42, -1);
		expect(readWsCursor(42)).toBeNull();
	});
});
