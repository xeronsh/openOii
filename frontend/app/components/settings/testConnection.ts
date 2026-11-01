import type { ConfigValue } from "~/types";

type Service = "llm" | "image" | "video" | "vision" | "tts" | "bgm";

const SERVICE_BY_TAB: Record<string, Service> = { text: "llm", image: "image", video: "video", vision: "vision", tts: "tts", bgm: "bgm" };

// The backend rejects non-whitelisted override keys with 400.
const SERVICE_PREFIXES: Record<Service, string[]> = {
	llm: ["text_", "anthropic_"],
	image: ["image_", "fake_image_", "enable_image_to_image"],
	vision: ["critique_vision_"],
	tts: ["tts_provider", "tts_base_url", "tts_api_key", "tts_model", "tts_default_voice"],
	bgm: ["bgm_provider", "bgm_base_url", "bgm_api_key", "bgm_model"],
	video: [
		"video_",
		"doubao_",
		"fake_video_",
		"enable_image_to_video",
		"video_image_mode",
		"video_inline_local_images",
	],
};

export function testServiceFor(tab: string): Service | null {
	return SERVICE_BY_TAB[tab] ?? null;
}

/** 只把当前服务相关的字段作为覆盖值发给"测试连接" */
export function testOverrides(service: Service, formState: Record<string, ConfigValue>) {
	const prefixes = SERVICE_PREFIXES[service];
	return Object.fromEntries(
		Object.entries(formState)
			.filter(([key]) => {
				const lower = key.toLowerCase();
				return prefixes.some((p) => lower.startsWith(p) || lower === p);
			})
			.map(([key, value]) => [key, value === null ? null : String(value)] as const)
			.filter(([key, value]) => {
				// Empty inputs mean "use the current effective backend value". Sending an
				// empty string would override env/default values and can make fake probes fail.
				if (value !== "") return true;
				const lower = key.toLowerCase();
				return lower.endsWith("_provider") || lower.startsWith("enable_");
			}),
	) as Record<string, string | null>;
}
