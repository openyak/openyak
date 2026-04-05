"""OpenAI-compatible provider base class.

Handles the common /v1/chat/completions SSE streaming protocol
used by OpenRouter, OpenAI, and other compatible APIs.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx
from openai import AsyncOpenAI

from app.provider.base import BaseProvider
from app.schemas.provider import ModelInfo, ProviderStatus, StreamChunk

logger = logging.getLogger(__name__)


def _field(obj: Any, name: str, default: Any = 0) -> Any:
    """Read a field from either a dict-like or object-like value."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _int(value: Any) -> int:
    """Best-effort integer conversion with a safe fallback."""
    try:
        if value is None:
            return 0
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_usage_tokens(usage: Any) -> dict[str, int]:
    """Normalize usage across OpenRouter/OpenAI-compatible response formats.

    Canonical fields:
    - input: prompt tokens excluding cache hits
    - output: non-reasoning completion tokens
    - reasoning: reasoning completion tokens
    - cache_read: prompt tokens read from cache
    - cache_write: prompt tokens written to cache
    - total: total request tokens (prompt + completion)
    """
    raw_prompt_tokens = _int(_field(usage, "prompt_tokens", 0))
    raw_completion_tokens = _int(_field(usage, "completion_tokens", 0))

    completion_details = _field(usage, "completion_tokens_details", None)
    reasoning_tokens = max(0, _int(_field(completion_details, "reasoning_tokens", 0)))
    reasoning_tokens = min(reasoning_tokens, raw_completion_tokens)
    output_tokens = max(0, raw_completion_tokens - reasoning_tokens)

    prompt_details = _field(usage, "prompt_tokens_details", None)

    # Preferred modern format from OpenRouter/OpenAI-compatible responses.
    cache_read_tokens = _int(_field(prompt_details, "cached_tokens", 0))
    cache_write_tokens = _int(_field(prompt_details, "cache_write_tokens", 0))

    # Legacy fallback fields observed in some adapters.
    if cache_read_tokens == 0:
        cache_read_tokens = _int(_field(usage, "cache_read_input_tokens", 0))
    if cache_write_tokens == 0:
        cache_write_tokens = _int(_field(usage, "cache_creation_input_tokens", 0))

    # Prompt tokens in prompt_tokens_details format include cached_tokens.
    # Legacy adapter format may already separate prompt from cache_read.
    if prompt_details is not None:
        input_tokens = max(0, raw_prompt_tokens - cache_read_tokens)
    else:
        input_tokens = raw_prompt_tokens

    reported_total = _int(_field(usage, "total_tokens", 0))
    normalized_total = input_tokens + output_tokens + reasoning_tokens + cache_read_tokens
    total_tokens = reported_total if reported_total > 0 else normalized_total

    return {
        "input": input_tokens,
        "output": output_tokens,
        "reasoning": reasoning_tokens,
        "cache_read": cache_read_tokens,
        "cache_write": cache_write_tokens,
        "total": total_tokens,
    }


class OpenAICompatProvider(BaseProvider):
    """Base for any provider using the OpenAI chat completions API."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        default_headers: dict[str, str] | None = None,
    ):
        merged_headers = {"User-Agent": "OpenYak/1.0"}
        if default_headers:
            merged_headers.update(default_headers)

        self._client = AsyncOpenAI(
            api_key=api_key or "sk-no-key",
            base_url=base_url,
            default_headers=merged_headers,
            timeout=httpx.Timeout(300.0, connect=30.0),  # 5min read (free models cold-start), 30s connect
        )

    async def stream_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system: str | list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream chat using OpenAI SDK."""
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": self._build_messages(system, messages),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            kwargs["tools"] = tools
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if extra_body:
            kwargs["extra_body"] = extra_body
        if response_format:
            kwargs["response_format"] = response_format

        # Accumulate partial tool calls across chunks
        tool_call_accumulators: dict[int, dict[str, Any]] = {}
        had_any_content = False  # Track whether the stream produced any content

        try:
            stream = await self._client.chat.completions.create(**kwargs)
            async for chunk in stream:
                choice = chunk.choices[0] if chunk.choices else None

                if choice and choice.delta:
                    delta = choice.delta

                    # Reasoning content (OpenRouter / reasoning models)
                    reasoning_text = (
                        getattr(delta, "reasoning_content", None)
                        or getattr(delta, "reasoning", None)
                    )
                    if reasoning_text:
                        had_any_content = True
                        yield StreamChunk(type="reasoning-delta", data={"text": reasoning_text})

                    # Text content
                    if delta.content:
                        had_any_content = True
                        yield StreamChunk(type="text-delta", data={"text": delta.content})

                    # Tool calls (streamed incrementally)
                    if delta.tool_calls:
                        had_any_content = True
                        for tc in delta.tool_calls:
                            idx = tc.index
                            if idx not in tool_call_accumulators:
                                tool_call_accumulators[idx] = {
                                    "id": tc.id or "",
                                    "name": "",
                                    "arguments": "",
                                }
                            acc = tool_call_accumulators[idx]
                            if tc.id:
                                acc["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    acc["name"] = tc.function.name
                                if tc.function.arguments:
                                    acc["arguments"] += tc.function.arguments

                # Check finish reason to emit completed tool calls
                if choice and choice.finish_reason:
                    # Emit accumulated tool calls
                    for _idx, acc in sorted(tool_call_accumulators.items()):
                        try:
                            args = json.loads(acc["arguments"]) if acc["arguments"] else {}
                        except json.JSONDecodeError:
                            args = {"_raw": acc["arguments"]}
                        yield StreamChunk(
                            type="tool-call",
                            data={
                                "id": acc["id"],
                                "name": acc["name"],
                                "arguments": args,
                            },
                        )
                    tool_call_accumulators.clear()

                    yield StreamChunk(
                        type="finish",
                        data={"reason": choice.finish_reason},
                    )

                # Usage info (sent in the final chunk with stream_options)
                if chunk.usage:
                    usage = chunk.usage
                    normalized = _extract_usage_tokens(usage)

                    expected_total = (
                        normalized["input"]
                        + normalized["output"]
                        + normalized["reasoning"]
                        + normalized["cache_read"]
                    )
                    if normalized["total"] != expected_total:
                        logger.warning(
                            "Token total mismatch: input(%d) + output(%d) + reasoning(%d) + cache_read(%d) = %d, "
                            "reported total=%d",
                            normalized["input"],
                            normalized["output"],
                            normalized["reasoning"],
                            normalized["cache_read"],
                            expected_total,
                            normalized["total"],
                        )

                    yield StreamChunk(
                        type="usage",
                        data=normalized,
                    )

            # Log empty streams for debugging blank response issues
            if not had_any_content:
                logger.warning(
                    "Stream for model %s completed with no content (no text, no reasoning, no tool calls)",
                    model,
                )

        except Exception as e:
            logger.error("Stream error for model %s: %s", model, e, exc_info=True)
            yield StreamChunk(type="error", data={"message": str(e)})

    def _build_messages(
        self,
        system: str | list[dict[str, Any]] | None,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Prepend system message if provided."""
        result = []
        if system:
            if isinstance(system, str):
                result.append({"role": "system", "content": system})
            elif isinstance(system, list):
                result.append({"role": "system", "content": system})
        result.extend(messages)
        return result

    async def health_check(self) -> ProviderStatus:
        """Check if the API is reachable by listing models."""
        try:
            models = await self.list_models()
            return ProviderStatus(status="connected", model_count=len(models))
        except Exception as e:
            return ProviderStatus(status="error", error=str(e))
