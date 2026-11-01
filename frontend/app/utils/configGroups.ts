import type { ConfigItem } from "~/types";

export interface ConfigSection {
	key: string;
	title: string;
	items: ConfigItem[];
}

export function groupConfigs(configs: ConfigItem[]): ConfigSection[] {
	const groups: Record<string, ConfigItem[]> = {
		basic: [],
		database: [],
		text: [],
		image: [],
		video: [],
		vision: [],
		tts: [],
		bgm: [],
	};

	configs.forEach((config) => {
		const key = config.key.toLowerCase();

		// 数据库配置
		if (
			key.startsWith("database_") ||
			key.startsWith("redis_") ||
			key.startsWith("db_")
		) {
			groups.database.push(config);
		}
		// 文本生成服务配置（Anthropic + OpenAI 兼容）
		else if (
			key.startsWith("anthropic_") ||
			key.startsWith("text_")
		) {
			groups.text.push(config);
		}
		// 图像服务配置
		else if (
			key.startsWith("image_") ||
			key.startsWith("fake_image_") ||
			key === "enable_image_to_image"
		) {
			groups.image.push(config);
		}
		// 视频服务配置
		else if (
			key.startsWith("video_") ||
			key.startsWith("doubao_") ||
			key.startsWith("fake_video_") ||
			key === "enable_image_to_video"
		) {
			groups.video.push(config);
		}
		// 视觉审查（质量审查闭环 + 看图模型）
		else if (key.startsWith("critique_")) {
			groups.vision.push(config);
		}
		// 配音
		else if (key.startsWith("tts_") || key.startsWith("subtitle_")) {
			groups.tts.push(config);
		}
		// 背景音乐
		else if (key.startsWith("bgm_")) {
			groups.bgm.push(config);
		}
		// 基础设置
		else {
			groups.basic.push(config);
		}
	});

	return [
		{ key: "text", title: "文本生成服务", items: groups.text },
		{ key: "image", title: "图像生成服务", items: groups.image },
		{ key: "video", title: "视频服务", items: groups.video },
		{ key: "vision", title: "视觉审查", items: groups.vision },
		{ key: "tts", title: "配音与字幕", items: groups.tts },
		{ key: "bgm", title: "背景音乐", items: groups.bgm },
		{ key: "basic", title: "基础设置", items: groups.basic },
		{ key: "database", title: "数据库配置", items: groups.database },
	].filter((section) => section.items.length > 0); // 过滤空分组
}
