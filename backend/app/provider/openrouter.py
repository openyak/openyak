"""OpenRouter provider.

Primary provider for OpenYak. Uses OpenAI-compatible API at
https://openrouter.ai/api/v1 with reasoning support.
"""

from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator

import httpx
from openai import AsyncOpenAI

from app.provider.openai_compat import OpenAICompatProvider
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ModelPricing,
    StreamChunk,
)

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _is_free(pricing: dict) -> bool:
    """Check if a model's pricing dict indicates it's free."""
    return float(pricing.get("prompt", "1")) == 0 and float(pricing.get("completion", "1")) == 0


class OpenRouterProvider(OpenAICompatProvider):
    """OpenRouter LLM provider with reasoning support."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        provider_id: str = "openrouter",
        enable_reasoning: bool = True,
        cache_ttl_hours: int = 24,
    ):
        self._base_url = base_url or OPENROUTER_BASE_URL
        super().__init__(
            api_key=api_key,
            base_url=self._base_url,
            default_headers={
                "HTTP-Referer": "https://github.com/openyak/desktop",
                "X-Title": "OpenYak",
            },
        )
        self._api_key = api_key
        self._provider_id = provider_id
        self._enable_reasoning = enable_reasoning
        self._models_cache: list[ModelInfo] | None = None
        self._cache_timestamp: float | None = None  # Unix timestamp of last cache update
        self._cache_ttl_seconds = cache_ttl_hours * 3600  # Convert hours to seconds
        # Models that support reasoning — populated from list_models() cache.
        # Used to avoid sending unsupported `reasoning` param to models like MiniMax.
        self._reasoning_models: set[str] = set()

    @property
    def id(self) -> str:
        return self._provider_id

    async def list_models(self) -> list[ModelInfo]:
        """Fetch models from OpenRouter API.

        Uses cached models if available and not expired (default: 24 hours).
        Automatically refreshes if cache is stale.
        """
        # Check if cache exists and is still valid
        if self._models_cache is not None and self._cache_timestamp is not None:
            cache_age = time.time() - self._cache_timestamp
            if cache_age < self._cache_ttl_seconds:
                # Cache is still valid
                return self._models_cache
            else:
                # Cache expired
                logger.info(
                    "Model cache expired (age: %.1f hours, TTL: %.1f hours), refreshing...",
                    cache_age / 3600,
                    self._cache_ttl_seconds / 3600,
                )

        # Retry up to 2 times on transient network failures.
        # Auth errors (401) are NOT retried — they need a token refresh.
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        f"{self._base_url}/models",
                        headers={"Authorization": f"Bearer {self._api_key}"},
                        timeout=30.0,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    break
            except httpx.HTTPStatusError:
                raise  # Auth/client errors — don't retry, let caller handle
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
                last_exc = e
                if attempt < 2:
                    wait = 2 ** attempt  # 1s, 2s
                    logger.warning("OpenRouter model fetch attempt %d failed: %s — retrying in %ds", attempt + 1, e, wait)
                    import asyncio
                    await asyncio.sleep(wait)
        else:
            raise last_exc  # type: ignore[misc]

        models = []

        for m in data.get("data", []):
            model_id = m.get("id", "")
            pricing = m.get("pricing", {})

            context_length = m.get("context_length", 4096)
            top_provider = m.get("top_provider", {})

            # Detect capabilities from model metadata
            architecture = m.get("architecture", {})
            modality = architecture.get("modality", "")

            # Detect caching support based on model family
            supports_caching = False
            if "claude" in model_id.lower():
                supports_caching = True  # All Claude models support caching
            elif "minimax" in model_id.lower():
                supports_caching = True  # MiniMax M2.5+ supports caching
            elif "gpt-4" in model_id.lower() or "gpt-3.5" in model_id.lower():
                supports_caching = True  # OpenAI models support caching

            raw_name = m.get("name", model_id)

            models.append(
                ModelInfo(
                    id=model_id,
                    name=raw_name,
                    provider_id=self._provider_id,
                    capabilities=ModelCapabilities(
                        function_calling="tool" in str(m.get("supported_parameters", [])),
                        vision="image" in modality,
                        reasoning="reasoning" in model_id.lower()
                        or "think" in model_id.lower()
                        or "r1" in model_id.lower(),
                        json_output=True,
                        max_context=context_length,
                        max_output=top_provider.get("max_completion_tokens"),
                        prompt_caching=supports_caching,
                    ),
                    pricing=ModelPricing(
                        prompt=float(pricing.get("prompt", "0")) * 1_000_000,  # Convert per-token → per-million
                        completion=float(pricing.get("completion", "0")) * 1_000_000,  # Convert per-token → per-million
                    ),
                    metadata={
                        "description": m.get("description", ""),
                        "architecture": architecture,
                        "per_request_limits": m.get("per_request_limits"),
                    },
                )
            )

        self._models_cache = models
        self._cache_timestamp = time.time()  # Record when cache was updated
        # Update reasoning model set for stream_chat filtering
        self._reasoning_models = {m.id for m in models if m.capabilities.reasoning}
        logger.info(
            "Loaded %d models from OpenRouter (cache valid for %.1f hours)",
            len(models),
            self._cache_ttl_seconds / 3600,
        )
        return models

    def update_api_key(self, new_key: str) -> None:
        """Hot-swap the API key on the live provider.

        Updates both the httpx-based list_models path and the
        AsyncOpenAI client used by stream_chat.
        """
        self._api_key = new_key
        self._client = AsyncOpenAI(
            api_key=new_key,
            base_url=self._base_url,
            default_headers={
                "HTTP-Referer": "https://github.com/openyak/desktop",
                "X-Title": "OpenYak",
            },
        )
        self.clear_cache()

    def clear_cache(self) -> None:
        """Force re-fetch of models on next list_models() call."""
        self._models_cache = None
        self._cache_timestamp = None

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
        """Stream with OpenRouter-specific extras (reasoning support)."""
        merged_extra: dict[str, Any] = {}

        # Prioritize high-throughput providers
        merged_extra["provider"] = {"sort": "throughput"}

        # Enable reasoning only for models that support it.
        # Sending this to models like MiniMax M2.5 causes stream errors.
        if self._enable_reasoning and model in self._reasoning_models:
            merged_extra["reasoning"] = {"enabled": True}

        if extra_body:
            merged_extra.update(extra_body)

        async for chunk in super().stream_chat(
            model,
            messages,
            tools=tools,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_body=merged_extra if merged_extra else None,
            response_format=response_format,
        ):
            yield chunk
