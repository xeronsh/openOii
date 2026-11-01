# 模型服务商预设

设置页的「文本生成 / 图像服务 / 视频服务 / 视觉审查」页签顶部是服务商卡片。选一个预设，Base URL、接口路径和推荐模型会自动写进配置，只剩 API Key 需要自己填。地域和专属字段（如百炼业务空间 ID、Azure 资源名）在预设详情里单独填写，填完自动拼出地址。

- 预设数据：`frontend/app/components/settings/providerPresets.ts`，每个预设都带官方文档来源（`sources`），核对日期 **2026-10-30**（`PRESETS_VERIFIED_AT`）。
- 预设只是把值写进现有的配置键，后端和引擎没有新增 provider 类型。所有预设都落在已有的 `openai` / `anthropic` / `modelscope` / `doubao` / `fake` 五种类型上。
- 选预设**不会写入或清空密钥**。切换到另一家服务商后需要重新填写对应的 API Key。
- 「高级设置」保留所有原始字段（中文名为主，环境变量名作次要信息），可以逐项手动填写。手动改了地址后，卡片会自动回到「自定义」。
- 已有配置会按「provider 类型 + Base URL」反推回对应的预设。识别不出的（例如本机网关 `http://127.0.0.1:18790/v1`、Anthropic 中转站）一律显示为唯一的「自定义 · OpenAI 兼容」，接口协议和原值都不变，高级设置默认展开。
- 每个页签只有一个通用自定义入口：地址、密钥和模型在卡片下方就地填写，接口路径在高级设置里。其它接口协议（Anthropic 原生 Messages、ModelScope、豆包）只在「高级设置 → 接口协议」里切换，不再单独做卡片。Fake 改成卡片下方的小选项「测试模式（Fake）」。

## 测试连接

「测试连接」只发便宜的只读请求，超时 10 秒：

| 服务 | 请求 |
| --- | --- |
| 文本 | 沿用原来的一次极短文本请求（`probe_text_provider`） |
| 图像 / 视频（OpenAI 兼容、ModelScope） | `GET {API 根}/models`（Bearer）。返回 404/405 时提示「服务可达，但无法免费验证密钥」，不去生成图片或视频 |
| 视频（豆包 Seedance） | `GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_size=1` |
| 视频（可灵） | `GET {base}/account/costs`（账户资源包，只读） |
| 视频（Vidu） | `GET {base}/ent/v2/tasks?pager.pagesz=1`（任务列表，只读） |
| 视频（CogVideoX / 通义万相） | `GET` 一个不存在的任务 ID，只看鉴权：401/403 为密钥无效，404 或 UNKNOWN 视为已通过 |
| 视频（MiniMax） | `GET {base}/query/video_generation?task_id=<不存在>`，按 `base_resp.status_code`（1004 / 2049 为密钥无效） |
| 视频（Veo，实验性） | `POST {base}/publishers/google/models/{model}:fetchPredictOperation`（不存在的 operation），只看鉴权 |
| 视觉审查 | `GET {Base URL}/models`（Bearer，本地服务不带密钥时用占位值）；没填地址时直接提示「还没有配置视觉审查模型」 |
| 配音 | 见下面「配音」一节：每家各用一个只读接口，不合成语音、不扣费 |
| 背景音乐 | 见下面「背景音乐」一节：内置曲库直接成功；云端各用一个只读接口，不生成音乐 |
| Fake | 直接成功 |

错误统一翻译成中文：

| 情况 | 提示 |
| --- | --- |
| 401 | API Key 无效（密钥填错、过期，或与地域不匹配） |
| 403 | 没有权限 |
| 404 | 地址不存在（检查是否漏了 `/v1`） |
| 429 | 请求太频繁或额度不足 |
| 5xx | 服务端错误 |
| 超时 | 连接超时 |
| 连不上 | 无法连接 |

本机或内网地址（localhost、127.0.0.1、内网 IP）只能在**保存后**测试，用来防止 SSRF。已保存的地址可以直接测。


## 文本生成（写入 `TEXT_*`（Claude 原生为 `ANTHROPIC_*`））

| 分组 | 预设 | 类型 | 地址 | 接口路径 | 推荐模型 | 特殊配置 / 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 国内 | [DeepSeek](https://api-docs.deepseek.com/) | `openai` | 官方：`https://api.deepseek.com` | `/chat/completions` | `deepseek-flash`, `deepseek-v4-pro` | deepseek-chat / deepseek-reasoner 已于 2026-07-24 下线。 |
| 国内 | [阿里云百炼](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) | `openai` | 北京：`https://dashscope.aliyuncs.com/compatible-mode/v1`<br>新加坡：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`<br>北京 · 专属域名：`https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`<br>美国（弗吉尼亚）：`https://{workspaceId}.us-east-1.maas.aliyuncs.com/compatible-mode/v1`<br>日本（东京）：`https://{workspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` | `/chat/completions` | `qwen3.8-max`, `qwen3.7-plus` | 需要填写：workspaceId；地域和密钥不匹配时会返回 401 invalid_api_key。 |
| 国内 | [智谱 BigModel](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) | `openai` | 国内：`https://open.bigmodel.cn/api/paas/v4` | `/chat/completions` | `glm-5.3`, `glm-5.2`, `glm-5.3-flash` | temperature 取值 (0, 1)。 |
| 国内 | [Kimi（月之暗面）](https://platform.kimi.com/docs/api/overview) | `openai` | 国内：`https://api.moonshot.cn/v1`<br>海外：`https://api.moonshot.ai/v1` | `/chat/completions` | `kimi-k3` | K3 的推理强度对应高级设置里的「推理强度」：low / high 可用，max 引擎暂不支持。 |
| 国内 | [MiniMax](https://platform.minimax.io/docs/api-reference/text-openai-api) | `openai` | 国内：`https://api.minimaxi.com/v1`<br>海外：`https://api.minimax.io/v1` | `/chat/completions` | `MiniMax-M3`, `MiniMax-M3.1-Flash` | MiniMax-M2.5 / M2.7 将于 2026-11-18 下线。 |
| 国内 | [火山方舟](https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk) | `openai` | 北京：`https://ark.cn-beijing.volces.com/api/v3` | `/chat/completions` | `doubao-seed-2-1-pro-260915` | — |
| 国内 | [百度千帆](https://cloud.baidu.com/doc/qianfan/s/Hmh4suq26) | `openai` | 国内：`https://qianfan.baidubce.com/v2` | `/chat/completions` | `ernie-4.5-turbo-128k`, `deepseek-v3.1-250821` | openOii 不发送 appid 请求头：请使用对全部应用有权限的 API Key。 |
| 国内 | [腾讯混元](https://cloud.tencent.com/document/product/1823/130051) | `openai` | 国内：`https://tokenhub.tencentmaas.com/v1`<br>国际：`https://tokenhub-intl.tencentcloudmaas.com/v1` | `/chat/completions` | `hy4-preview`, `hy3` | 旧地址 api.hunyuan.cloud.tencent.com 已于 2026-09-30 停用。 |
| 国内 | [硅基流动](https://docs.siliconflow.cn/) | `openai` | 国内：`https://api.siliconflow.cn/v1` | `/chat/completions` | `deepseek-ai/DeepSeek-V4.1-Flash`, `zai-org/GLM-5.3`, `tencent/Hy4-preview` | 官方已从 .com 迁移到 api.siliconflow.cn。 |
| 海外 | [OpenAI](https://developers.openai.com/api/reference/python/resources/chat/index.md) | `openai` | 官方：`https://api.openai.com/v1` | `/chat/completions` | `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6.1-sol` | — |
| 海外 | [Anthropic Claude](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) | `openai` | 官方：`https://api.anthropic.com/v1` | `/chat/completions` | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` | 走 Anthropic 官方的 OpenAI 兼容层，Claude 5.5 系列可直接用；提示缓存、引用等原生特性不可用。；需要原生 Messages 接口或中转站时，选「自定义」后在「高级设置」里把接口协议切到 Anthropic。 |
| 海外 | [Google Gemini](https://ai.google.dev/gemini-api/docs/openai) | `openai` | 官方：`https://generativelanguage.googleapis.com/v1beta/openai` | `/chat/completions` | `gemini-3.8-flash` | — |
| 海外 | [xAI Grok](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions) | `openai` | 官方：`https://api.x.ai/v1` | `/chat/completions` | `grok-4.7`, `grok-4.6` | 推理模型响应较慢，可把高级设置里的请求超时调大。 |
| 海外 | [Mistral](https://docs.mistral.ai/api) | `openai` | 官方：`https://api.mistral.ai/v1` | `/chat/completions` | `mistral-large-4`, `mistral-medium-3-5` | — |
| 海外 | [OpenRouter](https://openrouter.ai/docs/quickstart) | `openai` | 官方：`https://openrouter.ai/api/v1` | `/chat/completions` | `openrouter/auto` | — |
| 海外 | [Groq](https://console.groq.com/docs/openai) | `openai` | 官方：`https://api.groq.com/openai/v1` | `/chat/completions` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | — |
| 海外 | [Together AI](https://docs.together.ai/docs/openai-api-compatibility) | `openai` | 官方：`https://api.together.xyz/v1` | `/chat/completions` | `openai/gpt-oss-120b` | — |
| 海外 | [Azure OpenAI](https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle) | `openai` | 资源终结点：`https://{resource}.openai.azure.com/openai/v1` | `/chat/completions` | — | 需要填写：resource；使用不带 api-version 的 v1 接口；旧的 /deployments/…?api-version= 地址请用自定义。 |
| 海外 | [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html) | `openai` | us-east-1：`https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`<br>us-west-2：`https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1` | `/chat/completions` | `openai.gpt-oss-120b-1:0`, `openai.gpt-oss-20b-1:0` | 只能用 Bedrock API Key（Bearer）；AWS SigV4 签名不支持。 |
| 本地与自定义 | [Ollama](https://docs.ollama.com/api/openai-compatibility) | `openai` | 本机：`http://localhost:11434/v1` | `/chat/completions` | — | localhost 指运行 openOii 后端的机器；本地地址需先保存再测试连接。 |
| 本地与自定义 | [LM Studio](https://lmstudio.ai/docs/developer/openai-compat) | `openai` | 本机：`http://localhost:1234/v1` | `/chat/completions` | — | localhost 指运行 openOii 后端的机器；本地地址需先保存再测试连接。 |
| 本地与自定义 | 自定义 · OpenAI 兼容 | `openai` | — | — | — | 只切换类型，保留已有地址和模型 |
| 测试模式（小选项） | 测试模式（Fake） | `fake` | — | — | — | — |

## 图像服务（写入 `IMAGE_*`）

| 分组 | 预设 | 类型 | 地址 | 接口路径 | 推荐模型 | 特殊配置 / 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 国内 | [火山方舟 Seedream](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api) | `openai` | 北京：`https://ark.cn-beijing.volces.com/api/v3` | `/images/generations` | `doubao-seedream-4-0-250828`, `doubao-seedream-5-0-pro-260628`, `doubao-seedream-5-0-flash-260915` | openOii 固定请求 1024×1024：5.0 lite 最低 2K，不在推荐列表里。；Seedream 默认加水印，openOii 目前不传 watermark 参数。 |
| 国内 | [智谱 CogView](https://docs.bigmodel.cn/cn/guide/models/image-generation/cogview-4) | `openai` | 国内：`https://open.bigmodel.cn/api/paas/v4` | `/images/generations` | `cogview-4-250304`, `cogview-4` | — |
| 国内 | [ModelScope 魔搭](https://modelscope.cn/docs/model-service/API-Inference/intro) | `modelscope` | 国内：`https://api-inference.modelscope.cn` | `/v1/images/generations` | `Tongyi-MAI/Z-Image-Turbo`, `Qwen/Qwen-Image` | 异步任务：提交后轮询 /v1/tasks/{id}，引擎和后端都已支持。 |
| 海外 | [OpenAI 图像](https://developers.openai.com/api/docs/guides/image-generation) | `openai` | 官方：`https://api.openai.com/v1` | `/images/generations` | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | — |
| 本地与自定义 | 自定义 · OpenAI 兼容 | `openai` | — | — | — | 只切换类型，保留已有地址和模型 |
| 测试模式（小选项） | 测试模式（Fake） | `fake` | — | — | — | — |

## 视频服务（写入 `VIDEO_*`（豆包为 `DOUBAO_*`））

可灵、Vidu、CogVideoX、MiniMax 海螺、通义万相、Veo 走各自的**原生异步接口**（`VIDEO_PROVIDER` = `kling` / `vidu` / `zhipu` / `minimax` / `dashscope` / `veo`），由引擎 `engine/src/media/video-jobs/` 里每个服务商一个模块实现：提交 → 轮询 → 下载。轮询间隔 `OPENOII_VIDEO_POLL_MS`（默认 5 秒），最长 15 分钟；网络错误和 429 / 5xx 退避重试，连续 5 次失败才放弃；401 / 403 / 参数错误立即失败。取消运行只停止本地轮询，服务商侧已排队的任务不会撤回（这些接口大多没有取消 API）。成片下载到本地，非服务商域名的地址要先通过公网地址检查。分镜时长和 `VIDEO_RATIO`（画幅，默认 16:9）按下表取到服务商允许的值。接口均于 2026-10-30 按官方文档核对，**没有用真实密钥调用过**。

| 服务商 | 文生 / 图生 | 时长（秒） | 画幅 | 特殊处理 |
| --- | --- | --- | --- | --- |
| [可灵](https://kling.ai/document-api/api/video/3-0-omni/text-to-video) `kling` | ✓ / ✓ | 4.0：3–30；3.0 / 3.0-turbo：3–15；2.6 / 2.5-turbo：5 或 10 | 16:9、9:16、1:1（4.0 另有 21:9） | 模型名写在路径里 `/text-to-video/{model}`；固定 720p；首帧以去掉 `data:` 前缀的 Base64 发送；只支持新版 API Key（Bearer），旧版 AK/SK 不接 |
| [Vidu](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video) `vidu` | ✓ / ✓ | Q3：1–16；Q2：1–10 | 16:9、9:16、3:4、4:3、1:1（图生视频跟随首帧） | `Authorization: Token {key}`；结果地址 24 小时有效 |
| [智谱 CogVideoX](https://docs.bigmodel.cn/cn/guide/models/video-generation/cogvideox-3) `zhipu` | ✓ / ✓ | 5 或 10 | 用 `size` 表示：16:9 → 1920x1080，9:16 → 1080x1920，1:1 → 1024x1024 | 提示词截到 512 字；结果从 `/async-result/{id}` 读取 |
| [MiniMax 海螺](https://platform.minimax.io/docs/api-reference/video-generation-t2v) `minimax` | ✓ / ✓ | Hailuo-2.3 / 02：6 或 10（768P）；其它 6 | 不支持（按模型默认 / 跟随首帧） | 业务错误在 HTTP 200 的 `base_resp` 里；成功后用 `file_id` 换 1 小时有效的下载地址；V2 / H3 新接口未接 |
| [通义万相](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference) `dashscope` | ✓ / ✓ | wan2.6 / 2.7：2–15；wan2.5：5 或 10；更早固定 5 | wan2.7 用 `ratio`；旧版用 `size`（720P，wan2.2 为 1080P） | 请求头 `X-DashScope-Async: enable`；图生视频自动把 `-t2v` 换成 `-i2v`；wan2.7 首帧用 `media[{type:first_frame}]`，旧版用 `img_url` |
| [Google Veo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text) `veo` | ✓ / ✓（仅内联图片） | 4 / 6 / 8 | 16:9、9:16 | **实验性**。走 Vertex AI `predictLongRunning` + `fetchPredictOperation`，不设 `storageUri`，视频字节直接返回并写盘；`ya29.` 开头的密钥按 OAuth 令牌（Bearer）发送，其它按 `x-goog-api-key`（express 模式，是否能调用 Veo 未经验证） |

画风防漂移（所有服务商）：图生视频的提示词**开头**先放「画风锁定（最高优先级）」一句（与首帧相同的 2D 手绘插画、保持设定图的眼睛大小和头身比例），结尾的 `Avoid:` 段在画风反向词之外再加写实漂移词（realistic animal anatomy、wildlife photography、small beady eyes 等）。有原生反向提示词字段的服务商另外单独发送：通义万相 `input.negative_prompt`（[文档](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)，最多 500 字符）、Veo `parameters.negativePrompt`；其它服务商（可灵 Omni、Vidu、MiniMax、CogVideoX、豆包、OpenAI 兼容网关）没有这个字段，只靠提示词。不额外发送角色设定图：2026-10-30 在乌鸦喝水 S04/S06 上对比，多传一张设定图会让视频偏离首帧构图（首帧本身已经是画风参考）。

未经真实密钥验证的点：`wan2.7-i2v` 这个不带日期的模型名（文档示例是 `wan2.7-i2v-2026-04-25`）；Veo express 模式 API Key；可灵对去前缀 Base64 的接受情况；Vidu 未传 `resolution` / `audio` 时的默认值。

| 分组 | 预设 | 类型 | 地址 | 接口路径 | 推荐模型 | 特殊配置 / 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 国内 | [火山方舟 Seedance](https://ark.volcengine.com/region:cn-beijing/docs/list-video-generation-tasks-api) | `doubao` | — | — | `doubao-seedance-2-5-260628`, `doubao-seedance-1-5-pro-251215` | 固定使用北京地域；时长和画幅在高级设置里调整。 |
| 海外 | [xAI Grok Imagine](https://docs.x.ai/developers/model-capabilities/video/generation) | `openai` | 官方：`https://api.x.ai/v1` | `/videos/generations` | `grok-imagine-video-1.5`, `grok-imagine-video-1.5-lite` | **实验性**；返回 request_id 后轮询 /v1/videos/{id}，与 openOii 的异步任务流程一致。；xAI 的图生视频参数叫 image，openOii 发送的是 image_url：目前按文生视频使用。 |
| 本地与自定义 | 自定义 · OpenAI 兼容 | `openai` | — | — | — | 只切换类型，保留已有地址和模型 |
| 测试模式（小选项） | 测试模式（Fake） | `fake` | — | — | — | — |

## 视觉审查（写入 `CRITIQUE_VISION_*`）

质量审查（Critic）要看首帧图和视频帧，所以带图片的审查请求走单独的视觉模型：`CRITIQUE_VISION_BASE_URL`、`CRITIQUE_VISION_API_KEY`、`CRITIQUE_VISION_MODEL`。接口固定为 OpenAI 兼容 `chat/completions`，图片以 `image_url` 的 data URL 传入。

审查开始前引擎先 `GET {Base URL}/models`（5 秒超时，缓存 1 分钟）确认视觉服务在线。下面几种情况都**不再当作通过**，而是把分镜标为「未检查」（`shot.review_status = unchecked`，原因写在 `review_note`，画布上的分镜卡显示「未检查」，悬停看原因），并在对话里说明，画面保留、流程继续：

- 没配置视觉模型（以前会把图片发给文本模型；看不到图的文本模型给不出分数，结果等于默认通过）。只有文本服务是测试模式（Fake）时才允许不配视觉模型。
- 视觉服务连不上、超时，或返回 5xx（例如本地 llama-server 被系统因内存不足结束）。
- 密钥被拒（401 / 403）。
- 单个镜头调用失败或没给出有效评分。

审查过的镜头显示「已检查」或「未通过」；重新生成首帧会清掉旧结果，重新生成视频后按视频检查的结果更新。

| 分组 | 预设 | 地址 | 推荐模型 | 说明 |
| --- | --- | --- | --- | --- |
| 国内 | [通义千问 VL（百炼）](https://help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai) | 北京 `https://dashscope.aliyuncs.com/compatible-mode/v1`；新加坡 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`；专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` 等 | `qwen3-vl-plus` | 密钥按地域区分。模型列表见 [视觉理解模型](https://docs.bailian.console.aliyun.com/zh/model-studio/model-list-visual-understanding) |
| 国内 | [智谱 GLM-V](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash`（[免费](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash)）、`glm-4.6v`、`glm-5v-turbo` | — |
| 海外 | [OpenAI](https://developers.openai.com/api/docs/guides/images-vision) | `https://api.openai.com/v1` | `gpt-6-astra`、`gpt-6.1-terra` | 支持 PNG / JPEG / WEBP / 非动图 GIF |
| 海外 | [Google Gemini](https://ai.google.dev/gemini-api/docs/openai) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | OpenAI 兼容层 |
| 本地 | [Qwen3-VL 本地（llama.cpp）](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | `http://127.0.0.1:{端口}/v1` | 模型名填 llama-server 的 `--alias` | 需要 `--mmproj`（[多模态说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)）。内存吃紧时用 `-np 1 --cache-ram 0` 并限制 `--image-max-tokens` |
| 本地与自定义 | 自定义 · OpenAI 兼容 | — | — | 任意支持图片输入的兼容服务 |

视觉审查没有测试模式卡片：不配置就是「未检查」。只有 Qwen3-VL 本地（llama.cpp）用真实服务测过，云端预设都按官方文档整理，**没有用真实密钥调用过**（未验）。

## 配音（写入 `TTS_*`）

成片里的台词配音。`TTS_PROVIDER` 选服务商，`TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` 是云端服务的地址、密钥和模型，`TTS_DEFAULT_VOICE` 是默认音色。角色可以在画布属性面板里单独填「配音音色」，留空时 Edge 按角色描述自动挑男女老少，云端用默认音色。每个项目可以在简报的「成片选项」里单独开关配音（跟随设置 / 开 / 关）。

台词按「角色名：台词」认说话人，「旁白：…」或没有前缀的台词归给旁白 / 镜头里的第一个角色，配音只念冒号后面的内容。云端配音失败时这句台词不配音（对话里会说明），不会再塞一段提示音；Edge 失败时沿用原来的行为。

| 分组 | 预设 | `TTS_PROVIDER` | 地址 | 请求 | 推荐模型 | 默认音色 | 测试连接（只读） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 国内 | [豆包语音](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh) | `doubao` | `https://openspeech.bytedance.com/api/v3` | `POST /tts/unidirectional`（`X-Api-Key`，`X-Api-Resource-Id` = 模型），按行解码 base64 音频，结束码 `20000000` | `seed-tts-2.0`、`seed-tts-1.0` | `zh_female_vv_uranus_bigtts` | 没有只读接口：只检查是否填了密钥，提示「豆包语音无法免费验证密钥」 |
| 国内 | [阿里 CosyVoice](https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api) | `cosyvoice` | 北京 `https://dashscope.aliyuncs.com/api/v1`；专属域名 `https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1` | `POST /services/audio/tts/SpeechSynthesizer`，再下载返回的 `output.audio.url` | `cosyvoice-v3-flash`、`cosyvoice-v3-plus`、`cosyvoice-v3.5-*` | `longanyang` | `GET {根}/compatible-mode/v1/models` |
| 国内 | [MiniMax 语音](https://platform.minimaxi.com/docs/api-reference/speech-t2a-http) | `minimax` | 国内 `https://api.minimaxi.com/v1`；海外 `https://api.minimax.io/v1` | `POST /t2a_v2`（`output_format: hex`），按 `base_resp.status_code` 判断（1004 为密钥无效） | `speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd` | `Chinese (Mandarin)_Lyrical_Voice`（[系统音色](https://platform.minimaxi.com/docs/faq/system-voice-id)） | `POST /get_voice`（`voice_type: system`） |
| 海外 | [Edge 免费配音](https://github.com/rany2/edge-tts) | `edge` | — | `edge-tts` 7.3.1 | — | `zh-CN-XiaoxiaoNeural` | 列出可用音色 |
| 海外 | [OpenAI](https://developers.openai.com/api/docs/guides/text-to-speech) | `openai` | `https://api.openai.com/v1` | `POST /audio/speech`（mp3） | `gpt-4o-mini-tts`、`tts-1-hd`、`tts-1` | `marin` | `GET /models` |
| 海外 | [ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) | `elevenlabs` | `https://api.elevenlabs.io/v1` | `POST /text-to-speech/{voice_id}?output_format=mp3_44100_128`（`xi-api-key`） | `eleven_multilingual_v2`、`eleven_v3`、`eleven_flash_v2_5` | `JBFqnCBsd6RMkjVDRZzb`（填 voice_id） | `GET /voices` |
| 海外 | [Azure 语音](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech) | `azure` | `https://{region}.tts.speech.microsoft.com` | `POST /cognitiveservices/v1`（SSML，`Ocp-Apim-Subscription-Key`） | —（按音色） | `zh-CN-XiaoxiaoNeural` | `GET /cognitiveservices/voices/list` |
| 本地与自定义 | 自定义 · OpenAI 兼容 | `openai` | 自填 | `POST /audio/speech` | 自填 | 自填 | `GET /models` |

- OpenAI 官方说明 `tts-1`、`tts-1-hd`、`gpt-4o-mini-tts` 将于 2027-01-06 停用，音色主要为英文优化。
- Edge 免费配音用的是浏览器朗读的公开接口，没有服务保障；后端依赖是 `edge-tts>=7.3.1`。免费音色里没有 `zh-CN-XiaohanNeural`，儿童角色改用 `zh-CN-YunxiaNeural`。
- 只有 Edge 用真实服务合成过。云端 6 家都用假密钥打过测试连接，确认地址可达、返回 401 / 1004 等「密钥无效」；**没有用真实密钥合成过**（未验）。

## 字幕（写入 `SUBTITLE_*`）

字幕不调用任何服务商，也不做语音识别：直接用剧本台词生成，时间跟着配音走。

| 配置 | 取值 | 说明 |
|---|---|---|
| `SUBTITLE_MODE` | `off`（默认）/ `soft` / `burn` | `soft` 写一条 `mov_text` 字幕轨（语言 `chi`），播放器里可以关；`burn` 用 libass 把字幕画进画面，会重新编码一次（libx264 crf 20）。每个项目可以在属性面板的「成片选项」里单独选。 |
| `SUBTITLE_FONT` | 字体名，默认 `Smiley Sans`（得意黑，OFL） | 只影响 `burn`。系统没装这个字体时，fontconfig 会换成 Noto Sans CJK SC 等中文字体。字体文件不随仓库提交，需要的话自己装：<https://github.com/atelier-anchor/smiley-sans> |

时间怎么算：每个镜头的字幕从这个镜头在成片里的起点开始，持续到配音结束（关了配音就按每字约 0.24 秒估，最少 1.2 秒），不会超过镜头本身的长度。一句太长时，按标点切成几条，按字数分配时间。

版式：字号是画面短边的 5.5%，底边和左右各留 7% 的安全区，一行最多 8–16 个字（1920×1080 是 16 个字，竖屏 1080×1920 是 15 个字），白字加深色描边。同时会生成一份 `.srt`，放在成片旁边。

## 背景音乐（写入 `BGM_*`）

整部片铺一条背景音乐（以前是每个镜头各混一段，而且内置的 6 个文件其实是静音占位）。拼接完成后按全片的场景和表情关键词挑一种情绪（warm / happy / sad / suspense / action / ambient），取一条曲子，循环或截到片长，开头 1.5 秒淡入、结尾 2 秒淡出，再和片子原声、配音混在一起。

- `BGM_ENABLED`：开关；每个项目可以在「成片选项」里单独选（跟随设置 / 开 / 关）。
- `BGM_VOLUME`：压低之前的音量（0–1，默认 0.3）。
- `BGM_DUCKING`：闪避，默认开。用 ffmpeg `sidechaincompress`，触发信号是按时间摆好的配音轨（没有配音时用片子自己的声音），每句台词响起时音乐压低约 8 dB，说完 0.45 秒内回来。
- 云端服务商失败时自动退回内置曲库，对话里会说明原因（不含密钥）。

| 分组 | 预设 | `BGM_PROVIDER` | 地址 | 请求 | 推荐模型 | 测试连接（只读） |
| --- | --- | --- | --- | --- | --- | --- |
| 国内 | [MiniMax 音乐](https://platform.minimaxi.com/docs/api-reference/music-generation) | `minimax` | 国内 `https://api.minimaxi.com/v1`；海外 `https://api.minimax.io/v1`（[海外文档](https://platform.minimax.io/docs/api-reference/music-generation)） | `POST /music_generation`（`is_instrumental: true`，`output_format: hex`），按 `base_resp.status_code` 判断 | `music-2.6`、`music-3.0` | 音乐接口没有只读查询，用同一把密钥 `POST /get_voice` 验证，结果标为「部分可用」 |
| 海外 | [Stable Audio](https://docs.stability.ai/api-reference/stable-audio-2/text-to-audio) | `stability` | `https://api.stability.ai` | `POST /v2beta/audio/stable-audio-2/text-to-audio`（multipart，`accept: audio/*`，`duration` 取片长，最长 190 秒） | `stable-audio-2.5`、`stable-audio-2` | `GET /v1/user/balance` |
| 本地与自定义 | 内置曲库 | `library` | — | 本机用 numpy 合成（铺底和弦 + 拨弦琶音 + 低音，32 秒可循环，约 -15 LUFS），没有采样、没有第三方素材 | — | 直接成功，显示曲库数量 |
| 本地与自定义 | [自定义 · Suno 兼容](https://github.com/gcui-art/suno-api) | `suno` | 自填 | `POST /api/generate`（`make_instrumental: true`，`wait_audio: true`），下载返回的 `audio_url` | — | `GET /api/get_limit` |

- MiniMax 官方说明：2026-08-20 起付费音乐接口（音乐生成、歌词生成）不再对新用户开放，老用户可继续使用；限免模型已下线。
- Suno 目前没有公开的官方 API（开发者平台仍是邀请制测试），所以这里只对接社区 suno-api 兼容网关，地址自己填。
- 内置曲库放在 `BGM_DIRECTORY`（默认 `static/bgm`）。自己的 `情绪名.mp3` 放进去会优先使用；缺失、太小或整首静音（旧版本的占位文件）的才会重新合成。
- 只有内置曲库真实跑过。MiniMax、Stable Audio 用假密钥打过测试连接和生成接口，返回 1004 / 401「密钥无效」；Suno 兼容接口只对本机模拟网关跑通过；**都没有用真实密钥生成过音乐**（未验）。

## 处理过的特殊配置

- **地域绑定密钥**：阿里云百炼（北京、新加坡，以及北京 / 弗吉尼亚 / 东京专属域名）、Kimi（国内 / 海外）、MiniMax（国内 / 海外）、腾讯混元 TokenHub（国内 / 国际）、Bedrock（us-east-1 / us-west-2）都用地域切换。401 的中文提示会提醒检查地域。
- **按模板拼地址**：百炼专属域名 `https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`、Azure `https://{resource}.openai.azure.com/openai/v1`。字段没填时不写 Base URL。
- **模型字段语义不同**：Azure 填部署名称；火山方舟可以填模型 ID 或接入点 ID（`ep-…`）。
- **Claude 5.5**：引擎的原生 Anthropic 适配只认 4.x 型号，所以「Anthropic Claude」预设走官方 OpenAI 兼容层 `https://api.anthropic.com/v1`。原生 Messages 接口或中转站：选「自定义」，在「高级设置 → 接口协议」里选 Anthropic Claude（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）；老配置会原样显示在自定义里。
- **ModelScope 异步出图**：引擎提交时带 `X-ModelScope-Async-Mode: true`，再轮询 `/v1/tasks/{id}`（`X-ModelScope-Task-Type: image_generation`），见 PR #106。
- **Seedream**：openOii 固定请求 1024×1024，最低要求 2K 的 5.0 lite 不在推荐列表里。另外 Seedream 默认带水印。
- **Seedance**：走方舟原生任务接口（`DOUBAO_*`）。时长目前按 5 或 10 秒提交（引擎 `normalizeVideoDuration`），画幅在高级设置里调。
- **推理参数**：Kimi K3 用顶层 `reasoning_effort`（low / high / max），对应高级设置里的「推理强度」。引擎只接受 minimal / low / medium / high / xhigh，所以 `max` 暂时用不了。智谱的 `thinking.type` 目前没有对应的配置项。
- **退役与迁移**：DeepSeek `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线；腾讯混元旧地址 `api.hunyuan.cloud.tencent.com` 已于 2026-09-30 停用；硅基流动已迁到 `api.siliconflow.cn`；MiniMax M2.5 / M2.7 将于 2026-11-18 下线。
- **千帆**：openOii 不发送 `appid` 头，需要用对全部应用都有权限的 API Key。
- **本地服务**（Ollama、LM Studio）：密钥可以留空。`localhost` 指的是运行 openOii 后端的机器。

## 暂不提供预设的服务商

| 服务商 / 能力 | 原因 |
| --- | --- |
| 可灵旧版 AK/SK | 只接新版 API Key（Bearer）；AK/SK 签 JWT 的旧鉴权不接 |
| MiniMax image-01 / 视频 V2 接口 | 图像是原生接口；视频只接 V1 `video_generation` |
| 阿里云万相 Wan 图像 | 需要 DashScope 原生图像任务接口（视频已接） |
| 硅基流动 图像 / 视频 | 参数是 `image_size`，返回 `images[]`，和引擎的请求 / 响应格式不同 |
| OpenAI Sora（视频） | OpenAI Videos API 和 sora-2 / sora-2-pro 已于 2026-09-24 关停，没有替代接口（[video-generation 指南](https://developers.openai.com/api/docs/guides/video-generation)、[deprecations](https://developers.openai.com/api/docs/deprecations)） |
| Gemini API 里的 Veo | Veo 3.1 Preview 已于 2026-10-22 在 Gemini API 下线，veo-2 / 3.0 于 2026-06-30 退役（[deprecations](https://ai.google.dev/gemini-api/docs/deprecations)）；GA 版本只在 Vertex AI，见上表 |
| Gemini Omni Flash 视频 | Interactions API，形状不同，未接 |
| xAI 图像 | 用 `aspect_ratio` 而不是 `size` |
| Amazon Bedrock（SigV4） | 只支持 Bedrock API Key（Bearer），不做 AWS 签名 |
| Azure 旧版部署地址 | `/deployments/{name}?api-version=` 请用「自定义」手动填写 |
| 智谱 z.ai 国际站 | 地址和模型没能在官方文档里核实 |
| Seedream 5.0 lite | 最低 2K，openOii 固定请求 1024×1024 |

这些服务以后接入时需要在引擎里加专门的适配，不能只靠预设。

## 服务商 logo

卡片上的 logo 取自 [Lobe Icons](https://github.com/lobehub/lobe-icons)（`@lobehub/icons-static-svg` 1.101.0，MIT License，Copyright (c) 2023 LobeHub），2026-10-30 下载，用 `frontend/scripts/build-provider-logos.py` 生成到 `frontend/public/provider-logos/`（共 33 个，约 39 KB，浏览器按需加载，不进 JS 包；其中 `library.svg` 是 openOii 自己画的曲库标，图形取自 Iconoir 的 music-double-note，MIT）。

- 有彩色变体（`*-color.svg`）的品牌直接用彩色版，只去掉 `<title>`、宽高和内联样式。
- 只有单色标的 7 个品牌（OpenAI、xAI、Groq、Ollama、LM Studio、ElevenLabs、Suno）按 Lobe Icons 源码 `src/<Brand>/style.ts` 里的头像配色（`AVATAR_BACKGROUND` / `AVATAR_COLOR`）烘焙成整块品牌底色：OpenAI 黑底白标、xAI 和 Ollama 白底黑标、Groq `#F55036` 底白标、LM Studio `#6C78EF→#4F14BE` 渐变底白标、ElevenLabs 白底黑标、Suno 黑底白标。
- 界面统一放在 28px 的浅色方块里（4px 内边距、1px 细边），方块颜色不随主题变，深色模式下深色和浅色的标都看得清；烘焙底色的 7 个铺满方块。

许可全文见 `frontend/public/provider-logos/LICENSE.txt`，汇总在仓库根目录 `NOTICE`。

logo 是各公司的商标，这里只用来标明服务商，openOii 与它们没有关联，也未获其背书。

| 预设 | logo 文件 | Lobe Icons 名称 |
|---|---|---|
| DeepSeek | deepseek.svg | DeepSeek |
| 阿里云百炼（文本）| bailian.svg | Bailian |
| 智谱 GLM / CogView | zhipu.svg | Zhipu |
| Kimi | kimi.svg | Kimi |
| MiniMax | minimax.svg | Minimax |
| 火山方舟（文本）| volcengine.svg | Volcengine |
| Seedream / Seedance | doubao.svg | Doubao |
| 百度千帆 | baiducloud.svg | BaiduCloud |
| 腾讯混元 | hunyuan.svg | Hunyuan |
| 硅基流动 | siliconcloud.svg | SiliconCloud |
| OpenAI / OpenAI 图像 | openai.svg | OpenAI（单色，烘焙头像配色） |
| Claude（OpenAI 兼容层）| claude.svg | Claude |
| Google Gemini | gemini.svg | Gemini |
| xAI Grok（文本、视频）| xai.svg | XAI（单色，烘焙头像配色） |
| Mistral | mistral.svg | Mistral |
| OpenRouter | openrouter.svg | OpenRouter |
| Groq | groq.svg | Groq（单色，烘焙头像配色） |
| Together AI | together.svg | Together |
| Azure OpenAI | azure.svg | Azure |
| Amazon Bedrock | bedrock.svg | Bedrock |
| Ollama | ollama.svg | Ollama（单色，烘焙头像配色） |
| LM Studio | lmstudio.svg | LMStudio（单色，烘焙头像配色） |
| ModelScope | modelscope.svg | ModelScope |
| Qwen3-VL 本地（视觉审查）| qwen.svg | Qwen |
| 通义千问 VL（视觉审查）| bailian.svg | Bailian |
| 可灵 / Vidu / MiniMax 海螺 / Google Veo（视频）| kling.svg、vidu.svg、hailuo.svg、deepmind.svg | Kling、Vidu、Hailuo、DeepMind |
| 智谱 CogVideoX / 通义万相（视频）| zhipu.svg、bailian.svg | Zhipu、Bailian |
| Stable Audio（背景音乐）| stability.svg | Stability |
| 自定义 · Suno 兼容（背景音乐）| suno.svg | Suno（单色，烘焙头像配色） |

自定义和测试模式没有品牌，继续用文字标记。新增预设时在 `providerPresets.ts` 里填 `logo` 并重跑生成脚本；单元测试会检查文件存在、是彩色、无脚本和外链、小于 4 KB，且目录里没有用不到的文件。

## 维护

1. 改 `providerPresets.ts`：更新地址、模型和 `sources`，并把 `PRESETS_VERIFIED_AT` 改成核对日期。
2. `providerPresets.test.ts` 会检查：每个真实预设都有 https 来源；地址里的占位字段都有输入说明；预设写入的值能反推回同一个预设和地域；本机网关配置在三个页签都识别为唯一的「自定义」。
3. 同步更新本文档。

