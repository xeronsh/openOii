// 配置项详细说明
export function getConfigDescription(key: string): string {
	const descriptions: Record<string, string> = {
		// 基础设置
		APP_NAME: "应用名称，用于日志和服务标识",
		ENVIRONMENT: "运行环境：dev（开发）/ staging（预发布）/ prod（生产）",
		LOG_LEVEL: "日志级别：DEBUG / INFO / WARNING / ERROR",
		API_V1_PREFIX: "API 路由前缀，默认 /api/v1",
		CORS_ORIGINS: '跨域配置，JSON 数组格式，如 ["http://localhost:3000"]',

		// 数据库
		DATABASE_URL: "SQLite 数据库连接字符串（需与 pi 引擎指向同一文件）",
		DB_ECHO: "是否在控制台打印 SQL 语句（调试用）",

		// LLM 服务
		ANTHROPIC_API_KEY: "Anthropic 官方 API 密钥",
		ANTHROPIC_AUTH_TOKEN: "中转站 Token（国内推荐使用）",
		ANTHROPIC_BASE_URL: "API 基础地址（官方或中转站地址）",
		ANTHROPIC_MODEL: "Claude 模型名称；原生接口目前只支持 4.x，如 claude-sonnet-4-5-20250929",

		// 文本生成服务
		TEXT_PROVIDER:
			"文本生成服务提供商：anthropic（Claude）/ openai（OpenAI 兼容）/ fake（本地测试，不调用外部 API）",
		TEXT_BASE_URL: "文本生成服务地址（OpenAI 兼容接口）",
		TEXT_API_KEY: "文本生成 API 密钥（OpenAI 兼容）",
		TEXT_MODEL: "文本生成模型名称（OpenAI 兼容），如 deepseek-flash、qwen3.8-max",
		TEXT_ENDPOINT: "文本生成 API 端点路径（OpenAI 兼容）",
		TEXT_ENABLE_THINKING:
			"是否向支持推理开关的文本模型显式传递 thinking 配置；留空表示由模型/服务默认决定。",
		TEXT_REASONING_EFFORT:
			"推理强度档位，支持 reasoning_effort 的 OpenAI 兼容模型可设为 low / medium / high。",

		// 图像服务
		IMAGE_PROVIDER:
			"图像生成服务提供商：modelscope（ModelScope 异步图片任务）/ openai（OpenAI 兼容）/ fake（本地测试，不调用外部 API）",
		IMAGE_BASE_URL:
			"图像生成服务地址；ModelScope 使用 https://api-inference.modelscope.cn，OpenAI 使用 https://api.openai.com/v1。选上面的服务商会自动填好",
		IMAGE_API_KEY: "图像生成 API 密钥",
		IMAGE_MODEL: "图像生成模型名称，如 gpt-image-2.5-flare、doubao-seedream-4-0-250828 或 Tongyi-MAI/Z-Image-Turbo",
		IMAGE_ENDPOINT:
			"图像生成接口路径，一般是 /images/generations（拼在 Base URL 后面）；ModelScope 使用 /v1/images/generations",
		ENABLE_IMAGE_TO_IMAGE: "是否启用图生图（I2I）功能",
		FAKE_IMAGE_FIXTURE_URL:
			"Fake 图像 Provider 固定返回的图片 URL（可选）；留空时使用后端内置本地 SVG 占位图，不调用外部图像 API。",
		CRITIQUE_ENABLED:
			"是否启用 Critic 质量审查闭环；开启后会审查角色图/分镜图，不达标时触发重生成。",
		CRITIQUE_SCORE_THRESHOLD:
			"Critic 质量分阈值（0-10）；低于该分数视为不达标并进入重生成逻辑。",
		CRITIQUE_MAX_ROUNDS:
			"Critic 最多重试轮数；达到上限后为避免卡死会继续后续流程。",
		CRITIQUE_VISION_BASE_URL:
			"能看图片的 OpenAI 兼容视觉模型地址；审查时带图片的请求走这里。不填或服务连不上时，分镜标为「未检查」，不会当作通过。",
		CRITIQUE_VISION_PROVIDER: "视觉审查走的接口协议；目前都是 OpenAI 兼容 chat/completions。",
		CRITIQUE_VISION_API_KEY: "审查视觉模型的 API 密钥（本地模型可留空）",
		CRITIQUE_VISION_MODEL: "审查视觉模型名称，需支持图片输入，如 qwen3-vl",
		OUTLINE_ENABLED:
			"是否启用故事大纲审批流程；开启后先生成大纲并等待确认，再继续角色和分镜规划。",

		// 视频服务
		VIDEO_PROVIDER:
			"视频服务提供商：openai（OpenAI 兼容）/ doubao（豆包）/ kling / vidu / zhipu / minimax / dashscope / veo（服务商原生接口）/ fake（本地测试）",
		VIDEO_BASE_URL: "视频生成服务的基础地址；选上面的服务商会自动填好",
		VIDEO_API_KEY: "视频生成 API 密钥",
		VIDEO_MODEL: "视频生成模型名称",
		VIDEO_ENDPOINT: "视频生成 API 端点路径",
		VIDEO_MODE: "视频生成模式：text（文生视频）或 image（图生视频）",
		VIDEO_RATIO: "画幅：16:9 / 9:16 / 1:1 / 4:3 / 3:4；服务商不支持时自动回落（MiniMax 与图生视频跟随首帧）",
		ENABLE_IMAGE_TO_VIDEO: "是否启用图生视频（I2V）功能",
		FAKE_VIDEO_FIXTURE_URL:
			"Fake 视频 Provider 固定返回的视频 URL；推荐使用 /static/videos/*.mp4，本地测试不调用外部视频 API。",
		FAKE_VIDEO_FIXTURE_PATH:
			"Fake 视频 Provider 本地素材文件路径；会复制到后端 static/videos 后返回本地 URL。",

		// 豆包视频
		DOUBAO_API_KEY: "豆包 API 密钥（火山引擎 ARK_API_KEY）",
		DOUBAO_VIDEO_MODEL: "Seedance 模型 ID，如 doubao-seedance-2-5-260628",
		DOUBAO_VIDEO_DURATION: "豆包视频时长（秒）：openOii 目前按 5 或 10 秒提交",
		DOUBAO_VIDEO_RATIO: "画幅比例：16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive（自适应）",
		DOUBAO_GENERATE_AUDIO: "豆包视频是否生成音频",
		VIDEO_IMAGE_MODE:
			"图生视频模式：first_frame（仅首帧）/ reference（拼接参考图）",
		VIDEO_INLINE_LOCAL_IMAGES: "未配置 PUBLIC_BASE_URL 时是否内联本地图片",

		// TTS / BGM
		TTS_ENABLED: "默认是否给台词配音；每个项目可以在属性面板里单独开关。",
		TTS_DEFAULT_VOICE:
			"角色没单独指定音色时用的音色，例如 zh-CN-XiaoxiaoNeural；云端服务商填它自己的音色名。",
		TTS_PROVIDER: "edge（免费）/ openai / doubao / cosyvoice / minimax / elevenlabs / azure，由上方预设选择。",
		TTS_BASE_URL: "云端配音的基础地址，选预设会自动填好。",
		TTS_API_KEY: "云端配音的密钥；Edge 免费配音不需要。",
		TTS_MODEL: "云端配音的模型（豆包填资源 ID）。",
		SUBTITLE_MODE: "默认字幕方式：off 不加、soft 软字幕（播放器里可关）、burn 烧进画面；每个项目可单独选。",
		SUBTITLE_FONT: "烧录字幕的字体名，默认 Smiley Sans（得意黑）；系统没装时自动换成其它中文字体。",
		BGM_ENABLED: "整部片一条背景音乐，项目里可单独开关。",
		BGM_PROVIDER: "library、minimax、stability、suno；云端失败时退回内置曲库。",
		BGM_BASE_URL: "音乐服务地址。",
		BGM_API_KEY: "内置曲库不需要。",
		BGM_MODEL: "如 music-2.6。",
		BGM_DUCKING: "台词处自动压低音乐。",
		BGM_VOLUME: "背景音乐音量，范围 0-1；数值越大 BGM 越响。",
		TTS_VOLUME: "TTS 人声音量，范围 0-1；数值越大对白越响。",
		BGM_DIRECTORY: "BGM 音频文件目录，相对于后端 app 目录。",

		// 思考链
		THINKING_CHAIN_ENABLED:
			"是否向前端推送 Agent 思考链/阶段说明；关闭可减少运行时消息噪音。",
		THINKING_CHAIN_DETAIL_LEVEL:
			"思考链详细级别：minimal 仅关键结论，normal 含审查阶段，verbose 展示更多规划/推理过程。",

		// 其他
		REQUEST_TIMEOUT_S: "HTTP 请求超时时间（秒）",
		PUBLIC_BASE_URL: "对外可访问的后端地址，用于生成完整 URL",
		ADMIN_TOKEN: "管理员 Token，用于配置更新权限验证",
	};

	return descriptions[key.toUpperCase()] || "暂无说明";
}
