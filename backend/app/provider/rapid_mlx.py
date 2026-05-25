"""Rapid-MLX local provider for Apple Silicon Macs."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.provider.openai_compat import OpenAICompatProvider
from app.rapid_mlx.catalog import rapid_mlx_model_supports_vision
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ModelPricing,
    ProviderStatus,
)

logger = logging.getLogger(__name__)

PROVIDER_ID = "rapid-mlx"
DEFAULT_BASE_URL = "http://localhost:18080/v1"
DEFAULT_MODEL = "qwen3.5-4b"
LEGACY_DEFAULT_MODEL = "default"


def normalize_rapid_mlx_model(name: str | None) -> str:
    """Map old OpenYak defaults to a real rapid-mlx alias."""
    value = (name or "").strip().removeprefix(f"{PROVIDER_ID}/").strip()
    if not value or value == LEGACY_DEFAULT_MODEL:
        return DEFAULT_MODEL
    return value


def _model_id(name: str) -> str:
    normalized = normalize_rapid_mlx_model(name)
    return normalized if normalized.startswith(f"{PROVIDER_ID}/") else f"{PROVIDER_ID}/{normalized}"


def _model_name(name: str) -> str:
    normalized = normalize_rapid_mlx_model(name)
    return "Rapid-MLX Qwen 3.5 4B" if normalized == DEFAULT_MODEL else normalized


def _rapid_capabilities(model: str = DEFAULT_MODEL) -> ModelCapabilities:
    return ModelCapabilities(
        function_calling=True,
        vision=rapid_mlx_model_supports_vision(model),
        reasoning=True,
        json_output=True,
        max_context=32_768,
        max_output=8_192,
        prompt_caching=True,
    )


class RapidMLXProvider(OpenAICompatProvider):
    """OpenAI-compatible provider backed by ``rapid-mlx serve``."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL):
        self._base_url = base_url.rstrip("/")
        super().__init__(
            api_key="not-needed",
            base_url=self._base_url,
            is_custom=True,
        )
        self._models_cache: list[ModelInfo] | None = None

    @property
    def id(self) -> str:  # noqa: A003
        return PROVIDER_ID

    async def list_models(self) -> list[ModelInfo]:
        if self._models_cache is not None:
            return self._models_cache

        models: list[ModelInfo] = []
        try:
            response = await self._client.models.list()
            seen: set[str] = set()
            for item in response.data:
                name = normalize_rapid_mlx_model(item.id or DEFAULT_MODEL)
                if name in seen:
                    continue
                seen.add(name)
                models.append(
                    ModelInfo(
                        id=_model_id(name),
                        name=_model_name(name),
                        provider_id=self.id,
                        capabilities=_rapid_capabilities(name),
                        pricing=ModelPricing(prompt=0.0, completion=0.0),
                        metadata={"local": True},
                    )
                )
        except Exception as exc:
            logger.debug(
                "Rapid-MLX: /v1/models unavailable: %s",
                exc,
            )
            return []

        self._models_cache = models
        return models

    async def stream_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        **kwargs: Any,
    ):
        bare_model = normalize_rapid_mlx_model(model)
        async for chunk in super().stream_chat(bare_model, messages, **kwargs):
            yield chunk

    async def health_check(self) -> ProviderStatus:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self._base_url}/models")
                resp.raise_for_status()
                data = resp.json()
            return ProviderStatus(
                status="connected",
                model_count=len(data.get("data", [])) or 1,
            )
        except Exception as exc:
            return ProviderStatus(status="error", error=str(exc))

    def clear_cache(self) -> None:
        self._models_cache = None
