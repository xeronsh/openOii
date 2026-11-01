/**
 * 设置页「服务商预设」。
 *
 * 每个预设都来自服务商官方文档（sources），核对日期见 PRESETS_VERIFIED_AT。
 * 预设只是把已有配置项填好：它映射到 provider 类型（openai 兼容 / anthropic /
 * modelscope / doubao / fake，以及视频服务商原生接口 kling / vidu / zhipu /
 * minimax / dashscope / veo）。
 * 官方接口和 openOii 的请求形状对不上的服务商不放进来，原因写在 docs/providers.md。
 */

export const PRESETS_VERIFIED_AT = "2026-10-30";

export type PresetService = "text" | "image" | "video" | "vision" | "tts" | "bgm";
export type VideoVendor = "kling" | "vidu" | "zhipu" | "minimax" | "dashscope" | "veo";
export type TtsVendor = "edge" | "elevenlabs" | "azure" | "cosyvoice";
export type BgmVendor = "library" | "stability" | "suno";
export type PresetProvider = "openai" | "anthropic" | "modelscope" | "doubao" | "fake" | VideoVendor | TtsVendor | BgmVendor;
export type PresetGroup = "domestic" | "global" | "local";

export const PRESET_GROUP_LABEL: Record<PresetGroup, string> = {
	domestic: "国内",
	global: "海外",
	local: "本地与自定义",
};

export interface PresetRegion {
	id: string;
	label: string;
	/** 可以带 {fieldId} 占位，由 fields 填入 */
	baseUrl: string;
}

export interface PresetField {
	id: string;
	label: string;
	placeholder: string;
	help: string;
	/** 只用于正则还原：允许的字符 */
	pattern?: string;
}

export interface ProviderPreset {
	id: string;
	service: PresetService;
	provider: PresetProvider;
	group: PresetGroup;
	name: string;
	/** 文字标记，1–3 个字符：没有 logo 或 logo 加载失败时显示 */
	mark: string;
	/** public/provider-logos/{logo}.svg（Lobe Icons，MIT）：品牌彩色标，放在浅色方块上显示 */
	logo?: string;
	tagline: string;
	regions: PresetRegion[];
	endpoint?: string;
	defaultModel: string;
	models: string[];
	/** 模型输入框的标题（Azure 填部署名、方舟可填接入点 ID） */
	modelLabel?: string;
	keyHint: string;
	keyUrl?: string;
	/** 本地服务一般不需要密钥 */
	keyOptional?: boolean;
	docsUrl?: string;
	sources: string[];
	fields?: PresetField[];
	notes?: string[];
	experimental?: boolean;
	/** 通用自定义（每个服务一个）：只切接口协议，地址、密钥和模型就地填写 */
	custom?: boolean;
	/** 配音：推荐音色（写入 TTS_DEFAULT_VOICE，角色可以单独指定） */
	defaultVoice?: string;
	voices?: string[];
}

const CHAT = "/chat/completions";

const TEXT_PRESETS: ProviderPreset[] = [
	{
		id: "deepseek",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "DeepSeek",
		mark: "DS",
		logo: "deepseek",
		tagline: "深度求索官方 API",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.deepseek.com" }],
		endpoint: CHAT,
		defaultModel: "deepseek-flash",
		models: ["deepseek-flash", "deepseek-v4-pro"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.deepseek.com/api_keys",
		docsUrl: "https://api-docs.deepseek.com/",
		sources: ["https://api-docs.deepseek.com/", "https://api-docs.deepseek.com/updates/"],
		notes: ["deepseek-chat / deepseek-reasoner 已于 2026-07-24 下线。"],
	},
	{
		id: "dashscope",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "阿里云百炼",
		mark: "百",
		logo: "bailian",
		tagline: "通义千问 · OpenAI 兼容模式",
		regions: [
			{ id: "cn-beijing", label: "北京", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
			{ id: "ap-southeast-1", label: "新加坡", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
			{
				id: "ws-cn-beijing",
				label: "北京 · 专属域名",
				baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			},
			{
				id: "ws-us-east-1",
				label: "美国（弗吉尼亚）",
				baseUrl: "https://{workspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
			},
			{
				id: "ws-ap-northeast-1",
				label: "日本（东京）",
				baseUrl: "https://{workspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1",
			},
		],
		endpoint: CHAT,
		defaultModel: "qwen3.8-max",
		models: ["qwen3.8-max", "qwen3.7-plus"],
		keyHint: "sk- 开头；密钥绑定地域，北京的密钥不能用于新加坡",
		keyUrl: "https://help.aliyun.com/zh/model-studio/get-api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
		sources: [
			"https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
			"https://help.aliyun.com/zh/model-studio/get-api-key",
		],
		fields: [
			{
				id: "workspaceId",
				label: "业务空间 ID",
				placeholder: "llm-xxxxxxxx",
				help: "百炼控制台 → 业务空间详情；只有专属域名需要。",
				pattern: "[A-Za-z0-9-]+",
			},
		],
		notes: ["地域和密钥不匹配时会返回 401 invalid_api_key。"],
	},
	{
		id: "zhipu",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "智谱 BigModel",
		mark: "智",
		logo: "zhipu",
		tagline: "GLM 系列",
		regions: [{ id: "cn", label: "国内", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }],
		endpoint: CHAT,
		defaultModel: "glm-5.3",
		models: ["glm-5.3", "glm-5.2", "glm-5.3-flash"],
		keyHint: "控制台生成的 API Key（id.secret 形式）",
		keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
		docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
		sources: ["https://docs.bigmodel.cn/cn/guide/develop/openai/introduction"],
		notes: ["temperature 取值 (0, 1)。"],
	},
	{
		id: "kimi",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "Kimi（月之暗面）",
		mark: "K",
		logo: "kimi",
		tagline: "Kimi K3",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.moonshot.cn/v1" },
			{ id: "global", label: "海外", baseUrl: "https://api.moonshot.ai/v1" },
		],
		endpoint: CHAT,
		defaultModel: "kimi-k3",
		models: ["kimi-k3"],
		keyHint: "sk- 开头；国内站和海外站的密钥互不通用",
		keyUrl: "https://platform.kimi.com/",
		docsUrl: "https://platform.kimi.com/docs/api/overview",
		sources: ["https://platform.kimi.com/docs/api/overview", "https://platform.kimi.com/docs/guide/kimi-k3-quickstart"],
		notes: ["K3 的推理强度对应高级设置里的「推理强度」：low / high 可用，max 引擎暂不支持。"],
	},
	{
		id: "minimax",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "MiniMax",
		mark: "MM",
		logo: "minimax",
		tagline: "MiniMax M3",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.minimaxi.com/v1" },
			{ id: "global", label: "海外", baseUrl: "https://api.minimax.io/v1" },
		],
		endpoint: CHAT,
		defaultModel: "MiniMax-M3",
		models: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
		keyHint: "密钥按站点区分：国内用 minimaxi.com，海外用 minimax.io",
		keyUrl: "https://platform.minimaxi.com/",
		docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
		sources: [
			"https://platform.minimax.io/docs/api-reference/text-openai-api",
			"https://platform.minimax.cn/docs/faq/models",
		],
		notes: ["MiniMax-M2.5 / M2.7 将于 2026-11-18 下线。"],
	},
	{
		id: "volcengine",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "火山方舟",
		mark: "方",
		logo: "volcengine",
		tagline: "豆包大模型",
		regions: [{ id: "cn-beijing", label: "北京", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }],
		endpoint: CHAT,
		defaultModel: "doubao-seed-2-1-pro-260915",
		models: ["doubao-seed-2-1-pro-260915"],
		modelLabel: "模型 ID 或接入点 ID（ep-…）",
		keyHint: "方舟 API Key（ARK_API_KEY）",
		keyUrl: "https://ark.volcengine.com/region:cn-beijing/apikey",
		docsUrl: "https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk",
		sources: ["https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk"],
	},
	{
		id: "qianfan",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "百度千帆",
		mark: "千",
		logo: "baiducloud",
		tagline: "文心 ERNIE 及第三方模型",
		regions: [{ id: "cn", label: "国内", baseUrl: "https://qianfan.baidubce.com/v2" }],
		endpoint: CHAT,
		defaultModel: "ernie-4.5-turbo-128k",
		models: ["ernie-4.5-turbo-128k", "deepseek-v3.1-250821"],
		keyHint: "bce-v3/ALTAK- 开头",
		keyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
		docsUrl: "https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26",
		sources: ["https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26"],
		notes: ["openOii 不发送 appid 请求头：请使用对全部应用有权限的 API Key。"],
	},
	{
		id: "hunyuan",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "腾讯混元",
		mark: "混",
		logo: "hunyuan",
		tagline: "TokenHub",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://tokenhub.tencentmaas.com/v1" },
			{ id: "intl", label: "国际", baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1" },
		],
		endpoint: CHAT,
		defaultModel: "hy4-preview",
		models: ["hy4-preview", "hy3"],
		keyHint: "TokenHub 控制台创建的 API Key",
		keyUrl: "https://cloud.tencent.com/document/product/1823/130051",
		docsUrl: "https://cloud.tencent.com/document/product/1823/130051",
		sources: [
			"https://cloud.tencent.com/document/product/1823/130051",
			"https://cloud.tencent.com/document/product/1823/131382",
		],
		notes: ["旧地址 api.hunyuan.cloud.tencent.com 已于 2026-09-30 停用。"],
	},
	{
		id: "siliconflow",
		service: "text",
		provider: "openai",
		group: "domestic",
		name: "硅基流动",
		mark: "硅",
		logo: "siliconcloud",
		tagline: "开源模型聚合",
		regions: [{ id: "cn", label: "国内", baseUrl: "https://api.siliconflow.cn/v1" }],
		endpoint: CHAT,
		defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
		models: ["deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3", "tencent/Hy4-preview"],
		keyHint: "sk- 开头",
		keyUrl: "https://cloud.siliconflow.cn/account/ak",
		docsUrl: "https://docs.siliconflow.cn/",
		sources: ["https://docs.siliconflow.cn/"],
		notes: ["官方已从 .com 迁移到 api.siliconflow.cn。"],
	},
	{
		id: "openai",
		service: "text",
		provider: "openai",
		group: "global",
		name: "OpenAI",
		mark: "OA",
		logo: "openai",
		tagline: "GPT-6 系列",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.openai.com/v1" }],
		endpoint: CHAT,
		defaultModel: "gpt-6-astra",
		models: ["gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.openai.com/api-keys",
		docsUrl: "https://developers.openai.com/api/reference/python/resources/chat/index.md",
		sources: ["https://developers.openai.com/api/docs/changelog"],
	},
	{
		id: "anthropic",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Anthropic Claude",
		mark: "A",
		logo: "claude",
		tagline: "官方 OpenAI 兼容层",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.anthropic.com/v1" }],
		endpoint: CHAT,
		defaultModel: "claude-sonnet-5-5",
		models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
		keyHint: "sk-ant- 开头",
		keyUrl: "https://console.anthropic.com/settings/keys",
		docsUrl: "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
		sources: [
			"https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
			"https://platform.claude.com/docs/en/models/overview",
		],
		notes: [
			"走 Anthropic 官方的 OpenAI 兼容层，Claude 5.5 系列可直接用；提示缓存、引用等原生特性不可用。",
			"需要原生 Messages 接口或中转站时，选「自定义」后在「高级设置」里把接口协议切到 Anthropic。",
		],
	},
	{
		id: "gemini",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Google Gemini",
		mark: "G",
		logo: "gemini",
		tagline: "OpenAI 兼容端点",
		regions: [{ id: "default", label: "官方", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }],
		endpoint: CHAT,
		defaultModel: "gemini-3.8-flash",
		models: ["gemini-3.8-flash"],
		keyHint: "AI Studio 生成的 API Key",
		keyUrl: "https://aistudio.google.com/apikey",
		docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
		sources: ["https://ai.google.dev/gemini-api/docs/openai"],
	},
	{
		id: "xai",
		service: "text",
		provider: "openai",
		group: "global",
		name: "xAI Grok",
		mark: "X",
		logo: "xai",
		tagline: "Grok 4.7",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.x.ai/v1" }],
		endpoint: CHAT,
		defaultModel: "grok-4.7",
		models: ["grok-4.7", "grok-4.6"],
		keyHint: "xai- 开头",
		keyUrl: "https://console.x.ai/",
		docsUrl: "https://docs.x.ai/developers/rest-api-reference/inference/chat-completions",
		sources: ["https://docs.x.ai/developers/rest-api-reference/inference/chat-completions"],
		notes: ["推理模型响应较慢，可把高级设置里的请求超时调大。"],
	},
	{
		id: "mistral",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Mistral",
		mark: "M",
		logo: "mistral",
		tagline: "Mistral Large",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.mistral.ai/v1" }],
		endpoint: CHAT,
		defaultModel: "mistral-large-4",
		models: ["mistral-large-4", "mistral-medium-3-5"],
		keyHint: "控制台生成的 API Key",
		keyUrl: "https://console.mistral.ai/api-keys",
		docsUrl: "https://docs.mistral.ai/api",
		sources: ["https://docs.mistral.ai/api", "https://docs.mistral.ai/models.md"],
	},
	{
		id: "openrouter",
		service: "text",
		provider: "openai",
		group: "global",
		name: "OpenRouter",
		mark: "OR",
		logo: "openrouter",
		tagline: "多家模型统一入口",
		regions: [{ id: "default", label: "官方", baseUrl: "https://openrouter.ai/api/v1" }],
		endpoint: CHAT,
		defaultModel: "openrouter/auto",
		models: ["openrouter/auto"],
		modelLabel: "模型（厂商/模型名）",
		keyHint: "sk-or- 开头",
		keyUrl: "https://openrouter.ai/keys",
		docsUrl: "https://openrouter.ai/docs/quickstart",
		sources: ["https://openrouter.ai/docs/quickstart"],
	},
	{
		id: "groq",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Groq",
		mark: "Gq",
		logo: "groq",
		tagline: "低延迟推理",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.groq.com/openai/v1" }],
		endpoint: CHAT,
		defaultModel: "openai/gpt-oss-120b",
		models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
		keyHint: "gsk_ 开头",
		keyUrl: "https://console.groq.com/keys",
		docsUrl: "https://console.groq.com/docs/openai",
		sources: ["https://console.groq.com/docs/openai", "https://console.groq.com/docs/models"],
	},
	{
		id: "together",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Together AI",
		mark: "T",
		logo: "together",
		tagline: "开源模型托管",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.together.xyz/v1" }],
		endpoint: CHAT,
		defaultModel: "openai/gpt-oss-120b",
		models: ["openai/gpt-oss-120b"],
		keyHint: "控制台生成的 API Key",
		keyUrl: "https://api.together.ai/settings/api-keys",
		docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
		sources: ["https://docs.together.ai/docs/openai-api-compatibility"],
	},
	{
		id: "azure",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Azure OpenAI",
		mark: "Az",
		logo: "azure",
		tagline: "v1 接口 · 按部署调用",
		regions: [{ id: "default", label: "资源终结点", baseUrl: "https://{resource}.openai.azure.com/openai/v1" }],
		endpoint: CHAT,
		defaultModel: "",
		models: [],
		modelLabel: "部署名称",
		keyHint: "Azure 门户 → 资源 → 密钥和终结点",
		keyUrl: "https://portal.azure.com/",
		docsUrl: "https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle",
		sources: ["https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle"],
		fields: [
			{
				id: "resource",
				label: "资源名称",
				placeholder: "my-openai",
				help: "终结点 https://<资源名称>.openai.azure.com 里的那一段。",
				pattern: "[A-Za-z0-9-]+",
			},
		],
		notes: ["使用不带 api-version 的 v1 接口；旧的 /deployments/…?api-version= 地址请用自定义。"],
	},
	{
		id: "bedrock",
		service: "text",
		provider: "openai",
		group: "global",
		name: "Amazon Bedrock",
		mark: "AWS",
		logo: "bedrock",
		tagline: "Chat Completions 兼容端点",
		regions: [
			{ id: "us-east-1", label: "us-east-1", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1" },
			{ id: "us-west-2", label: "us-west-2", baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1" },
		],
		endpoint: CHAT,
		defaultModel: "openai.gpt-oss-120b-1:0",
		models: ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0"],
		keyHint: "Bedrock API Key（不支持 AK/SK 签名）",
		keyUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html",
		docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html",
		sources: ["https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html"],
		notes: ["只能用 Bedrock API Key（Bearer）；AWS SigV4 签名不支持。"],
	},
	{
		id: "ollama",
		service: "text",
		provider: "openai",
		group: "local",
		name: "Ollama",
		mark: "Ol",
		logo: "ollama",
		tagline: "本机模型",
		regions: [{ id: "local", label: "本机", baseUrl: "http://localhost:11434/v1" }],
		endpoint: CHAT,
		defaultModel: "",
		models: [],
		modelLabel: "模型（ollama list 里的名字）",
		keyHint: "不校验，任意填写即可（如 ollama）",
		keyOptional: true,
		docsUrl: "https://docs.ollama.com/api/openai-compatibility",
		sources: ["https://docs.ollama.com/api/openai-compatibility"],
		notes: ["localhost 指运行 openOii 后端的机器；本地地址需先保存再测试连接。"],
	},
	{
		id: "lmstudio",
		service: "text",
		provider: "openai",
		group: "local",
		name: "LM Studio",
		mark: "LM",
		logo: "lmstudio",
		tagline: "本机模型",
		regions: [{ id: "local", label: "本机", baseUrl: "http://localhost:1234/v1" }],
		endpoint: CHAT,
		defaultModel: "",
		models: [],
		modelLabel: "模型（LM Studio 里已加载的模型 ID）",
		keyHint: "默认不需要；开启鉴权后填 LM Studio 的 Token",
		keyOptional: true,
		docsUrl: "https://lmstudio.ai/docs/developer/openai-compat",
		sources: ["https://lmstudio.ai/docs/developer/openai-compat"],
		notes: ["localhost 指运行 openOii 后端的机器；本地地址需先保存再测试连接。"],
	},
	{
		id: "custom-openai",
		service: "text",
		provider: "openai",
		group: "local",
		name: "自定义 · OpenAI 兼容",
		mark: "…",
		tagline: "填地址、密钥和模型",
		regions: [],
		endpoint: CHAT,
		defaultModel: "",
		models: [],
		keyHint: "按服务要求填写",
		sources: [],
		custom: true,
	},
	{
		id: "fake-text",
		service: "text",
		provider: "fake",
		group: "local",
		name: "测试模式（Fake）",
		mark: "F",
		tagline: "不调用外部 API",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "",
		keyOptional: true,
		sources: [],
	},
];

const IMAGE_PRESETS: ProviderPreset[] = [
	{
		id: "seedream",
		service: "image",
		provider: "openai",
		group: "domestic",
		name: "火山方舟 Seedream",
		mark: "方",
		logo: "doubao",
		tagline: "豆包图像生成",
		regions: [{ id: "cn-beijing", label: "北京", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }],
		endpoint: "/images/generations",
		defaultModel: "doubao-seedream-4-0-250828",
		models: ["doubao-seedream-4-0-250828", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915"],
		keyHint: "方舟 API Key（ARK_API_KEY）",
		keyUrl: "https://ark.volcengine.com/region:cn-beijing/apikey",
		docsUrl: "https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api",
		sources: ["https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api"],
		notes: [
			"openOii 固定请求 1024×1024：5.0 lite 最低 2K，不在推荐列表里。",
			"Seedream 默认加水印，openOii 目前不传 watermark 参数。",
		],
	},
	{
		id: "cogview",
		service: "image",
		provider: "openai",
		group: "domestic",
		name: "智谱 CogView",
		mark: "智",
		logo: "zhipu",
		tagline: "CogView-4",
		regions: [{ id: "cn", label: "国内", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }],
		endpoint: "/images/generations",
		defaultModel: "cogview-4-250304",
		models: ["cogview-4-250304", "cogview-4"],
		keyHint: "智谱 API Key",
		keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
		docsUrl: "https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-4",
		sources: ["https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-4"],
	},
	{
		id: "modelscope",
		service: "image",
		provider: "modelscope",
		group: "domestic",
		name: "ModelScope 魔搭",
		mark: "魔",
		logo: "modelscope",
		tagline: "异步出图 · 免费额度",
		regions: [{ id: "cn", label: "国内", baseUrl: "https://api-inference.modelscope.cn" }],
		endpoint: "/v1/images/generations",
		defaultModel: "Tongyi-MAI/Z-Image-Turbo",
		models: ["Tongyi-MAI/Z-Image-Turbo", "Qwen/Qwen-Image"],
		keyHint: "ModelScope 访问令牌（ms- 开头）",
		keyUrl: "https://modelscope.cn/my/myaccesstoken",
		docsUrl: "https://modelscope.cn/docs/model-service/API-Inference/intro",
		sources: ["https://modelscope.cn/docs/model-service/API-Inference/intro"],
		notes: ["异步任务：提交后轮询 /v1/tasks/{id}，引擎和后端都已支持。"],
	},
	{
		id: "openai-image",
		service: "image",
		provider: "openai",
		group: "global",
		name: "OpenAI 图像",
		mark: "OA",
		logo: "openai",
		tagline: "gpt-image 2.5",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.openai.com/v1" }],
		endpoint: "/images/generations",
		defaultModel: "gpt-image-2.5-flare",
		models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.openai.com/api-keys",
		docsUrl: "https://developers.openai.com/api/docs/guides/image-generation",
		sources: ["https://developers.openai.com/api/docs/guides/image-generation"],
	},
	{
		id: "custom-image",
		service: "image",
		provider: "openai",
		group: "local",
		name: "自定义 · OpenAI 兼容",
		mark: "…",
		tagline: "填地址、密钥和模型",
		regions: [],
		endpoint: "/images/generations",
		defaultModel: "",
		models: [],
		keyHint: "按服务要求填写",
		sources: [],
		custom: true,
	},
	{
		id: "fake-image",
		service: "image",
		provider: "fake",
		group: "local",
		name: "测试模式（Fake）",
		mark: "F",
		tagline: "返回占位图",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "",
		keyOptional: true,
		sources: [],
	},
];

const VIDEO_PRESETS: ProviderPreset[] = [
	{
		id: "seedance",
		service: "video",
		provider: "doubao",
		group: "domestic",
		name: "火山方舟 Seedance",
		mark: "方",
		logo: "doubao",
		tagline: "豆包视频生成",
		regions: [],
		defaultModel: "doubao-seedance-2-5-260628",
		models: ["doubao-seedance-2-5-260628", "doubao-seedance-1-5-pro-251215"],
		keyHint: "方舟 API Key（ARK_API_KEY）",
		keyUrl: "https://ark.volcengine.com/region:cn-beijing/apikey",
		docsUrl: "https://ark.volcengine.com/region:cn-beijing/docs/list-video-generation-tasks-api",
		sources: [
			"https://ark.volcengine.com/region:cn-beijing/docs/list-video-generation-tasks-api",
			"https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api",
		],
		notes: ["固定使用北京地域；时长和画幅在高级设置里调整。"],
	},
	{
		id: "xai-video",
		service: "video",
		provider: "openai",
		group: "global",
		name: "xAI Grok Imagine",
		mark: "X",
		logo: "xai",
		tagline: "文生视频",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.x.ai/v1" }],
		endpoint: "/videos/generations",
		defaultModel: "grok-imagine-video-1.5",
		models: ["grok-imagine-video-1.5", "grok-imagine-video-1.5-lite"],
		keyHint: "xai- 开头",
		keyUrl: "https://console.x.ai/",
		docsUrl: "https://docs.x.ai/developers/model-capabilities/video/generation",
		sources: [
			"https://docs.x.ai/developers/model-capabilities/video/generation",
			"https://docs.x.ai/developers/rest-api-reference/inference/videos",
		],
		experimental: true,
		notes: [
			"返回 request_id 后轮询 /v1/videos/{id}，与 openOii 的异步任务流程一致。",
			"xAI 的图生视频参数叫 image，openOii 发送的是 image_url：目前按文生视频使用。",
		],
	},
	{
		id: "kling",
		service: "video",
		provider: "kling",
		group: "domestic",
		name: "可灵 Kling",
		mark: "可",
		logo: "kling",
		tagline: "文生 / 图生视频",
		regions: [
			{ id: "cn", label: "北京", baseUrl: "https://api-beijing.klingai.com" },
			{ id: "intl", label: "新加坡", baseUrl: "https://api-singapore.klingai.com" },
		],
		defaultModel: "kling-3.0",
		models: ["kling-4.0", "kling-3.0", "kling-3.0-turbo", "kling-2.6", "kling-2.5-turbo"],
		keyHint: "API Key（不支持旧版 AK/SK）",
		keyUrl: "https://app.klingai.com/cn/dev/console",
		docsUrl: "https://kling.ai/document-api/api/video/3-0-omni/text-to-video",
		sources: [
			"https://kling.ai/document-api/api/video/4-0/text-to-video",
			"https://kling.ai/document-api/api/video/3-0-omni/text-to-video",
			"https://kling.ai/document-api/api/video/2-6/text-to-video",
		],
		notes: ["时长：4.0 为 3–30 秒，3.0 为 3–15 秒，更早的为 5 或 10 秒。"],
	},
	{
		id: "vidu",
		service: "video",
		provider: "vidu",
		group: "domestic",
		name: "Vidu",
		mark: "V",
		logo: "vidu",
		tagline: "生数科技 · 文生 / 图生视频",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.vidu.cn" },
			{ id: "intl", label: "海外", baseUrl: "https://api.vidu.com" },
		],
		defaultModel: "viduq3-turbo",
		models: ["viduq3-turbo", "viduq3-pro"],
		keyHint: "API Key",
		keyUrl: "https://platform.vidu.cn/api-keys",
		docsUrl: "https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video",
		sources: ["https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video"],
		notes: ["Q3 时长 1–16 秒；图生视频跟随首帧画幅。"],
	},
	{
		id: "zhipu-video",
		service: "video",
		provider: "zhipu",
		group: "domestic",
		name: "智谱 CogVideoX",
		mark: "智",
		logo: "zhipu",
		tagline: "文生 / 图生视频",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
			{ id: "intl", label: "Z.ai", baseUrl: "https://api.z.ai/api/paas/v4" },
		],
		defaultModel: "cogvideox-3",
		models: ["cogvideox-3", "cogvideox-flash"],
		keyHint: "API Key",
		keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
		docsUrl: "https://docs.bigmodel.cn/cn/guide/models/video-generation/cogvideox-3",
		sources: ["https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E8%A7%86%E9%A2%91%E7%94%9F%E6%88%90%E5%BC%82%E6%AD%A5"],
		notes: ["时长 5 或 10 秒；提示词最多 512 字。"],
	},
	{
		id: "minimax-video",
		service: "video",
		provider: "minimax",
		group: "domestic",
		name: "MiniMax 海螺",
		mark: "海",
		logo: "hailuo",
		tagline: "Hailuo 文生 / 图生视频",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.minimaxi.com/v1" },
			{ id: "intl", label: "海外", baseUrl: "https://api.minimax.io/v1" },
		],
		defaultModel: "MiniMax-Hailuo-2.3",
		models: ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"],
		keyHint: "API Key（国内 / 海外分开）",
		keyUrl: "https://platform.minimaxi.com/",
		docsUrl: "https://platform.minimax.io/docs/api-reference/video-generation-t2v",
		sources: [
			"https://platform.minimax.io/docs/api-reference/video-generation-t2v",
			"https://platform.minimax.io/docs/api-reference/video-generation-query",
		],
		notes: ["时长 6 或 10 秒（768P）；不支持选画幅。"],
	},
	{
		id: "wan",
		service: "video",
		provider: "dashscope",
		group: "domestic",
		name: "通义万相",
		mark: "万",
		logo: "bailian",
		tagline: "阿里云百炼 · Wan 视频",
		regions: [
			{ id: "cn-beijing", label: "北京", baseUrl: "https://dashscope.aliyuncs.com/api/v1" },
			{ id: "ap-southeast-1", label: "新加坡", baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1" },
			{ id: "ws-cn-beijing", label: "北京 · 专属域名", baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1" },
		],
		defaultModel: "wan2.7-t2v",
		models: ["wan2.7-t2v", "wan2.6-t2v", "wan2.5-t2v-preview"],
		keyHint: "百炼 API Key（按地域区分）",
		keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/text-to-video-api-reference",
		sources: [
			"https://help.aliyun.com/zh/model-studio/text-to-video-api-reference",
			"https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference",
		],
		fields: [
			{
				id: "workspaceId",
				label: "业务空间 ID",
				placeholder: "llm-xxxxxxxx",
				help: "百炼控制台 → 业务空间详情；只有专属域名需要。",
				pattern: "[A-Za-z0-9-]+",
			},
		],
		notes: ["图生视频自动换成对应的 -i2v 模型；wan2.6 及以上时长 2–15 秒。"],
	},
	{
		id: "veo",
		service: "video",
		provider: "veo",
		group: "global",
		name: "Google Veo",
		mark: "G",
		logo: "deepmind",
		tagline: "Vertex AI · Veo 3.1",
		regions: [
			{ id: "express", label: "Express 模式", baseUrl: "https://aiplatform.googleapis.com/v1" },
			{
				id: "project",
				label: "项目 · us-central1",
				baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/{projectId}/locations/us-central1",
			},
		],
		defaultModel: "veo-3.1-fast-generate-001",
		models: ["veo-3.1-fast-generate-001", "veo-3.1-generate-001", "veo-3.1-lite-generate-001"],
		keyHint: "API Key，或 ya29. 开头的访问令牌",
		keyUrl: "https://console.cloud.google.com/vertex-ai",
		docsUrl: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text",
		sources: [
			"https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text",
			"https://ai.google.dev/gemini-api/docs/deprecations",
		],
		fields: [{ id: "projectId", label: "项目 ID", placeholder: "my-project", help: "Google Cloud 项目 ID", pattern: "[a-z0-9-]+" }],
		experimental: true,
		notes: ["Gemini API 里的 Veo 已下线，这里走 Vertex AI。", "时长 4 / 6 / 8 秒，画幅 16:9 或 9:16。"],
	},
	{
		id: "custom-video",
		service: "video",
		provider: "openai",
		group: "local",
		name: "自定义 · OpenAI 兼容",
		mark: "…",
		tagline: "填地址、密钥和模型",
		regions: [],
		endpoint: "/videos/generations",
		defaultModel: "",
		models: [],
		keyHint: "按服务要求填写",
		sources: [],
		custom: true,
	},
	{
		id: "fake-video",
		service: "video",
		provider: "fake",
		group: "local",
		name: "测试模式（Fake）",
		mark: "F",
		tagline: "使用本地视频素材",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "",
		keyOptional: true,
		sources: [],
	},
];

/** 视觉审查：OpenAI 兼容 chat/completions，图片作为 image_url 内容传入 */
const VISION_PRESETS: ProviderPreset[] = [
	{
		id: "qwen-vl",
		service: "vision",
		provider: "openai",
		group: "domestic",
		name: "通义千问 VL",
		mark: "百",
		logo: "bailian",
		tagline: "阿里云百炼 · Qwen3-VL",
		regions: [
			{ id: "cn-beijing", label: "北京", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
			{ id: "ap-southeast-1", label: "新加坡", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
			{
				id: "ws-cn-beijing",
				label: "北京 · 专属域名",
				baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			},
			{
				id: "ws-us-east-1",
				label: "美国（弗吉尼亚）",
				baseUrl: "https://{workspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
			},
		],
		defaultModel: "qwen3-vl-plus",
		models: ["qwen3-vl-plus"],
		keyHint: "sk- 开头；密钥绑定地域",
		keyUrl: "https://help.aliyun.com/zh/model-studio/get-api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai",
		sources: [
			"https://help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai",
			"https://docs.bailian.console.aliyun.com/zh/model-studio/model-list-visual-understanding",
		],
		fields: [
			{
				id: "workspaceId",
				label: "业务空间 ID",
				placeholder: "llm-xxxxxxxx",
				help: "百炼控制台 → 业务空间详情；只有专属域名需要。",
				pattern: "[A-Za-z0-9-]+",
			},
		],
	},
	{
		id: "glm-v",
		service: "vision",
		provider: "openai",
		group: "domestic",
		name: "智谱 GLM-V",
		mark: "智",
		logo: "zhipu",
		tagline: "GLM-4.6V，有免费 Flash 版",
		regions: [{ id: "default", label: "官方", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }],
		defaultModel: "glm-4.6v-flash",
		models: ["glm-4.6v-flash", "glm-4.6v", "glm-5v-turbo"],
		keyHint: "智谱开放平台 API Key",
		keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
		docsUrl: "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v",
		sources: [
			"https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v",
			"https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash",
		],
		notes: ["glm-4.6v-flash 免费，适合审查这种短输出任务。"],
	},
	{
		id: "openai-vision",
		service: "vision",
		provider: "openai",
		group: "global",
		name: "OpenAI",
		mark: "AI",
		logo: "openai",
		tagline: "GPT 多模态模型",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.openai.com/v1" }],
		defaultModel: "gpt-6-astra",
		models: ["gpt-6-astra", "gpt-6.1-terra"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.openai.com/api-keys",
		docsUrl: "https://developers.openai.com/api/docs/guides/images-vision",
		sources: ["https://developers.openai.com/api/docs/guides/images-vision"],
	},
	{
		id: "gemini-vision",
		service: "vision",
		provider: "openai",
		group: "global",
		name: "Google Gemini",
		mark: "G",
		logo: "gemini",
		tagline: "OpenAI 兼容接口",
		regions: [{ id: "default", label: "官方", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }],
		defaultModel: "gemini-3.8-flash",
		models: ["gemini-3.8-flash"],
		keyHint: "AI Studio API Key",
		keyUrl: "https://aistudio.google.com/apikey",
		docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
		sources: ["https://ai.google.dev/gemini-api/docs/openai"],
	},
	{
		id: "llamacpp-vision",
		service: "vision",
		provider: "openai",
		group: "local",
		name: "Qwen3-VL 本地",
		mark: "L",
		logo: "qwen",
		tagline: "llama.cpp 跑 GGUF + mmproj",
		regions: [{ id: "local", label: "本机", baseUrl: "http://127.0.0.1:{port}/v1" }],
		defaultModel: "local-vision",
		models: [],
		modelLabel: "模型（llama-server 的 --alias）",
		keyHint: "默认不需要；用了 --api-key 才填",
		keyOptional: true,
		docsUrl: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md",
		sources: [
			"https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md",
			"https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md",
		],
		fields: [
			{
				id: "port",
				label: "端口",
				placeholder: "8080",
				help: "llama-server 的 --port；本地地址需先保存再测试连接。",
				pattern: "[0-9]+",
			},
		],
		notes: ["内存吃紧时加 -np 1 --cache-ram 0，并限制 --image-max-tokens；服务挂掉时分镜会标为「未检查」。"],
	},
	{
		id: "custom-vision",
		service: "vision",
		provider: "openai",
		group: "local",
		name: "自定义 · OpenAI 兼容",
		mark: "…",
		tagline: "任意支持图片输入的兼容服务",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "按服务要求填写",
		sources: [],
		custom: true,
	},
];


/** 配音（TTS）：每家都是原生接口，请求形状见 backend/app/services/tts_providers.py */
const TTS_PRESETS: ProviderPreset[] = [
	{
		id: "doubao-tts",
		service: "tts",
		provider: "doubao",
		group: "domestic",
		name: "豆包语音",
		mark: "豆",
		logo: "volcengine",
		tagline: "火山引擎 · 豆包语音合成 2.0",
		regions: [{ id: "default", label: "官方", baseUrl: "https://openspeech.bytedance.com/api/v3" }],
		defaultModel: "seed-tts-2.0",
		models: ["seed-tts-2.0", "seed-tts-1.0"],
		modelLabel: "资源 ID（X-Api-Resource-Id）",
		defaultVoice: "zh_female_vv_uranus_bigtts",
		voices: ["zh_female_vv_uranus_bigtts"],
		keyHint: "豆包语音控制台的 API Key（新版控制台）",
		keyUrl: "https://console.volcengine.com/speech/new",
		docsUrl: "https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh",
		sources: ["https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh"],
		notes: ["没有只读的查询接口，「测试连接」只能检查是否填了密钥；音色要和资源 ID 匹配。"],
	},
	{
		id: "cosyvoice",
		service: "tts",
		provider: "cosyvoice",
		group: "domestic",
		name: "阿里 CosyVoice",
		mark: "百",
		logo: "bailian",
		tagline: "阿里云百炼 · 非实时语音合成",
		regions: [
			{ id: "cn-beijing", label: "北京", baseUrl: "https://dashscope.aliyuncs.com/api/v1" },
			{
				id: "ws-cn-beijing",
				label: "北京 · 专属域名",
				baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
			},
		],
		defaultModel: "cosyvoice-v3-flash",
		models: ["cosyvoice-v3-flash", "cosyvoice-v3-plus", "cosyvoice-v3.5-flash", "cosyvoice-v3.5-plus"],
		defaultVoice: "longanyang",
		voices: ["longanyang"],
		keyHint: "sk- 开头；密钥绑定地域",
		keyUrl: "https://help.aliyun.com/zh/model-studio/get-api-key",
		docsUrl: "https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api",
		sources: [
			"https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api",
			"https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide",
		],
		fields: [
			{
				id: "workspaceId",
				label: "业务空间 ID",
				placeholder: "llm-xxxxxxxx",
				help: "百炼控制台 → 业务空间详情；只有专属域名需要。",
				pattern: "[A-Za-z0-9-]+",
			},
		],
		notes: ["音色要和模型版本对应，完整列表见官方「CosyVoice 音色列表」。"],
	},
	{
		id: "minimax-tts",
		service: "tts",
		provider: "minimax",
		group: "domestic",
		name: "MiniMax 语音",
		mark: "M",
		logo: "minimax",
		tagline: "speech-2.8 同步语音合成",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.minimaxi.com/v1" },
			{ id: "global", label: "海外", baseUrl: "https://api.minimax.io/v1" },
		],
		defaultModel: "speech-2.8-hd",
		models: ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd"],
		defaultVoice: "Chinese (Mandarin)_Lyrical_Voice",
		voices: ["Chinese (Mandarin)_Lyrical_Voice", "Chinese (Mandarin)_News_Anchor", "Chinese (Mandarin)_Gentle_Youth", "Chinese (Mandarin)_Cute_Spirit"],
		keyHint: "国内和海外的密钥不通用",
		keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		docsUrl: "https://platform.minimaxi.com/docs/api-reference/speech-t2a-http",
		sources: [
			"https://platform.minimaxi.com/docs/api-reference/speech-t2a-http",
			"https://platform.minimaxi.com/docs/faq/system-voice-id",
		],
	},
	{
		id: "edge-tts",
		service: "tts",
		provider: "edge",
		group: "global",
		name: "Edge 免费配音",
		mark: "E",
		logo: "microsoft",
		tagline: "默认 · 无需密钥",
		regions: [],
		defaultModel: "",
		models: [],
		defaultVoice: "zh-CN-XiaoxiaoNeural",
		voices: [
			"zh-CN-XiaoxiaoNeural",
			"zh-CN-XiaoyiNeural",
			"zh-CN-YunxiNeural",
			"zh-CN-YunjianNeural",
			"zh-CN-YunxiaNeural",
			"zh-CN-YunyangNeural",
		],
		keyHint: "",
		keyOptional: true,
		docsUrl: "https://github.com/rany2/edge-tts",
		sources: ["https://github.com/rany2/edge-tts"],
		notes: ["用的是浏览器朗读的公开接口，没有服务保障；角色没指定音色时按描述自动挑男女老少。"],
	},
	{
		id: "openai-tts",
		service: "tts",
		provider: "openai",
		group: "global",
		name: "OpenAI",
		mark: "AI",
		logo: "openai",
		tagline: "Speech API · /audio/speech",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.openai.com/v1" }],
		defaultModel: "gpt-4o-mini-tts",
		models: ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"],
		defaultVoice: "marin",
		voices: ["marin", "cedar", "coral", "nova", "onyx"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.openai.com/api-keys",
		docsUrl: "https://developers.openai.com/api/docs/guides/text-to-speech",
		sources: ["https://developers.openai.com/api/docs/guides/text-to-speech"],
		notes: ["官方说明这几个 TTS 模型将于 2027-01-06 停用；音色主要为英文优化。"],
	},
	{
		id: "elevenlabs",
		service: "tts",
		provider: "elevenlabs",
		group: "global",
		name: "ElevenLabs",
		mark: "11",
		logo: "elevenlabs",
		tagline: "多语言语音，音色库丰富",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.elevenlabs.io/v1" }],
		defaultModel: "eleven_multilingual_v2",
		models: ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5"],
		defaultVoice: "JBFqnCBsd6RMkjVDRZzb",
		voices: ["JBFqnCBsd6RMkjVDRZzb"],
		keyHint: "xi-api-key",
		keyUrl: "https://elevenlabs.io/app/settings/api-keys",
		docsUrl: "https://elevenlabs.io/docs/api-reference/text-to-speech/convert",
		sources: ["https://elevenlabs.io/docs/api-reference/text-to-speech/convert"],
		notes: ["音色填 voice_id（在音色库里复制），不是音色名字。"],
	},
	{
		id: "azure-tts",
		service: "tts",
		provider: "azure",
		group: "global",
		name: "Azure 语音",
		mark: "Az",
		logo: "azure",
		tagline: "神经网络语音 · REST",
		regions: [{ id: "region", label: "按资源地域", baseUrl: "https://{region}.tts.speech.microsoft.com" }],
		defaultModel: "",
		models: [],
		defaultVoice: "zh-CN-XiaoxiaoNeural",
		voices: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-YunjianNeural", "zh-CN-XiaoyiNeural"],
		keyHint: "语音资源的密钥（Ocp-Apim-Subscription-Key）",
		keyUrl: "https://portal.azure.com/",
		docsUrl: "https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech",
		sources: ["https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech"],
		fields: [
			{
				id: "region",
				label: "资源地域",
				placeholder: "eastasia",
				help: "语音资源所在地域，如 eastasia、eastus。",
				pattern: "[a-z0-9]+",
			},
		],
	},
	{
		id: "custom-tts",
		service: "tts",
		provider: "openai",
		group: "local",
		name: "自定义 · OpenAI 兼容",
		mark: "…",
		tagline: "任意兼容 /audio/speech 的服务",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "按服务要求填写",
		sources: [],
		custom: true,
	},
];

/** 背景音乐（BGM）：请求形状见 backend/app/services/bgm_providers.py */
const BGM_PRESETS: ProviderPreset[] = [
	{
		id: "minimax-music",
		service: "bgm",
		provider: "minimax",
		group: "domestic",
		name: "MiniMax 音乐",
		mark: "M",
		logo: "minimax",
		tagline: "纯音乐生成",
		regions: [
			{ id: "cn", label: "国内", baseUrl: "https://api.minimaxi.com/v1" },
			{ id: "global", label: "海外", baseUrl: "https://api.minimax.io/v1" },
		],
		defaultModel: "music-2.6",
		models: ["music-2.6", "music-3.0"],
		keyHint: "MiniMax 开放平台 API Key；国内和海外的密钥不通用",
		keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		docsUrl: "https://platform.minimaxi.com/docs/api-reference/music-generation",
		sources: ["https://platform.minimaxi.com/docs/api-reference/music-generation"],
		notes: ["2026-08-20 起不再对新用户开放"],
	},
	{
		id: "stable-audio",
		service: "bgm",
		provider: "stability",
		group: "global",
		name: "Stable Audio",
		mark: "SA",
		logo: "stability",
		tagline: "Stability AI",
		regions: [{ id: "default", label: "官方", baseUrl: "https://api.stability.ai" }],
		defaultModel: "stable-audio-2.5",
		models: ["stable-audio-2.5", "stable-audio-2"],
		keyHint: "sk- 开头",
		keyUrl: "https://platform.stability.ai/account/keys",
		docsUrl: "https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio",
		sources: ["https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio"],
		notes: ["最长 190 秒"],
	},
	{
		id: "bgm-library",
		service: "bgm",
		provider: "library",
		group: "local",
		name: "内置曲库",
		mark: "♪",
		logo: "library",
		tagline: "默认 · 免费",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "",
		keyOptional: true,
		sources: [],
		notes: ["本机合成，按剧情情绪挑选"],
	},
	{
		id: "custom-bgm",
		service: "bgm",
		provider: "suno",
		group: "local",
		name: "自定义 · Suno 兼容",
		mark: "…",
		logo: "suno",
		tagline: "自建网关",
		regions: [],
		defaultModel: "",
		models: [],
		keyHint: "可留空",
		keyOptional: true,
		docsUrl: "https://github.com/gcui-art/suno-api",
		sources: ["https://github.com/gcui-art/suno-api"],
		notes: ["Suno 没有公开的官方 API"],
		custom: true,
	},
];

export const PROVIDER_PRESETS: Record<PresetService, ProviderPreset[]> = {
	text: TEXT_PRESETS,
	image: IMAGE_PRESETS,
	video: VIDEO_PRESETS,
	vision: VISION_PRESETS,
	tts: TTS_PRESETS,
	bgm: BGM_PRESETS,
};

/** 每个服务的接口协议键和后端默认值 */
const SERVICE_PROVIDER: Record<PresetService, { key?: string; fallback: string }> = {
	text: { key: "TEXT_PROVIDER", fallback: "anthropic" },
	image: { key: "IMAGE_PROVIDER", fallback: "modelscope" },
	video: { key: "VIDEO_PROVIDER", fallback: "openai" },
	vision: { fallback: "openai" },
	tts: { key: "TTS_PROVIDER", fallback: "edge" },
	bgm: { key: "BGM_PROVIDER", fallback: "library" },
};

export function isPresetService(tab: string): tab is PresetService {
	return tab in SERVICE_PROVIDER;
}

/** 配置里的 provider；没填时按后端默认值（文本 anthropic、图像 modelscope、视频 openai） */
export function formProvider(service: PresetService, form: Record<string, unknown>): string {
	const { key, fallback } = SERVICE_PROVIDER[service];
	if (!key) return fallback;
	return (String(form[key] ?? form[key.toLowerCase()] ?? "") || fallback).toLowerCase();
}

/** 每个服务只有一个通用自定义入口 */
export function customPreset(service: PresetService): ProviderPreset {
	return PROVIDER_PRESETS[service].find((p) => p.custom)!;
}

/** 测试模式（Fake）：不作为服务商卡片，单独一个小选项 */
export function isTestMode(preset: ProviderPreset) {
	return preset.provider === "fake";
}

/**
 * 自定义预设沿用当前的接口协议：例如老配置 TEXT_PROVIDER=anthropic + 中转地址，
 * 自定义入口显示和编辑的是 ANTHROPIC_* 键。
 */
export function effectiveKeys(preset: ProviderPreset, form: Record<string, unknown>): PresetKeys {
	if (!preset.custom || preset.service === "bgm") return presetKeys(preset);
	const current = formProvider(preset.service, form);
	if (current === "fake") return presetKeys(preset);
	return presetKeys({ ...preset, provider: current as PresetProvider });
}

export function presetById(service: PresetService, id: string) {
	return PROVIDER_PRESETS[service].find((p) => p.id === id);
}

/** 预设写入哪些配置项（大写键名） */
export interface PresetKeys {
	/** 视觉审查只有一种接口协议，没有这个键 */
	provider?: string;
	baseUrl?: string;
	endpoint?: string;
	model?: string;
	apiKey?: string;
	/** 配音的默认音色 */
	voice?: string;
}

export function presetKeys(preset: ProviderPreset): PresetKeys {
	if (preset.service === "tts") {
		const voice = "TTS_DEFAULT_VOICE";
		if (preset.provider === "edge") return { provider: "TTS_PROVIDER", voice };
		if (preset.provider === "azure") return { provider: "TTS_PROVIDER", baseUrl: "TTS_BASE_URL", apiKey: "TTS_API_KEY", voice };
		return { provider: "TTS_PROVIDER", baseUrl: "TTS_BASE_URL", model: "TTS_MODEL", apiKey: "TTS_API_KEY", voice };
	}
	if (preset.service === "bgm") {
		if (preset.provider === "library") return { provider: "BGM_PROVIDER" };
		if (preset.provider === "suno") return { provider: "BGM_PROVIDER", baseUrl: "BGM_BASE_URL", apiKey: "BGM_API_KEY" };
		return { provider: "BGM_PROVIDER", baseUrl: "BGM_BASE_URL", model: "BGM_MODEL", apiKey: "BGM_API_KEY" };
	}
	if (preset.service === "vision") {
		return {
			baseUrl: "CRITIQUE_VISION_BASE_URL",
			model: "CRITIQUE_VISION_MODEL",
			apiKey: "CRITIQUE_VISION_API_KEY",
		};
	}
	if (preset.service === "text") {
		if (preset.provider === "anthropic") {
			return { provider: "TEXT_PROVIDER", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL", apiKey: "ANTHROPIC_AUTH_TOKEN" };
		}
		if (preset.provider === "fake") return { provider: "TEXT_PROVIDER" };
		return { provider: "TEXT_PROVIDER", baseUrl: "TEXT_BASE_URL", endpoint: "TEXT_ENDPOINT", model: "TEXT_MODEL", apiKey: "TEXT_API_KEY" };
	}
	if (preset.service === "image") {
		if (preset.provider === "fake") return { provider: "IMAGE_PROVIDER" };
		return { provider: "IMAGE_PROVIDER", baseUrl: "IMAGE_BASE_URL", endpoint: "IMAGE_ENDPOINT", model: "IMAGE_MODEL", apiKey: "IMAGE_API_KEY" };
	}
	if (preset.provider === "fake") return { provider: "VIDEO_PROVIDER" };
	if (preset.provider === "doubao") return { provider: "VIDEO_PROVIDER", model: "DOUBAO_VIDEO_MODEL", apiKey: "DOUBAO_API_KEY" };
	if (preset.provider !== "openai") return { provider: "VIDEO_PROVIDER", baseUrl: "VIDEO_BASE_URL", model: "VIDEO_MODEL", apiKey: "VIDEO_API_KEY" };
	return { provider: "VIDEO_PROVIDER", baseUrl: "VIDEO_BASE_URL", endpoint: "VIDEO_ENDPOINT", model: "VIDEO_MODEL", apiKey: "VIDEO_API_KEY" };
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function regionNeeds(region: PresetRegion | undefined): string[] {
	if (!region) return [];
	return Array.from(region.baseUrl.matchAll(PLACEHOLDER), (m) => m[1]!);
}

export function fillBaseUrl(region: PresetRegion, fields: Record<string, string>): string | null {
	let missing = false;
	const url = region.baseUrl.replace(PLACEHOLDER, (_, id: string) => {
		const value = (fields[id] ?? "").trim();
		if (!value) missing = true;
		return value;
	});
	return missing ? null : url;
}

export interface PresetSelection {
	regionId?: string;
	fields?: Record<string, string>;
	model?: string;
}

/**
 * 选中预设后要写入的配置值。不写密钥；自定义预设只切换 provider 类型，
 * 保留用户已有的地址和模型。地址里的占位字段没填时不写 Base URL。
 */
export function presetConfigValues(preset: ProviderPreset, selection: PresetSelection = {}): Record<string, string> {
	const keys = presetKeys(preset);
	const values: Record<string, string> = keys.provider ? { [keys.provider]: preset.provider } : {};
	if (preset.custom) return values;
	const region = preset.regions.find((r) => r.id === selection.regionId) ?? preset.regions[0];
	if (keys.baseUrl && region) {
		const url = fillBaseUrl(region, selection.fields ?? {});
		if (url) values[keys.baseUrl] = url;
	}
	if (keys.endpoint && preset.endpoint) values[keys.endpoint] = preset.endpoint;
	const model = selection.model ?? preset.defaultModel;
	if (keys.model && model) values[keys.model] = model;
	if (keys.voice && preset.defaultVoice) values[keys.voice] = preset.defaultVoice;
	return values;
}

function normalizeUrl(url: string) {
	return url.trim().replace(/\/+$/, "").toLowerCase();
}

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DetectedPreset {
	preset: ProviderPreset;
	regionId?: string;
	fields: Record<string, string>;
}

/** 根据现有配置反推正在用哪个预设；认不出的落到对应的自定义 / Fake 预设。 */
export function detectPreset(service: PresetService, form: Record<string, unknown>): DetectedPreset {
	const read = (key: string) => String(form[key] ?? form[key.toLowerCase()] ?? "");
	const provider = formProvider(service, form);
	const presets = PROVIDER_PRESETS[service].filter((p) => p.provider === provider);
	for (const preset of presets) {
		if (preset.custom) continue;
		const keys = presetKeys(preset);
		if (!keys.baseUrl) {
			// fake / doubao：只按 provider 类型识别
			return { preset, fields: {} };
		}
		const current = normalizeUrl(read(keys.baseUrl));
		if (!current) continue;
		for (const region of preset.regions) {
			const names = regionNeeds(region);
			const source = escapeRegExp(normalizeUrl(region.baseUrl)).replace(/\\\{(\w+)\\\}/g, "([a-z0-9-]+)");
			const match = new RegExp(`^${source}$`).exec(current);
			if (match) {
				const fields = Object.fromEntries(names.map((name, i) => [name, match[i + 1] ?? ""]));
				return { preset, regionId: region.id, fields };
			}
		}
	}
	// 认不出的一律落到唯一的通用自定义；接口协议（如 Anthropic 原生、中转）原样保留，只在高级设置里改
	if (provider === "fake") return { preset: PROVIDER_PRESETS[service].find((p) => p.provider === "fake")!, fields: {} };
	return { preset: customPreset(service), fields: {} };
}
