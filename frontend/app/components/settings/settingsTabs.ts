import type { IconName } from "~/components/ui/SvgIcon";
import type { ConfigItem } from "~/types";
import "~/components/ui/icons/settingsIcons";


export const TAB_CONFIG: Record<string, { icon: IconName; title: string; desc: string }> = {
	basic: { icon: "tools", title: "基础", desc: "应用名称、环境等基础配置" },
	database: { icon: "database", title: "数据库", desc: "数据库连接配置" },
	text: {
		icon: "sparks",
		title: "文本生成",
		desc: "选一个服务商，地址、接口路径和推荐模型会自动填好，只需填 API Key；网关或中转站选「自定义」",
	},
	image: {
		icon: "image",
		title: "图像服务",
		desc: "选一个图像服务商自动填好地址和模型；默认 ModelScope 魔搭，其它 OpenAI 兼容服务选「自定义」",
	},
	video: {
		icon: "video-camera",
		title: "视频服务",
		desc: "选一个视频服务商自动填好配置；豆包、可灵、Vidu、CogVideoX、海螺、万相、Veo 走各自的原生接口，其它兼容服务选「自定义」",
	},
	vision: {
		icon: "eye",
		title: "视觉审查",
		desc: "质量审查要看图：选一个支持图片输入的模型。没配置或服务挂掉时，分镜会标为「未检查」，不会当作通过",
	},
	tts: {
		icon: "microphone",
		title: "配音与字幕",
		desc: "成片里的台词配音（默认 Edge 免费配音，也可以换成云端服务商）和字幕；每个项目可以在属性面板里单独开关",
	},
	bgm: {
		icon: "music-double-note",
		title: "背景音乐",
		desc: "整部片一条背景音乐，台词处自动压低",
	},
};

export interface ProviderGroup {
	title: string | ((provider: string) => string);
	/** 只在这些 provider 下显示；省略表示总是显示（通用配置） */
	providers?: string[];
	match: (key: string) => boolean;
	note?: string;
	/** 按当前 provider 给出更贴切的字段说明（替代通用说明） */
	hint?: (key: string, provider: string) => string | undefined;
}

export interface ProviderTab {
	/** 接口协议对应的配置键；省略表示只有一种协议，不显示选择 */
	providerKey?: string;
	defaultProvider: string;
	icon: IconName;
	layout: "row" | "grid";
	/** native：服务商原生接口，只在选中时显示（通过上方预设选择） */
	options: { value: string; title: string; desc: string; native?: boolean }[];
	groups: ProviderGroup[];
}

const VIDEO_COMMON = ["video_image_mode", "enable_image_to_video", "video_inline_local_images"];
const VIDEO_VENDORS = ["kling", "vidu", "zhipu", "minimax", "dashscope", "veo"];
const VIDEO_VENDOR_NAMES = ["可灵", "Vidu", "智谱 CogVideoX", "MiniMax 海螺", "通义万相", "Google Veo"];
const VIDEO_VENDOR_HINTS: Record<string, (name: string) => string> = {
	video_base_url: (name) => `${name}原生接口的基础地址，选上面的预设会按地域自动填好`,
	video_api_key: (name) => `${name}的 API 密钥`,
	video_model: (name) => `${name}的模型名称，推荐值见上方预设`,
	video_ratio: (name) => `生成画幅（如 16:9、9:16）；${name}不支持的画幅会换成最接近的可选值`,
};
const vendorName = (provider: string) => VIDEO_VENDOR_NAMES[VIDEO_VENDORS.indexOf(provider)] ?? provider;
const isVideoKey = (k: string) => k.startsWith("video_") && k !== "video_provider" && !VIDEO_COMMON.includes(k);

/** 文本 / 图像 / 视频三个 provider 页签的声明：选 provider，再显示对应分组 */
export const PROVIDER_TABS: Record<string, ProviderTab> = {
	text: {
		providerKey: "text_provider",
		defaultProvider: "anthropic",
		icon: "sparks",
		layout: "row",
		options: [
			{ value: "anthropic", title: "Anthropic Claude", desc: "Messages 原生接口，官方或中转；引擎原生适配只认 Claude 4.x 型号" },
			{ value: "openai", title: "OpenAI 兼容", desc: "支持任何 OpenAI 兼容接口" },
			{ value: "fake", title: "Fake 本地测试", desc: "不调用外部文本 API，避免测试扣费" },
		],
		groups: [
			{ title: "Anthropic Claude 配置", providers: ["anthropic"], match: (k) => k.startsWith("anthropic_") },
			{
				title: "OpenAI 兼容接口配置",
				providers: ["openai"],
				match: (k) => k.startsWith("text_") && k !== "text_provider",
			},
			{
				title: "Fake 本地测试配置",
				providers: ["fake"],
				// The fake text model has no settings; the group only shows its note.
				match: () => false,
				note: "启用后生成链路不会调用外部文本生成 API。",
			},
		],
	},
	image: {
		providerKey: "image_provider",
		defaultProvider: "modelscope",
		icon: "image",
		layout: "grid",
		options: [
			{ value: "openai", title: "OpenAI 兼容", desc: "/images/generations 兼容接口，如 OpenAI gpt-image" },
			{ value: "modelscope", title: "ModelScope", desc: "异步图片任务，支持 Z-Image-Turbo" },
			{ value: "fake", title: "Fake 本地测试", desc: "返回本地占位图，不调用外部图像 API" },
		],
		groups: [
			{
				title: (p) => (p === "modelscope" ? "ModelScope 图像接口配置" : "OpenAI 兼容接口配置"),
				providers: ["modelscope", "openai"],
				match: (k) => k.startsWith("image_") && k !== "image_provider",
			},
			{
				title: "Fake 本地测试配置",
				providers: ["fake"],
				match: (k) => k.startsWith("fake_image_"),
				note: "未配置固定 URL 时会返回内置 SVG 占位图。",
			},
			{ title: "通用配置", match: (k) => k === "enable_image_to_image" },
		],
	},
	video: {
		providerKey: "video_provider",
		defaultProvider: "openai",
		icon: "video-camera",
		layout: "row",
		options: [
			{ value: "doubao", title: "豆包视频", desc: "火山引擎 Ark API，国内推荐" },
			{ value: "openai", title: "OpenAI 兼容", desc: "支持任何 OpenAI 兼容接口" },
			{ value: "fake", title: "Fake 本地测试", desc: "使用本地视频素材，不调用外部视频 API" },
			...VIDEO_VENDORS.map((value, i) => ({
				value,
				title: VIDEO_VENDOR_NAMES[i]!,
				desc: "服务商原生异步接口，由上方预设选择",
				native: true,
			})),
		],
		groups: [
			{ title: "豆包视频配置", providers: ["doubao"], match: (k) => k.startsWith("doubao_") },
			{
				title: "OpenAI 兼容接口配置",
				providers: ["openai"],
				match: (k) => isVideoKey(k) && k !== "video_ratio",
				hint: (k) => (k === "video_base_url" ? "OpenAI 兼容视频服务的基础地址，接口路径单独填在下面" : undefined),
			},
			{
				title: "服务商原生接口配置",
				providers: VIDEO_VENDORS,
				match: (k) => isVideoKey(k) && k !== "video_endpoint",
				hint: (k, provider) => VIDEO_VENDOR_HINTS[k]?.(vendorName(provider)),
			},
			{ title: "Fake 本地测试配置", providers: ["fake"], match: (k) => k.startsWith("fake_video_") },
			{ title: "通用配置", match: (k) => VIDEO_COMMON.includes(k) },
		],
	},
};

PROVIDER_TABS.vision = {
	defaultProvider: "openai",
	icon: "eye",
	layout: "row",
	options: [{ value: "openai", title: "OpenAI 兼容", desc: "chat/completions，图片作为 image_url 传入" }],
	groups: [
		{
			title: "视觉模型接口",
			providers: ["openai"],
			match: (k) => k.startsWith("critique_vision_"),
		},
		{ title: "审查规则", match: (k) => k.startsWith("critique_") && !k.startsWith("critique_vision_") },
	],
};

const TTS_CLOUD = ["openai", "doubao", "cosyvoice", "minimax", "elevenlabs", "azure"];
const TTS_LINK = ["tts_base_url", "tts_api_key", "tts_model"];

PROVIDER_TABS.tts = {
	providerKey: "tts_provider",
	defaultProvider: "edge",
	icon: "microphone",
	layout: "row",
	options: [
		{ value: "edge", title: "Edge 免费配音", desc: "无需密钥，按角色描述自动挑音色" },
		{ value: "openai", title: "OpenAI 兼容", desc: "/audio/speech 兼容接口" },
		...Object.entries({
			doubao: "豆包语音",
			cosyvoice: "阿里 CosyVoice",
			minimax: "MiniMax 语音",
			elevenlabs: "ElevenLabs",
			azure: "Azure 语音",
		}).map(([value, title]) => ({
			value,
			title,
			desc: "服务商原生接口，由上方预设选择",
			native: true,
		})),
	],
	groups: [
		{ title: "配音接口", providers: TTS_CLOUD, match: (k) => TTS_LINK.includes(k) },
		{
			title: "配音选项",
			match: (k) => k.startsWith("tts_") && k !== "tts_provider" && !TTS_LINK.includes(k),
		},
		{
			title: "字幕",
			match: (k) => k.startsWith("subtitle_"),
			note: "字幕按剧本台词生成，时间跟着配音走；soft 是播放器里可以关的字幕轨，burn 直接画进画面。",
		},
	],
};

const BGM_LINK = ["bgm_base_url", "bgm_api_key", "bgm_model"];

PROVIDER_TABS.bgm = {
	providerKey: "bgm_provider",
	defaultProvider: "library",
	icon: "music-double-note",
	layout: "row",
	options: [
		{ value: "library", title: "内置曲库", desc: "免费，本机合成" },
		{ value: "suno", title: "Suno 兼容网关", desc: "suno-api 网关" },
		...Object.entries({ minimax: "MiniMax 音乐", stability: "Stable Audio" }).map(([value, title]) => ({
			value,
			title,
			desc: "服务商原生接口，由上方预设选择",
			native: true,
		})),
	],
	groups: [
		{ title: "音乐接口", providers: ["minimax", "stability", "suno"], match: (k) => BGM_LINK.includes(k) },
		{ title: "背景音乐选项", match: (k) => k.startsWith("bgm_") && k !== "bgm_provider" && !BGM_LINK.includes(k) },
	],
};

export function itemsFor(items: ConfigItem[], match: (key: string) => boolean) {
	return items.filter((i) => match(i.key.toLowerCase()));
}
