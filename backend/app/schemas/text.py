from __future__ import annotations

from pydantic import BaseModel, Field


class TextGenerateRequest(BaseModel):
    """文本生成请求"""

    prompt: str = Field(..., description="提示词")
    max_tokens: int = Field(default=1024, ge=1, le=8192, description="最大 token 数")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0, description="温度参数")
    messages: list[dict[str, str]] | None = Field(default=None, description="多轮对话消息（可选）")


class TextGenerateResponse(BaseModel):
    """文本生成响应"""

    text: str = Field(..., description="生成的文本")
    model: str = Field(..., description="使用的模型")


class TextInterviewAnswer(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    answer: str = Field(..., min_length=1, max_length=2000)


class TextInterviewRequest(BaseModel):
    story: str = Field(..., min_length=1, max_length=5000)
    answers: list[TextInterviewAnswer] = Field(default_factory=list, max_length=5)


class TextInterviewQuestion(BaseModel):
    label: str = Field(..., min_length=1, max_length=40)
    question: str = Field(..., min_length=1, max_length=300)
    placeholder: str = Field(..., min_length=1, max_length=300)
    suggestions: list[str] = Field(..., min_length=2, max_length=4)


class TextInterviewResponse(BaseModel):
    ready: bool
    question: TextInterviewQuestion | None = None
