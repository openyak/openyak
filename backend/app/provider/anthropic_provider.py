"""Anthropic provider adapter for the desktop backend.

Delegates to yakAgent's AnthropicProvider (native Anthropic SDK with full
Claude feature support: extended thinking, prompt caching, native tools)
and converts between yakAgent and desktop schema types.
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from app.provider.base import BaseProvider
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ModelPricing,
    ProviderStatus,
    StreamChunk,
)

logger = logging.getLogger(__name__)


def _convert_model_info(m: Any) -> ModelInfo:
    """Convert a yakAgent ModelInfo to the desktop schema."""
    return ModelInfo(
        id=m.id,
        name=m.name,
        provider_id=m.provider_id,
        capabilities=ModelCapabilities(
            function_calling=m.capabilities.function_calling,
            vision=m.capabilities.vision,
            reasoning=m.capabilities.reasoning,
            json_output=m.capabilities.json_output,
            max_context=m.capabilities.max_context,
            max_output=m.capabilities.max_output,
            prompt_caching=True,  # All Claude models support prompt caching
        ),
        pricing=ModelPricing(
            prompt=m.pricing.prompt,
            completion=m.pricing.completion,
        ),
        metadata=m.metadata if hasattr(m, "metadata") else {},
    )


class AnthropicDesktopProvider(BaseProvider):
    """Anthropic provider for the desktop backend.

    Wraps yakAgent's native AnthropicProvider to get full Claude support
    (extended thinking, prompt caching, native tools) while returning
    the desktop backend's schema types.
    """

    def __init__(self, api_key: str, **kwargs: Any):
        from yakagent.provider.anthropic import AnthropicProvider

        self._api_key = api_key
        self._inner = AnthropicProvider(api_key=api_key, **kwargs)

    @property
    def id(self) -> str:
        return "anthropic"

    async def list_models(self) -> list[ModelInfo]:
        # Start with models.dev (live pricing/capabilities)
        models = await self._load_models_dev()
        # Merge with yakAgent's hardcoded list to fill gaps
        # (models.dev might miss latest models; yakAgent might have them)
        inner_models = await self._inner.list_models()
        seen_ids = {m.id for m in models}
        for m in inner_models:
            if m.id not in seen_ids:
                models.append(_convert_model_info(m))
        return models

    async def _load_models_dev(self) -> list[ModelInfo]:
        try:
            from app.provider.models_dev import models_dev
            raw = await models_dev.get_models("anthropic")
            if not raw:
                return []
            models = []
            for m in raw:
                caps = m.get("capabilities", {})
                pricing = m.get("pricing", {})
                meta = m.get("metadata", {})
                models.append(ModelInfo(
                    id=m["id"],
                    name=m.get("name", m["id"]),
                    provider_id="anthropic",
                    capabilities=ModelCapabilities(
                        function_calling=caps.get("function_calling", True),
                        vision=caps.get("vision", False),
                        reasoning=caps.get("reasoning", False),
                        json_output=caps.get("json_output", False),
                        max_context=caps.get("max_context", 200_000),
                        max_output=caps.get("max_output"),
                        prompt_caching=caps.get("prompt_caching", True),
                    ),
                    pricing=ModelPricing(
                        prompt=pricing.get("prompt", 0),
                        completion=pricing.get("completion", 0),
                        # models.dev already parses these; without them the
                        # cost calculator cannot price a cached read at all.
                        cache_read=pricing.get("cache_read_price") or None,
                        cache_write=pricing.get("cache_write_price") or None,
                    ),
                    metadata=meta,
                ))
            return models
        except Exception as e:
            logger.debug("models.dev unavailable for anthropic: %s", e)
            return []

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
        async for chunk in self._inner.stream_chat(
            model,
            messages,
            tools=tools,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_body=extra_body,
            response_format=response_format,
        ):
            yield StreamChunk(type=chunk.type, data=chunk.data)

    async def health_check(self) -> ProviderStatus:
        inner = await self._inner.health_check()
        return ProviderStatus(
            status=inner.status,
            model_count=inner.model_count,
            error=inner.error,
        )

    def clear_cache(self) -> None:
        self._inner.clear_cache()
