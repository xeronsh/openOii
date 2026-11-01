import { describe, it, expect } from "vitest";
import { groupConfigs } from "./configGroups";
import type { ConfigItem } from "~/types";

function makeConfig(key: string, overrides?: Partial<ConfigItem>): ConfigItem {
	return {
		key,
		value: "test",
		is_sensitive: false,
		is_masked: false,
		source: "db",
		...overrides,
	};
}

describe("groupConfigs", () => {
	it("数据库配置归类到 database 组", () => {
		const items = [
			makeConfig("DATABASE_URL"),
			makeConfig("REDIS_URL"),
			makeConfig("DB_ECHO"),
		];
		const sections = groupConfigs(items);
		const dbSection = sections.find((s) => s.key === "database");
		expect(dbSection).toBeDefined();
		expect(dbSection!.items).toHaveLength(3);
	});

	it("文本生成配置归类到 text 组", () => {
		const items = [
			makeConfig("ANTHROPIC_API_KEY"),
			makeConfig("ANTHROPIC_BASE_URL"),
			makeConfig("TEXT_PROVIDER"),
			makeConfig("TEXT_BASE_URL"),
			makeConfig("TEXT_API_KEY"),
		];
		const sections = groupConfigs(items);
		const textSection = sections.find((s) => s.key === "text");
		expect(textSection).toBeDefined();
		expect(textSection!.items).toHaveLength(5);
	});

	it("图像服务配置归类到 image 组", () => {
		const items = [
			makeConfig("IMAGE_BASE_URL"),
			makeConfig("IMAGE_API_KEY"),
			makeConfig("ENABLE_IMAGE_TO_IMAGE"),
		];
		const sections = groupConfigs(items);
		const imageSection = sections.find((s) => s.key === "image");
		expect(imageSection).toBeDefined();
		expect(imageSection!.items).toHaveLength(3);
	});

	it("视频服务配置归类到 video 组", () => {
		const items = [
			makeConfig("VIDEO_PROVIDER"),
			makeConfig("VIDEO_BASE_URL"),
			makeConfig("DOUBAO_API_KEY"),
			makeConfig("DOUBAO_VIDEO_MODEL"),
			makeConfig("ENABLE_IMAGE_TO_VIDEO"),
			makeConfig("VIDEO_IMAGE_MODE"),
			makeConfig("FAKE_VIDEO_FIXTURE_URL"),
			makeConfig("FAKE_VIDEO_FIXTURE_PATH"),
		];
		const sections = groupConfigs(items);
		const videoSection = sections.find((s) => s.key === "video");
		expect(videoSection).toBeDefined();
		expect(videoSection!.items).toHaveLength(8);
	});

	it("其他配置归类到 basic 组", () => {
		const items = [
			makeConfig("APP_NAME"),
			makeConfig("ENVIRONMENT"),
			makeConfig("API_V1_PREFIX"),
			makeConfig("CORS_ORIGINS"),
			makeConfig("ADMIN_TOKEN"),
			makeConfig("REQUEST_TIMEOUT_S"),
			makeConfig("PUBLIC_BASE_URL"),
		];
		const sections = groupConfigs(items);
		const basicSection = sections.find((s) => s.key === "basic");
		expect(basicSection).toBeDefined();
		expect(basicSection!.items).toHaveLength(7);
	});

	it("空分组被过滤掉", () => {
		const items = [makeConfig("APP_NAME")];
		const sections = groupConfigs(items);
		// 只有 basic 有内容
		expect(sections).toHaveLength(1);
		expect(sections[0].key).toBe("basic");
	});

	it("混合配置正确分组", () => {
		const items = [
			makeConfig("APP_NAME"),
			makeConfig("DATABASE_URL"),
			makeConfig("TEXT_PROVIDER"),
			makeConfig("IMAGE_API_KEY"),
			makeConfig("VIDEO_MODEL"),
		];
		const sections = groupConfigs(items);
		expect(sections.find((s) => s.key === "basic")!.items).toHaveLength(1);
		expect(sections.find((s) => s.key === "database")!.items).toHaveLength(1);
		expect(sections.find((s) => s.key === "text")!.items).toHaveLength(1);
		expect(sections.find((s) => s.key === "image")!.items).toHaveLength(1);
		expect(sections.find((s) => s.key === "video")!.items).toHaveLength(1);
	});

	it("空输入返回空数组", () => {
		expect(groupConfigs([])).toEqual([]);
	});
});
