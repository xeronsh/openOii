import { beforeEach, describe, expect, it, vi } from "vitest";
import { appQueryClient } from "~/query/client";
import { projectQueryKeys } from "~/query/queryKeys";
import type { Character, Shot } from "~/types";
import {
	addCharacterReference,
	computeCharacterEmbedding,
	removeCharacterReference,
	saveShotPatch,
} from "./cardActions";

const api = vi.hoisted(() => ({
	shotsApi: { update: vi.fn() },
	charactersApi: { addReferenceImage: vi.fn(), deleteReferenceImage: vi.fn(), computeEmbedding: vi.fn() },
	assetsApi: { uploadImage: vi.fn() },
	projectsApi: { getCharacters: vi.fn() },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("~/services/api", () => api);
vi.mock("~/utils/toast", () => ({ toast }));

const shot = (over: Partial<Shot> = {}) => ({ id: 4, project_id: 1, order: 1, description: "old", ...over }) as Shot;
const character = (over: Partial<Character> = {}) => ({ id: 2, project_id: 1, name: "Crow", ...over }) as Character;

beforeEach(() => {
	vi.clearAllMocks();
	appQueryClient.clear();
});

describe("canvas card actions", () => {
	it("saving a shot writes the server copy into the cache", async () => {
		appQueryClient.setQueryData(projectQueryKeys.shots(1), [shot(), shot({ id: 5, order: 2 })]);
		api.shotsApi.update.mockResolvedValue(shot({ description: "new" }));

		expect(await saveShotPatch(4, { description: "new" })).toBe(true);

		expect(api.shotsApi.update).toHaveBeenCalledWith(4, { description: "new" });
		const cached = appQueryClient.getQueryData<Shot[]>(projectQueryKeys.shots(1));
		expect(cached?.map((s) => [s.id, s.description])).toEqual([[4, "new"], [5, "old"]]);
	});

	it("a failed save keeps the cache and says why", async () => {
		appQueryClient.setQueryData(projectQueryKeys.shots(1), [shot()]);
		api.shotsApi.update.mockRejectedValue(new Error("版本冲突"));

		expect(await saveShotPatch(4, { description: "new" })).toBe(false);

		expect(appQueryClient.getQueryData<Shot[]>(projectQueryKeys.shots(1))?.[0].description).toBe("old");
		expect(toast.error).toHaveBeenCalledWith({ title: "分镜保存失败", message: "版本冲突" });
	});

	it("adding a reference uploads, attaches, then reloads the cast", async () => {
		const file = new File(["x"], "ref.png");
		api.assetsApi.uploadImage.mockResolvedValue({ url: "/static/ref.png" });
		api.charactersApi.addReferenceImage.mockResolvedValue({});
		api.projectsApi.getCharacters.mockResolvedValue([character({ reference_images: ["/static/ref.png"] })]);

		expect(await addCharacterReference(2, 1, file)).toBe(true);

		expect(api.assetsApi.uploadImage).toHaveBeenCalledWith(file);
		expect(api.charactersApi.addReferenceImage).toHaveBeenCalledWith(2, "/static/ref.png");
		expect(appQueryClient.getQueryData<Character[]>(projectQueryKeys.characters(1))?.[0].reference_images).toEqual([
			"/static/ref.png",
		]);
		expect(toast.success).toHaveBeenCalledOnce();
	});

	it("a failed upload attaches nothing", async () => {
		api.assetsApi.uploadImage.mockRejectedValue("offline");

		expect(await addCharacterReference(2, 1, new File(["x"], "ref.png"))).toBe(false);

		expect(api.charactersApi.addReferenceImage).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith({ title: "参考图上传失败", message: "请求失败，请重试" });
	});

	it("removing a reference reloads the cast, and reports a failure", async () => {
		api.charactersApi.deleteReferenceImage.mockResolvedValue(undefined);
		api.projectsApi.getCharacters.mockResolvedValue([character({ reference_images: [] })]);

		expect(await removeCharacterReference(2, 1, 0)).toBe(true);
		expect(api.charactersApi.deleteReferenceImage).toHaveBeenCalledWith(2, 0);
		expect(appQueryClient.getQueryData<Character[]>(projectQueryKeys.characters(1))?.[0].reference_images).toEqual([]);

		api.charactersApi.deleteReferenceImage.mockRejectedValue(new Error("gone"));
		expect(await removeCharacterReference(2, 1, 0)).toBe(false);
		expect(toast.error).toHaveBeenCalledWith({ title: "参考图删除失败", message: "gone" });
	});

	it("recomputing the embedding updates that character only", async () => {
		appQueryClient.setQueryData(projectQueryKeys.characters(1), [character(), character({ id: 3, name: "Moth" })]);
		api.charactersApi.computeEmbedding.mockResolvedValue(character({ has_embedding: true } as Partial<Character>));

		expect(await computeCharacterEmbedding(2)).toBe(true);

		const cast = appQueryClient.getQueryData<Character[]>(projectQueryKeys.characters(1));
		expect(cast?.map((c) => [c.id, (c as { has_embedding?: boolean }).has_embedding ?? false])).toEqual([
			[2, true],
			[3, false],
		]);

		api.charactersApi.computeEmbedding.mockRejectedValue(new Error("no face"));
		expect(await computeCharacterEmbedding(2)).toBe(false);
		expect(toast.error).toHaveBeenCalledWith({ title: "特征重算失败", message: "no face" });
	});
});
