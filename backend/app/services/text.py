from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, AsyncIterator, NoReturn

import httpx

from app.config import Settings
from app.services.llm import LLMResponse
from app.services.text_capabilities import (
    TextProviderCapability,
    build_provider_capability_cache_key,
    get_cached_provider_capability,
)

logger = logging.getLogger(__name__)


class TextServiceError(Exception):
    """文本服务基础异常"""

    def __init__(
        self, message: str, status_code: int | None = None, response_body: str | None = None
    ):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class TextServiceAuthError(TextServiceError):
    """认证失败异常（401/403）"""


class TextServiceRateLimitError(TextServiceError):
    """限流异常（429）"""


class TextServiceServerError(TextServiceError):
    """服务器错误异常（5xx）"""


class TextService:
    """文本生成服务（OpenAI 兼容接口，支持流式与非流式输出）"""

    def __init__(self, settings: Settings, *, max_retries: int = 3):
        self.settings = settings
        self.max_retries = max_retries

    def _build_url(self) -> str:
        base = self.settings.text_base_url.rstrip("/")
        endpoint = self.settings.text_endpoint
        if not endpoint.startswith("/"):
            endpoint = "/" + endpoint
        return f"{base}{endpoint}"

    def _is_retryable_status(self, status_code: int) -> bool:
        return status_code in {408, 429, 500, 502, 503, 504}

    def _raise_for_status(
        self,
        last_exc: Exception | None,
        last_status: int | None,
        last_body: str | None,
        context: str = "Text generation request",
    ) -> NoReturn:
        """Raise the appropriate TextServiceError subclass based on status code."""
        if last_status in (401, 403):
            raise TextServiceAuthError(
                f"Authentication failed (HTTP {last_status})",
                status_code=last_status,
                response_body=last_body,
            ) from last_exc
        if last_status == 429:
            raise TextServiceRateLimitError(
                f"Rate limit exceeded (HTTP {last_status})",
                status_code=last_status,
                response_body=last_body,
            ) from last_exc
        if last_status and last_status >= 500:
            raise TextServiceServerError(
                f"Server error (HTTP {last_status})",
                status_code=last_status,
                response_body=last_body,
            ) from last_exc
        raise TextServiceError(
            f"{context} failed after {self.max_retries} retries",
            status_code=last_status,
            response_body=last_body,
        ) from last_exc

    def _is_chat_endpoint(self) -> bool:
        return "/chat/completions" in self.settings.text_endpoint

    def _uses_max_completion_tokens(self) -> bool:
        return self._is_chat_endpoint() and self.settings.text_model.lower().startswith("gpt-5")

    async def _post_json_with_retry(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        last_exc: Exception | None = None
        last_status: int | None = None
        last_body: str | None = None

        async with httpx.AsyncClient(timeout=self.settings.request_timeout_s) as client:
            for attempt in range(self.max_retries + 1):
                try:
                    res = await client.post(url, headers=self.settings.text_headers(), json=payload)
                    res.raise_for_status()
                    return res.json()  # type: ignore[no-any-return]

                except httpx.HTTPStatusError as exc:
                    last_exc = exc
                    last_status = exc.response.status_code
                    try:
                        last_body = exc.response.text[:500]
                    except Exception:
                        last_body = None

                    if attempt >= self.max_retries or not self._is_retryable_status(last_status):
                        break

                    await asyncio.sleep(0.5 * (2**attempt))

                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    last_exc = exc
                    if attempt >= self.max_retries:
                        break
                    await asyncio.sleep(0.5 * (2**attempt))

        self._raise_for_status(last_exc, last_status, last_body)

    async def _post_stream_with_retry(
        self, url: str, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        delay_s = 0.5
        last_exc: Exception | None = None
        last_status: int | None = None
        last_body: str | None = None

        timeout = httpx.Timeout(self.settings.request_timeout_s, connect=30.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            for attempt in range(self.max_retries + 1):
                emitted_any = False
                try:
                    async with client.stream(
                        "POST", url, headers=self.settings.text_headers(), json=payload
                    ) as res:
                        last_status = res.status_code

                        if (
                            self._is_retryable_status(res.status_code)
                            and attempt < self.max_retries
                        ):
                            # 检查 Retry-After 头
                            retry_after = res.headers.get("Retry-After")
                            if retry_after:
                                try:
                                    wait_time = float(retry_after)
                                    delay_s = min(wait_time, 60.0)
                                except ValueError:
                                    pass

                            jitter = delay_s * 0.2 * (2 * random.random() - 1)
                            await asyncio.sleep(delay_s + jitter)
                            delay_s = min(delay_s * 2, 30.0)
                            continue

                        res.raise_for_status()

                        async for line in res.aiter_lines():
                            if not line or not line.startswith("data: "):
                                continue
                            data_str = line[6:]
                            if data_str.strip() == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                            except json.JSONDecodeError as exc:
                                logger.debug("Skipping non-JSON line in text stream: %s", exc)
                                continue

                            if "error" in chunk:
                                raise TextServiceError(f"Stream error: {chunk['error']}")

                            emitted_any = True
                            yield chunk

                    return

                except httpx.HTTPStatusError as exc:
                    last_exc = exc
                    last_status = exc.response.status_code
                    try:
                        last_body = exc.response.text[:500]
                    except Exception:
                        last_body = None

                    if emitted_any:
                        break
                    if attempt >= self.max_retries:
                        break
                    if not self._is_retryable_status(last_status):
                        break

                    jitter = delay_s * 0.2 * (2 * random.random() - 1)
                    await asyncio.sleep(delay_s + jitter)
                    delay_s = min(delay_s * 2, 30.0)

                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    last_exc = exc
                    if emitted_any:
                        break
                    if attempt >= self.max_retries:
                        break

                    jitter = delay_s * 0.2 * (2 * random.random() - 1)
                    await asyncio.sleep(delay_s + jitter)
                    delay_s = min(delay_s * 2, 30.0)

        self._raise_for_status(last_exc, last_status, last_body, context="Text generation stream")

    def _extract_text_from_response(self, data: dict[str, Any]) -> str:
        choices = data.get("choices", [])
        if not isinstance(choices, list) or not choices:
            raise RuntimeError(f"Text API response missing choices: {data}")

        first = choices[0] if isinstance(choices[0], dict) else {}
        if self._is_chat_endpoint():
            message = first.get("message", {})
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content
            raise RuntimeError(f"Text chat response missing message.content: {data}")

        text = first.get("text")
        if isinstance(text, str):
            return text
        raise RuntimeError(f"Text completions response missing choices[0].text: {data}")

    def _extract_text_from_stream_chunk(self, chunk: dict[str, Any]) -> str:
        choices = chunk.get("choices", [])
        if not isinstance(choices, list) or not choices:
            return ""

        first = choices[0] if isinstance(choices[0], dict) else {}
        if self._is_chat_endpoint():
            delta = first.get("delta", {})
            if isinstance(delta, dict):
                content = delta.get("content")
                if isinstance(content, str):
                    return content
            return ""

        text = first.get("text")
        return text if isinstance(text, str) else ""

    def _build_payload(
        self,
        *,
        messages: list[dict[str, Any]] | None = None,
        prompt: str | None = None,
        system: str | None = None,
        max_tokens: int = 1024,
        temperature: float | None = None,
        stream: bool,
        **kwargs: Any,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": self.settings.text_model, **kwargs}
        if self._uses_max_completion_tokens():
            payload.pop("max_tokens", None)
            payload.setdefault("max_completion_tokens", max_tokens)
        else:
            payload.setdefault("max_tokens", max_tokens)
        if self.settings.text_enable_thinking is not None:
            payload["enable_thinking"] = self.settings.text_enable_thinking
        if self.settings.text_reasoning_effort:
            payload["reasoning_effort"] = self.settings.text_reasoning_effort
        if temperature is not None:
            payload["temperature"] = temperature

        if self._is_chat_endpoint():
            if messages:
                payload["messages"] = messages
                if system:
                    payload["messages"] = [{"role": "system", "content": system}] + payload[
                        "messages"
                    ]
            elif prompt:
                payload["messages"] = [{"role": "user", "content": prompt}]
                if system:
                    payload["messages"] = [{"role": "system", "content": system}] + payload[
                        "messages"
                    ]
            else:
                raise ValueError("Either messages or prompt must be provided")
        else:
            if messages:
                prompt_parts = []
                if system:
                    prompt_parts.append(f"System: {system}")
                for msg in messages:
                    role = msg.get("role", "user")
                    content = msg.get("content", "")
                    prompt_parts.append(f"{role.capitalize()}: {content}")
                payload["prompt"] = "\n\n".join(prompt_parts)
            elif prompt:
                if system:
                    payload["prompt"] = f"System: {system}\n\n{prompt}"
                else:
                    payload["prompt"] = prompt
            else:
                raise ValueError("Either messages or prompt must be provided")

        payload["stream"] = stream
        return payload

    async def _generate_from_payload(self, payload: dict[str, Any]) -> LLMResponse:
        data = await self._post_json_with_retry(self._build_url(), payload)
        text = self._extract_text_from_response(data)
        return LLMResponse(text=text, tool_calls=[], raw=data)

    async def _stream_native_events(self, payload: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        full_text: list[str] = []

        async for chunk in self._post_stream_with_retry(self._build_url(), payload):
            text = self._extract_text_from_stream_chunk(chunk)
            if text:
                full_text.append(text)
                yield {"type": "text", "text": text}

        yield {
            "type": "final",
            "response": LLMResponse(text="".join(full_text), tool_calls=[], raw=None),
        }

    def _stream_fallback_message(self, exc: Exception) -> str:
        detail = str(exc).strip()
        if not detail:
            return "文本 Provider 流式不可用，已自动回退非流式生成。"
        return f"文本 Provider 流式不可用，已自动回退非流式生成。原始错误：{detail[:200]}"

    def _should_fallback_from_stream(self, exc: TextServiceError) -> bool:
        if isinstance(
            exc, (TextServiceAuthError, TextServiceRateLimitError, TextServiceServerError)
        ):
            return False
        return str(exc).startswith("Text generation stream failed after")

    def _is_retryable_probe_generate_error(self, exc: Exception) -> bool:
        if not isinstance(exc, TextServiceError):
            return False
        if exc.status_code is None:
            return True
        return self._is_retryable_status(exc.status_code)

    async def _probe_generate_capability(self, *, messages: list[dict[str, Any]]) -> None:
        delay_s = 0.5
        last_exc: Exception | None = None

        for attempt in range(2):
            try:
                payload = self._build_payload(
                    messages=messages,
                    max_tokens=8,
                    temperature=0,
                    stream=False,
                )
                await self._post_json_with_retry(self._build_url(), payload)
                return
            except Exception as exc:
                last_exc = exc
                if attempt >= 1 or not self._is_retryable_probe_generate_error(exc):
                    raise
                await asyncio.sleep(delay_s)
                delay_s = min(delay_s * 2, 2.0)

        if last_exc is not None:
            raise last_exc

    def _capability_cache_key(self) -> str:
        return build_provider_capability_cache_key(
            provider=self.settings.text_provider,
            text_base_url=self.settings.text_base_url,
            text_model=self.settings.text_model,
            text_endpoint=self.settings.text_endpoint,
            anthropic_base_url=self.settings.anthropic_base_url,
            anthropic_model=self.settings.anthropic_model,
            secret=self.settings.text_api_key
            or self.settings.anthropic_api_key
            or self.settings.anthropic_auth_token,
        )

    async def probe(self) -> TextProviderCapability:
        probe_messages = [{"role": "user", "content": "Reply with OK only."}]

        try:
            await self._probe_generate_capability(messages=probe_messages)
        except Exception as exc:
            return TextProviderCapability(
                status="invalid",
                generate=False,
                stream=False,
                reason_code="provider_generate_unavailable",
                reason_message=f"文本 Provider 连通性预检失败：{str(exc)[:200]}",
            )

        try:
            async for _ in self._stream_native_events(
                self._build_payload(
                    messages=probe_messages,
                    max_tokens=1,
                    temperature=0,
                    stream=True,
                )
            ):
                pass
        except Exception as exc:
            return TextProviderCapability(
                status="degraded",
                generate=True,
                stream=False,
                reason_code="provider_stream_unavailable",
                reason_message=self._stream_fallback_message(exc),
            )

        return TextProviderCapability(status="valid", generate=True, stream=True)

    async def generate(
        self,
        *,
        messages: list[dict[str, Any]] | None = None,
        prompt: str | None = None,
        system: str | None = None,
        max_tokens: int = 1024,
        temperature: float | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """生成文本（兼容 LLMService 接口）

        Args:
            messages: 消息列表（优先使用）
            prompt: 提示词（向后兼容）
            system: 系统提示（可选）
            max_tokens: 最大 token 数
            temperature: 温度参数
            **kwargs: 其他参数

        Returns:
            LLMResponse 对象（与 LLMService 兼容）
        """
        payload = self._build_payload(
            messages=messages,
            prompt=prompt,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=False,
            **kwargs,
        )
        return await self._generate_from_payload(payload)

    async def stream(
        self,
        *,
        messages: list[dict[str, Any]] | None = None,
        prompt: str | None = None,
        system: str | None = None,
        max_tokens: int = 1024,
        temperature: float | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        """流式生成文本（兼容 LLMService 接口）

        Args:
            messages: 消息列表（优先使用）
            prompt: 提示词（向后兼容）
            system: 系统提示（可选）
            max_tokens: 最大 token 数
            temperature: 温度参数
            **kwargs: 其他参数

        Yields:
            事件字典（与 LLMService 兼容）:
            - {"type": "text", "text": "..."}  # 增量文本
            - {"type": "final", "response": LLMResponse(...)}  # 最终响应
        """
        payload = self._build_payload(
            messages=messages,
            prompt=prompt,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=True,
            **kwargs,
        )

        cached_capability = get_cached_provider_capability(self._capability_cache_key())
        if (
            cached_capability is not None
            and cached_capability.generate
            and not cached_capability.stream
        ):
            fallback_payload = dict(payload)
            fallback_payload["stream"] = False
            response = await self._generate_from_payload(fallback_payload)
            if response.text:
                yield {"type": "text", "text": response.text}
            yield {"type": "final", "response": response}
            return

        emitted_any = False
        try:
            async for event in self._stream_native_events(payload):
                if event.get("type") == "text" and event.get("text"):
                    emitted_any = True
                yield event
            return
        except TextServiceError as exc:
            if emitted_any or not self._should_fallback_from_stream(exc):
                raise
            logger.warning("Text stream failed; falling back to non-stream generate: %s", exc)

        fallback_payload = dict(payload)
        fallback_payload["stream"] = False
        response = await self._generate_from_payload(fallback_payload)
        if response.text:
            yield {"type": "text", "text": response.text}
        yield {"type": "final", "response": response}
