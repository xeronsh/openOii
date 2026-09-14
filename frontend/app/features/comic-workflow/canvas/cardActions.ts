import { appQueryClient } from "~/query/client";
import {
	upsertCharacterInCache,
	upsertShotInCache,
} from "~/query/applyServerEvent";
import { projectQueryKeys } from "~/query/queryKeys";
import { assetsApi, charactersApi, projectsApi, shotsApi } from "~/services/api";
import { toast } from "~/utils/toast";
import type { Character, Shot, ShotUpdatePayload } from "~/types";

/**
 * 画布卡片的业务动作。
 *
 * 画布 shape 组件渲染在 tldraw 内部，不依赖 react-query context——
 * 这里直接调 API 并写回应用级 QueryClient，让 graph 投影自然重建。
 * WS 事件到达时 applyServerEvent 会以同样的方式覆盖为服务端权威态。
 */

function upsertShot(next: Shot) {
	upsertShotInCache(appQueryClient, next.project_id, next);
}

function upsertCharacter(next: Character) {
	upsertCharacterInCache(appQueryClient, next.project_id, next);
}

function reportError(title: string, error: unknown) {
	toast.error({
		title,
		message: error instanceof Error ? error.message : "请求失败，请重试",
	});
}

export async function saveShotPatch(
	shotId: number,
	patch: ShotUpdatePayload,
): Promise<boolean> {
	try {
		const updated = await shotsApi.update(shotId, patch);
		upsertShot(updated);
		return true;
	} catch (error) {
		reportError("分镜保存失败", error);
		return false;
	}
}

export async function approveShot(shotId: number): Promise<boolean> {
	try {
		const updated = await shotsApi.approve(shotId);
		upsertShot(updated);
		toast.success({ title: "分镜已通过", message: "该格已锁定为当前版本", duration: 2500 });
		return true;
	} catch (error) {
		reportError("通过失败", error);
		return false;
	}
}

export async function regenerateShot(shotId: number): Promise<boolean> {
	try {
		await shotsApi.regenerate(shotId, "image");
		toast.info({ title: "已开始重做本格", message: "生成进度见对话流", duration: 3000 });
		return true;
	} catch (error) {
		reportError("重做失败", error);
		return false;
	}
}

export async function approveCharacter(characterId: number): Promise<boolean> {
	try {
		const updated = await charactersApi.approve(characterId);
		upsertCharacter(updated);
		toast.success({ title: "角色已通过", message: "角色设定已锁定为当前版本", duration: 2500 });
		return true;
	} catch (error) {
		reportError("通过失败", error);
		return false;
	}
}

export async function regenerateCharacter(characterId: number): Promise<boolean> {
	try {
		await charactersApi.regenerate(characterId);
		toast.info({ title: "已开始重做角色图", message: "生成进度见对话流", duration: 3000 });
		return true;
	} catch (error) {
		reportError("重做失败", error);
		return false;
	}
}

/** 参考图操作后重拉整份角色列表：bible 接口只返回 bible，Query 里是 Character */
async function refreshCharacters(projectId: number) {
	const list = await projectsApi.getCharacters(projectId);
	appQueryClient.setQueryData<Character[]>(projectQueryKeys.characters(projectId), list);
}

export async function addCharacterReference(
	characterId: number,
	projectId: number,
	file: File,
): Promise<boolean> {
	try {
		const { url } = await assetsApi.uploadImage(file);
		await charactersApi.addReferenceImage(characterId, url);
		await refreshCharacters(projectId);
		toast.success({ title: "参考图已添加", message: "可点缩略图右上角删除", duration: 2500 });
		return true;
	} catch (error) {
		reportError("参考图上传失败", error);
		return false;
	}
}

export async function removeCharacterReference(
	characterId: number,
	projectId: number,
	index: number,
): Promise<boolean> {
	try {
		await charactersApi.deleteReferenceImage(characterId, index);
		await refreshCharacters(projectId);
		return true;
	} catch (error) {
		reportError("参考图删除失败", error);
		return false;
	}
}

export async function computeCharacterEmbedding(
	characterId: number,
): Promise<boolean> {
	try {
		const updated = await charactersApi.computeEmbedding(characterId);
		upsertCharacter(updated);
		toast.success({ title: "角色特征已重算", message: "后续分镜将按新参考图保持一致", duration: 2500 });
		return true;
	} catch (error) {
		reportError("特征重算失败", error);
		return false;
	}
}
