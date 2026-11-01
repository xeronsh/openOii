from __future__ import annotations

from functools import lru_cache
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Note: do not hardcode env_file here; tests instantiate Settings() directly and
    # should not implicitly read the repo's .env. Runtime uses get_settings().
    model_config = SettingsConfigDict(extra="ignore")

    app_name: str = "openOii-backend"
    environment: str = Field(default="dev", description="dev|staging|prod")

    # pi engine sidecar 的 loopback 地址（编排唯一引擎）
    engine_url: str = Field(
        default="http://127.0.0.1:18766",
        description="pi engine sidecar 的 loopback 地址",
    )

    api_v1_prefix: str = "/api/v1"
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    admin_token: str | None = Field(
        default=None,
        description="Admin token for configuration updates (sent via X-Admin-Token header)",
    )

    # 数据库：单文件 SQLite（WAL），与 pi engine sidecar 共享同一文件
    database_url: str = Field(
        default="sqlite+aiosqlite:///./data/openoii.db"
    )
    db_echo: bool = False

    # ============================================
    # LLM 服务 (Anthropic 兼容接口)
    # ============================================
    anthropic_api_key: str | None = None
    anthropic_auth_token: str | None = Field(
        default=None,
        description="中转站 Token（大概率用这个）",
    )
    anthropic_base_url: str | None = Field(
        default=None,
        description="Anthropic 中转站/代理地址，例如 https://your-proxy.example.com",
    )
    anthropic_model: str = Field(
        default="claude-sonnet-4-5-20250929",
        description="Claude 模型名称（中转站会自动转换为对应模型）",
    )

    # ============================================
    # 文本生成服务
    # ============================================
    text_provider: str = Field(
        default="anthropic",
        description="文本生成服务提供商：anthropic / openai / fake（本地开发/测试，不调用外部 API）",
    )

    # OpenAI 兼容接口
    text_base_url: str = Field(
        default="https://2c2ch1u11-share-api-0.hf.space/v1",
        description="文本生成服务基础地址（OpenAI 兼容）",
    )
    text_api_key: str | None = None
    text_model: str = Field(
        default="deepseek-v4-flash",
        description="文本生成模型名称（OpenAI 兼容）",
    )
    text_endpoint: str = Field(
        default="/chat/completions",
        description="文本生成 API 端点路径（OpenAI 兼容）",
    )
    text_reasoning_effort: str | None = Field(
        default=None,
        description="OpenAI 兼容推理模型的 reasoning_effort 档位，例如 low / medium / high",
    )

    # ============================================
    # 图像生成服务
    # ============================================
    image_provider: str = Field(
        default="modelscope",
        description="图像生成服务提供商：modelscope、openai 或 fake（本地开发/测试，不调用外部 API）",
    )
    image_base_url: str = Field(
        default="https://api-inference.modelscope.cn",
        description="图像生成服务基础地址",
    )
    image_api_key: str | None = None
    image_model: str = Field(
        default="Tongyi-MAI/Z-Image-Turbo",
        description="图像生成模型名称",
    )
    image_endpoint: str = Field(
        default="/v1/images/generations",
        description="图像生成 API 端点路径",
    )
    enable_image_to_image: bool = Field(
        default=True,
        description="是否启用图生图（分镜首帧 I2I 参考图）",
    )
    fake_image_fixture_url: str | None = Field(
        default=None,
        description="Fake 图像 Provider 使用的固定图片 URL（仅用于本地开发/测试）",
    )

    # --- Critic (Quality Review) ---
    critique_enabled: bool = Field(
        default=True,
        description="是否启用 Critic 质量审查闭环",
    )
    critique_score_threshold: float = Field(
        default=6.0,
        description="质量分阈值，低于此分数触发重新生成",
    )
    critique_max_rounds: int = Field(
        default=2,
        description="最大审查重试轮数（超过后强制继续）",
    )
    critique_vision_base_url: str | None = Field(
        default=None,
        description="审查用视觉模型的 OpenAI 兼容地址；不填或连不上时分镜标为「未检查」",
    )
    critique_vision_api_key: str | None = None
    critique_vision_model: str | None = Field(
        default=None,
        description="审查用视觉模型名称（需支持图片输入）",
    )

    # ============================================
    # 视频生成服务 (OpenAI 兼容接口)
    # ============================================
    video_base_url: str = Field(
        default="https://api.example.com/v1",
        description="视频生成服务基础地址",
    )
    video_api_key: str | None = None
    video_model: str = Field(
        default="video-gen-1",
        description="视频生成模型名称",
    )
    video_endpoint: str = Field(
        default="/videos/generations",
        description="视频生成 API 端点路径",
    )
    video_mode: str = Field(
        default="text",
        description="视频生成模式：text（文生视频）或 image（图生视频）",
    )
    enable_image_to_video: bool = Field(
        default=False,
        description="是否启用图生视频（分镜视频 I2V 参考图）",
    )
    video_ratio: str = Field(
        default="16:9",
        description="视频画幅（服务商原生接口）：16:9、9:16、1:1 等，不支持的值回落到服务商默认",
    )

    # ============================================
    # 豆包视频生成服务（火山引擎 Ark API）
    # ============================================
    doubao_api_key: str | None = Field(
        default=None,
        description="豆包 API Key（火山引擎 ARK_API_KEY）",
    )
    doubao_video_model: str = Field(
        default="doubao-seedance-1-5-pro-251215",
        description="豆包视频生成模型 ID",
    )
    doubao_video_duration: int = Field(
        default=5,
        description="豆包视频时长（5 或 10 秒）",
    )
    doubao_video_ratio: str = Field(
        default="adaptive",
        description="豆包视频比例：16:9, 9:16, 1:1, adaptive",
    )
    video_image_mode: str = Field(
        default="first_frame",
        description="图生视频模式：first_frame（仅分镜首帧）或 reference（拼接参考图）",
    )
    video_inline_local_images: bool = Field(
        default=True,
        description="图生视频时，未配置 PUBLIC_BASE_URL 则尝试内联本地图片为 data URL",
    )
    fake_video_fixture_url: str | None = Field(
        default=None,
        description="Fake 视频 Provider 使用的固定视频 URL（仅用于本地开发/测试）",
    )
    fake_video_fixture_path: str | None = Field(
        default=None,
        description="Fake 视频 Provider 使用的本地视频文件路径（仅用于本地开发/测试）",
    )

    # 视频服务提供商选择
    video_provider: str = Field(
        default="openai",
        description=(
            "视频服务提供商：openai（OpenAI 兼容接口）、doubao（豆包）、kling（可灵）、vidu、"
            "zhipu（CogVideoX）、minimax（海螺）、dashscope（通义万相）、veo 或 fake（本地开发/测试）"
        ),
    )

    # ============================================
    # TTS / BGM 配置（默认 Edge TTS + 内置 BGM，完全免费）
    # ============================================
    tts_enabled: bool = Field(
        default=True,
        description="是否启用 TTS 配音（项目里可单独开关）",
    )
    tts_provider: str = Field(
        default="edge",
        description=(
            "配音服务商：edge（免费）、openai（OpenAI 及兼容接口）、elevenlabs、azure、"
            "minimax、cosyvoice（阿里百炼）、doubao（火山引擎豆包语音）"
        ),
    )
    tts_base_url: str | None = Field(default=None, description="配音服务地址（留空用服务商默认）")
    tts_api_key: str | None = Field(default=None, description="配音服务 API Key（Edge 不需要）")
    tts_model: str | None = Field(
        default=None,
        description="配音模型；豆包语音填资源 ID（如 seed-tts-2.0）",
    )
    tts_default_voice: str = Field(
        default="zh-CN-XiaoxiaoNeural",
        description="默认 TTS 语音名称",
    )
    bgm_enabled: bool = Field(
        default=True,
        description="是否启用背景音乐（整部片一条，项目里可单独开关）",
    )
    bgm_provider: str = Field(
        default="library",
        description=(
            "背景音乐服务商：library（内置免版权曲库，本地合成）、minimax（MiniMax 音乐）、"
            "stability（Stable Audio）、suno（Suno 兼容网关）"
        ),
    )
    bgm_base_url: str | None = Field(default=None, description="背景音乐服务地址（留空用服务商默认）")
    bgm_api_key: str | None = Field(default=None, description="背景音乐服务 API Key（本地曲库不需要）")
    bgm_model: str | None = Field(default=None, description="背景音乐模型（如 music-2.6、stable-audio-2.5）")
    bgm_ducking: bool = Field(default=True, description="有台词时自动压低背景音乐（ducking）")
    bgm_volume: float = Field(
        default=0.3,
        description="BGM 音量（0-1）",
    )
    tts_volume: float = Field(
        default=1.0,
        description="TTS 音量（0-1）",
    )
    bgm_directory: str = Field(
        default="static/bgm",
        description="BGM 文件目录（相对于 app 目录）",
    )
    subtitle_mode: str = Field(
        default="off",
        description="字幕：off（不加）、soft（软字幕，播放器里可关）、burn（烧进画面）；项目里可单独选",
    )
    subtitle_font: str = Field(
        default="Smiley Sans",
        description="烧录字幕用的字体名（系统里没装时自动换成 Noto Sans CJK SC 等中文字体）",
    )

    # ============================================
    # 思考链可视化
    # ============================================
    thinking_chain_enabled: bool = Field(
        default=True,
        description="是否推送 Agent 思考链消息",
    )
    thinking_chain_detail_level: str = Field(
        default="normal",
        description="思考链详细级别：minimal（仅 decision）/ normal（decision + reviewing）/ verbose（全部）",
    )

    request_timeout_s: float = 120.0
    public_base_url: str | None = Field(
        default=None,
        description="对外可访问的后端地址（用于把 /static 路径转换为完整 URL）",
    )

    def text_headers(self) -> dict[str, str]:
        """文本服务请求头"""
        headers: dict[str, str] = {"User-Agent": self.app_name}
        if self.text_api_key:
            headers["Authorization"] = f"Bearer {self.text_api_key}"
        return headers

def apply_settings_overrides(overrides: dict[str, Any]) -> None:
    if not overrides:
        return
    settings = get_settings()
    data = settings.model_dump()
    data.update(overrides)
    updated = Settings.model_validate(data)
    for field_name in Settings.model_fields:
        setattr(settings, field_name, getattr(updated, field_name))


@lru_cache
def get_settings() -> Settings:
    return Settings(_env_file=".env", _env_file_encoding="utf-8")  # type: ignore[call-arg]
