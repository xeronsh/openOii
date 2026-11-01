import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assetsApi,
	charactersApi,
	chatApi,
	exportApi,
	projectsApi,
	runsApi,
	shotsApi,
	universesApi,
	versionsApi,
} from "./api";

vi.mock("~/utils/runtimeBase", () => ({
	getApiBase: () => "http://api.test",
}));

type Call = { url: string; method: string; body: unknown };

let fetchMock: ReturnType<typeof vi.fn>;

function lastCall(): Call {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];
	const raw = init?.body;
	return {
		url: url.replace("http://api.test", ""),
		method: init?.method ?? "GET",
		body: typeof raw === "string" ? JSON.parse(raw) : raw === undefined ? undefined : "form",
	};
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
	fetchMock.mockResolvedValueOnce(
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
	);
}

beforeEach(() => {
	fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// Every call the UI makes, with the exact route and payload the backend serves.
const routes: Array<[string, () => Promise<unknown>, Call]> = [
	["restore previous", () => runsApi.restorePrevious(3), { url: "/api/v1/runs/3/restore-previous", method: "POST", body: undefined }],
	["confirm gate", () => runsApi.confirm(3), { url: "/api/v1/runs/3/confirm", method: "POST", body: undefined }],
	["gate feedback", () => runsApi.gateFeedback(3, { content: "darker" }), { url: "/api/v1/runs/3/gate-feedback", method: "POST", body: { content: "darker" } }],
	["characters", () => projectsApi.getCharacters(1), { url: "/api/v1/projects/1/characters", method: "GET", body: undefined }],
	["shots", () => projectsApi.getShots(1), { url: "/api/v1/projects/1/shots", method: "GET", body: undefined }],
	["fill video", () => projectsApi.fillEmptyShots(1, "video"), { url: "/api/v1/projects/1/shots/fill-empty", method: "POST", body: { type: "video" } }],
	["outline", () => projectsApi.getOutline(1), { url: "/api/v1/projects/1/outline", method: "GET", body: undefined }],
	["update outline", () => projectsApi.updateOutline(1, { logline: "x" } as never), { url: "/api/v1/projects/1/outline", method: "PUT", body: { logline: "x" } }],
	["warm plan", () => projectsApi.getRegeneratePlan(1, true), { url: "/api/v1/projects/1/runs/regenerate-plan?warm=true", method: "GET", body: undefined }],
	["plan", () => projectsApi.getRegeneratePlan(1), { url: "/api/v1/projects/1/runs/regenerate-plan", method: "GET", body: undefined }],
	["messages", () => projectsApi.getMessages(1), { url: "/api/v1/projects/1/messages", method: "GET", body: undefined }],
	["recompose", () => projectsApi.recompose(1), { url: "/api/v1/projects/1/runs/recompose", method: "POST", body: undefined }],
	["timing", () => projectsApi.runTiming(9), { url: "/api/v1/runs/9/timing", method: "GET", body: undefined }],
	["current run", () => projectsApi.currentRun(1), { url: "/api/v1/projects/1/runs/current", method: "GET", body: undefined }],
	["chat state", () => chatApi.get(1), { url: "/api/v1/projects/1/chat", method: "GET", body: undefined }],
	["chat send", () => chatApi.send(1, "重画第2镜"), { url: "/api/v1/projects/1/chat", method: "POST", body: { content: "重画第2镜" } }],
	["chat abort", () => chatApi.abort(1), { url: "/api/v1/projects/1/chat/abort", method: "POST", body: undefined }],
	["chat confirm", () => chatApi.confirm(1, "t1", false), { url: "/api/v1/projects/1/chat/confirm", method: "POST", body: { tool_call_id: "t1", approved: false } }],
	["approve shot", () => shotsApi.approve(4), { url: "/api/v1/shots/4/approve", method: "POST", body: undefined }],
	["regenerate shot", () => shotsApi.regenerate(4, "video"), { url: "/api/v1/shots/4/regenerate", method: "POST", body: { type: "video" } }],
	["delete shot", () => shotsApi.delete(4), { url: "/api/v1/shots/4", method: "DELETE", body: undefined }],
	["update character", () => charactersApi.update(2, { name: "Crow" } as never), { url: "/api/v1/characters/2", method: "PUT", body: { name: "Crow" } }],
	["approve character", () => charactersApi.approve(2), { url: "/api/v1/characters/2/approve", method: "POST", body: undefined }],
	["delete character", () => charactersApi.delete(2), { url: "/api/v1/characters/2", method: "DELETE", body: undefined }],
	["bible", () => charactersApi.getBible(2), { url: "/api/v1/characters/2/bible", method: "GET", body: undefined }],
	["add reference", () => charactersApi.addReferenceImage(2, "/static/a.png"), { url: "/api/v1/characters/2/reference-images", method: "POST", body: { image_url: "/static/a.png" } }],
	["delete reference", () => charactersApi.deleteReferenceImage(2, 1), { url: "/api/v1/characters/2/reference-images/1", method: "DELETE", body: undefined }],
	["embedding", () => charactersApi.computeEmbedding(2), { url: "/api/v1/characters/2/compute-embedding", method: "POST", body: undefined }],
	["assets filtered", () => assetsApi.list({ assetType: "character", search: "crow", tag: "hero" }), { url: "/api/v1/assets?asset_type=character&search=crow&tag=hero", method: "GET", body: undefined }],
	["assets", () => assetsApi.list(), { url: "/api/v1/assets", method: "GET", body: undefined }],
	["asset from character", () => assetsApi.createFromCharacter(2), { url: "/api/v1/assets/from-character/2", method: "POST", body: undefined }],
	["asset from shot", () => assetsApi.createFromShot(4), { url: "/api/v1/assets/from-shot/4", method: "POST", body: undefined }],
	["use asset", () => assetsApi.useInProject(5, 1), { url: "/api/v1/assets/5/use-in-project", method: "POST", body: { project_id: 1 } }],
	["delete asset", () => assetsApi.delete(5), { url: "/api/v1/assets/5", method: "DELETE", body: undefined }],
	["versions", () => versionsApi.list(1, "shot", 4), { url: "/api/v1/projects/1/versions?entity_type=shot&entity_id=4", method: "GET", body: undefined }],
	["version", () => versionsApi.get(8), { url: "/api/v1/versions/8", method: "GET", body: undefined }],
	["rollback", () => versionsApi.rollback("character", 2, 1), { url: "/api/v1/versions/rollback", method: "POST", body: { entity_type: "character", entity_id: 2, target_version: 1 } }],
	["compare", () => versionsApi.compare(1, "shot", 4, 1, 2), { url: "/api/v1/projects/1/versions/compare?entity_type=shot&entity_id=4&v1=1&v2=2", method: "GET", body: undefined }],
	["webtoon", () => exportApi.triggerWebtoon(1), { url: "/api/v1/projects/1/export/webtoon", method: "POST", body: undefined }],
	["export status", () => exportApi.getStatus(1, "abc"), { url: "/api/v1/projects/1/export/abc/status", method: "GET", body: undefined }],
	["universes", () => universesApi.list(), { url: "/api/v1/universes", method: "GET", body: undefined }],
	["universe", () => universesApi.get(6), { url: "/api/v1/universes/6", method: "GET", body: undefined }],
	["create universe", () => universesApi.create({ name: "W" }), { url: "/api/v1/universes", method: "POST", body: { name: "W" } }],
	["update universe", () => universesApi.update(6, { name: "V" }), { url: "/api/v1/universes/6", method: "PUT", body: { name: "V" } }],
	["delete universe", () => universesApi.delete(6), { url: "/api/v1/universes/6", method: "DELETE", body: undefined }],
	["unlink chapter", () => universesApi.removeProject(6, 1), { url: "/api/v1/universes/6/projects/1", method: "DELETE", body: undefined }],
	["shared cast", () => universesApi.listSharedCharacters(6), { url: "/api/v1/universes/6/shared-characters", method: "GET", body: undefined }],
	["promote", () => universesApi.promoteCharacter(6, 2), { url: "/api/v1/universes/6/shared-characters", method: "POST", body: { character_id: 2 } }],
	["import one", () => universesApi.importCharacter(1, 7), { url: "/api/v1/universes/projects/1/import-character/7", method: "POST", body: undefined }],
	["import cast", () => universesApi.importSharedCast(1), { url: "/api/v1/universes/projects/1/import-shared-cast", method: "POST", body: undefined }],
	["sync back", () => universesApi.syncCharacter(2), { url: "/api/v1/universes/characters/2/sync-to-universe", method: "POST", body: undefined }],
	["manual shared", () => universesApi.createSharedCharacter(6, { name: "Moth" }), { url: "/api/v1/universes/6/shared-characters/manual", method: "POST", body: { name: "Moth" } }],
	["timeline here", () => universesApi.timeline(6, 1), { url: "/api/v1/universes/6/timeline?current_project_id=1", method: "GET", body: undefined }],
	["timeline", () => universesApi.timeline(6), { url: "/api/v1/universes/6/timeline", method: "GET", body: undefined }],
	["upload reference", () => projectsApi.uploadReference(1, new File(["x"], "r.png")), { url: "/api/v1/projects/1/upload-reference", method: "POST", body: "form" }],
];

describe("API routes", () => {
	it.each(routes)("%s", async (_name, call, expected) => {
		await call();
		expect(lastCall()).toEqual(expected);
	});

	it("listPage keeps the totals on the page", async () => {
		respond(200, { items: [{ id: 1 }], total: 40, ready_total: 12 });
		const page = await projectsApi.listPage(24);
		expect(lastCall().url).toBe("/api/v1/projects?limit=24");
		expect([...page]).toEqual([{ id: 1 }]);
		expect([page.total, page.readyTotal]).toEqual([40, 12]);
	});
});

describe("API errors", () => {
	it("maps a 409 recovery control to RUN_ALREADY_ACTIVE or RUN_RECOVERABLE", async () => {
		respond(409, { state: "active", recovery_summary: {} });
		await expect(projectsApi.startRun(1)).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE", status: 409 });
		respond(409, { state: "recoverable", recovery_summary: {} });
		await expect(projectsApi.startRun(1)).rejects.toMatchObject({ code: "RUN_RECOVERABLE" });
	});

	it("keeps the server code, message, retryable and details", async () => {
		respond(422, { error: { code: "MISSING_FIELDS", message: "缺少字段", retryable: false, details: { fields: ["prompt"] } } });
		await expect(shotsApi.approve(4)).rejects.toMatchObject({
			code: "MISSING_FIELDS",
			message: "缺少字段",
			retryable: false,
			details: { fields: ["prompt"] },
			request: { method: "POST", url: "/api/v1/shots/4/approve" },
		});
	});

	it("falls back to the FastAPI detail, then the status text", async () => {
		respond(404, { detail: "Universe not found" });
		await expect(universesApi.get(6)).rejects.toMatchObject({ code: "API_ERROR", message: "Universe not found" });
		fetchMock.mockResolvedValueOnce(new Response("[]", { status: 500, statusText: "Server Error" }));
		await expect(universesApi.get(6)).rejects.toMatchObject({ message: "Server Error" });
	});

	it("treats an empty or non-JSON success as no content", async () => {
		respond(200, "", { "content-length": "0" });
		await expect(universesApi.delete(6)).resolves.toBeUndefined();
		respond(200, "ok");
		await expect(universesApi.delete(6)).resolves.toBeUndefined();
	});

	it("reports a failed upload as a network error", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("offline"));
		await expect(assetsApi.uploadImage(new File(["x"], "a.png"))).rejects.toMatchObject({
			code: "NETWORK_ERROR",
			request: { method: "POST", url: "/api/v1/assets/upload-image" },
		});
	});

	it("reports a bad upload response from the server", async () => {
		respond(413, "too big");
		await expect(projectsApi.uploadReference(1, new File(["x"], "r.png"))).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
			status: 413,
		});
	});
});
