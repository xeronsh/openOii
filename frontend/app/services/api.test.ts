import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStaticUrl, runsApi } from "./api";

vi.mock("~/utils/runtimeBase", () => ({
	getApiBase: () => "http://localhost:18765",
}));

describe("getStaticUrl", () => {
	it("returns null for null/undefined/empty", () => {
		expect(getStaticUrl(null)).toBeNull();
		expect(getStaticUrl(undefined)).toBeNull();
		expect(getStaticUrl("")).toBeNull();
	});

	it("passes through valid http URLs", () => {
		expect(getStaticUrl("http://example.com/img.png")).toBe(
			"http://example.com/img.png",
		);
	});

	it("passes through valid https URLs", () => {
		expect(getStaticUrl("https://example.com/img.png")).toBe(
			"https://example.com/img.png",
		);
	});

	it("blocks javascript: protocol", () => {
		expect(getStaticUrl("javascript:alert(1)")).toBeNull();
	});

	it("blocks data: protocol", () => {
		expect(getStaticUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
	});

	it("blocks vbscript: protocol", () => {
		expect(getStaticUrl("vbscript:msgbox")).toBeNull();
	});

	it("blocks file: protocol", () => {
		expect(getStaticUrl("file:///etc/passwd")).toBeNull();
	});

	it("blocks about: protocol", () => {
		expect(getStaticUrl("about:blank")).toBeNull();
	});

	it("prepends API_BASE to relative paths", () => {
		const result = getStaticUrl("/static/videos/test.mp4");
		expect(result).toContain("/static/videos/test.mp4");
	});

	it("trims whitespace", () => {
		const result = getStaticUrl("  /static/test.png  ");
		expect(result).toContain("/static/test.png");
	});

	it("returns null for invalid URL with http prefix", () => {
		expect(getStaticUrl("http://")).toBeNull();
	});
});

describe("fetchApi", () => {
	const mockFetch = vi.fn();
	let projectsApi: typeof import("./api").projectsApi;

	beforeEach(async () => {
		vi.stubGlobal("fetch", mockFetch);
		const mod = await import("./api");
		projectsApi = mod.projectsApi;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns parsed data on 200", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ items: [{ id: 1 }], total: 1 }), {
				status: 200,
			}),
		);
		const result = await projectsApi.list();
		expect(result).toEqual([{ id: 1 }]);
	});

	it("returns undefined for 204", async () => {
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await projectsApi.delete(1);
		// no error = success
	});

	it("throws on non-ok response with error body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }),
				{ status: 404 },
			),
		);
		await expect(projectsApi.get(999)).rejects.toThrow("Not found");
	});

	it("throws on non-ok with non-JSON body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("Internal error", { status: 500 }),
		);
		await expect(projectsApi.get(1)).rejects.toThrow();
	});

	it("throws NETWORK_ERROR on fetch failure", async () => {
		mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(projectsApi.get(1)).rejects.toThrow("网络连接失败");
	});
});

describe("projectsApi", () => {
	const mockFetch = vi.fn();
	let projectsApi: typeof import("./api").projectsApi;

	beforeEach(async () => {
		vi.stubGlobal("fetch", mockFetch);
		const mod = await import("./api");
		projectsApi = mod.projectsApi;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("list returns items array", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ items: [{ id: 1, name: "p1" }], total: 1 }),
				{ status: 200 },
			),
		);
		const result = await projectsApi.list();
		expect(result).toEqual([{ id: 1, name: "p1" }]);
	});

	it("get fetches single project", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 1, name: "p1" }), { status: 200 }),
		);
		const result = await projectsApi.get(1);
		expect(result).toEqual({ id: 1, name: "p1" });
	});

	it("create sends POST with body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 2 }), { status: 201 }),
		);
		await projectsApi.create({ title: "new" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects"),
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("update sends PUT with body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 1 }), { status: 200 }),
		);
		await projectsApi.update(1, { title: "updated" });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/1"),
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("delete sends DELETE", async () => {
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await projectsApi.delete(1);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/1"),
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("startRun sends POST to the runs collection", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 1, status: "running" }), {
				status: 200,
			}),
		);
		await projectsApi.startRun(1);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/1/runs"),
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("cancel addresses a run by id", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: "cancelled", cancelled: 1 }), {
				status: 200,
			}),
		);
		const result = await runsApi.cancel(42);
		expect(result).toEqual({ status: "cancelled", cancelled: 1 });
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/runs/42/cancel"),
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("resume addresses a run by id", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 42, status: "running" }), { status: 200 }),
		);
		await runsApi.resume(42);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/runs/42/resume"),
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("feedback sends POST with content", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
		);
		await projectsApi.feedback(1, "good");
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/1/runs/feedback"),
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("reorderShots sends PATCH with items", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ shots: [] }), { status: 200 }),
		);
		await projectsApi.reorderShots(1, [
			{ shot_id: 10, order: 1 },
			{ shot_id: 11, order: 2 },
		]);

		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/1/shots/reorder"),
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({
					items: [
						{ shot_id: 10, order: 1 },
						{ shot_id: 11, order: 2 },
					],
				}),
			}),
		);
	});

	it("deleteMany sends batch delete POST", async () => {
		mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await projectsApi.deleteMany([1, 2, 3]);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/batch-delete"),
			expect.objectContaining({ method: "POST" }),
		);
	});
});

describe("admin token localStorage", () => {
	const mockFetch = vi.fn();
	let configApi: typeof import("./api").configApi;
	let projectsApi: typeof import("./api").projectsApi;
	let assetsApi: typeof import("./api").assetsApi;
	const store: Record<string, string> = {};

	beforeEach(async () => {
		vi.resetModules();
		vi.stubGlobal("fetch", mockFetch);
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
			removeItem: (k: string) => {
				delete store[k];
			},
		});
		Object.keys(store).forEach((k) => delete store[k]);
		const mod = await import("./api");
		configApi = mod.configApi;
		projectsApi = mod.projectsApi;
		assetsApi = mod.assetsApi;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stores ADMIN_TOKEN in localStorage after successful config update", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					updated: 2,
					skipped: 0,
					restart_required: false,
					restart_keys: [],
					message: "ok",
				}),
				{ status: 200 },
			),
		);

		await configApi.update({ ADMIN_TOKEN: "my-secret", LLM_API_KEY: "sk-123" });

		expect(store["openoii_admin_token"]).toBe("my-secret");
	});

	it("removes ADMIN_TOKEN from localStorage when set to empty", async () => {
		store["openoii_admin_token"] = "old-token";

		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					updated: 1,
					skipped: 0,
					restart_required: false,
					restart_keys: [],
					message: "ok",
				}),
				{ status: 200 },
			),
		);

		await configApi.update({ ADMIN_TOKEN: "" });

		expect(store["openoii_admin_token"]).toBeUndefined();
	});

	it("includes X-Admin-Token header when token is in localStorage", async () => {
		store["openoii_admin_token"] = "test-token";

		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
		);

		await configApi.update({ LLM_API_KEY: "sk-123" });
		await configApi.get();

		const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
		const headers = lastCall[1].headers as Record<string, string>;
		expect(headers["X-Admin-Token"]).toBe("test-token");
	});

	it("does not include X-Admin-Token header when no token", async () => {
		delete store["openoii_admin_token"];

		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
		);

		await configApi.get();

		const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
		const headers = lastCall[1].headers as Record<string, string>;
		expect(headers["X-Admin-Token"]).toBeUndefined();
	});

	it("includes X-Admin-Token for project reference uploads", async () => {
		store["openoii_admin_token"] = "test-token";
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					url: "/static/references/ref.png",
					reference_images: ["/static/references/ref.png"],
				}),
				{ status: 200 },
			),
		);

		const file = new File(["image"], "ref.png", { type: "image/png" });
		await projectsApi.uploadReference(12, file);

		const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
		const headers = options.headers as Record<string, string>;
		expect(url).toContain("/api/v1/projects/12/upload-reference");
		expect(options.method).toBe("POST");
		expect(options.body).toBeInstanceOf(FormData);
		expect(headers["X-Admin-Token"]).toBe("test-token");
		expect(headers["Content-Type"]).toBeUndefined();
	});

	it("includes X-Admin-Token for asset image uploads", async () => {
		store["openoii_admin_token"] = "test-token";
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ url: "/static/assets/ref.png" }), {
				status: 200,
			}),
		);

		const file = new File(["image"], "asset.png", { type: "image/png" });
		await assetsApi.uploadImage(file);

		const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
		const headers = options.headers as Record<string, string>;
		expect(url).toContain("/api/v1/assets/upload-image");
		expect(options.method).toBe("POST");
		expect(options.body).toBeInstanceOf(FormData);
		expect(headers["X-Admin-Token"]).toBe("test-token");
		expect(headers["Content-Type"]).toBeUndefined();
	});
});

describe("configApi", () => {
	const mockFetch = vi.fn();
	let configApi: typeof import("./api").configApi;

	beforeEach(async () => {
		vi.resetModules();
		vi.stubGlobal("fetch", mockFetch);
		const mod = await import("./api");
		configApi = mod.configApi;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serializes boolean and number config values to strings", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					updated: 2,
					skipped: 0,
					restart_required: false,
					restart_keys: [],
					message: "ok",
				}),
				{ status: 200 },
			),
		);

		await configApi.update({
			DB_ECHO: true,
			REQUEST_TIMEOUT_S: 12.5,
			EMPTY_VALUE: null,
		});

		const [, options] = mockFetch.mock.calls[0] ?? [];
		expect(options).toMatchObject({ method: "PUT" });
		expect(JSON.parse(options.body)).toEqual({
			configs: {
				DB_ECHO: "true",
				REQUEST_TIMEOUT_S: "12.5",
				EMPTY_VALUE: null,
			},
		});
	});
});
