"""Generic OpenAI-compatible provider.

Works with any provider that implements the /v1/chat/completions API:
OpenAI, Groq, DeepSeek, Mistral, xAI, Together AI, etc.

Model metadata is sourced from models.dev (remote, cached hourly),
with fallback to yakAgent's hardcoded catalog, then to the provider's
own /v1/models API endpoint.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from app.provider.openai_compat import OpenAICompatProvider
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ModelPricing,
    ProviderStatus,
)

logger = logging.getLogger(__name__)


class GenericOpenAIProvider(OpenAICompatProvider):
    """OpenAI-compatible provider with configurable provider ID and known models."""

    def __init__(
        self,
        api_key: str,
        *,
        provider_id: str,
        base_url: str,
        default_headers: dict[str, str] | None = None,
    ):
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            default_headers=default_headers,
        )
        self._api_key = api_key
        self._provider_id = provider_id
        self._models_cache: list[ModelInfo] | None = None

    @property
    def id(self) -> str:
        return self._provider_id

    async def list_models(self) -> list[ModelInfo]:
        """Return models with metadata. Merges models.dev + yakAgent catalog + API."""
        if self._models_cache is not None:
            return self._models_cache

        # 1. Start with models.dev (remote, cached, best pricing) unless it is a custom dynamic provider
        models = []
        seen_ids = set()
        if not self._provider_id.startswith("custom_"):
            models = await self._load_models_dev()
            seen_ids = {m.id for m in models}

            # 2. Merge yakAgent catalog (fills gaps for models.dev doesn't cover)
            for m in self._load_catalog_models():
                if m.id not in seen_ids:
                    models.append(m)
                    seen_ids.add(m.id)

        # 3. Last resort: provider's own /v1/models API (no pricing)
        if not models:
            models = await self._fetch_api_models()

        self._models_cache = models
        return models

    def clear_cache(self) -> None:
        self._models_cache = None

    async def _load_models_dev(self) -> list[ModelInfo]:
        """Load models from models.dev (remote source of truth)."""
        try:
            from app.provider.models_dev import models_dev

            raw_models = await models_dev.get_models(self._provider_id)
            if not raw_models:
                return []

            models = []
            for m in raw_models:
                caps = m.get("capabilities", {})
                pricing = m.get("pricing", {})
                models.append(ModelInfo(
                    id=m["id"],
                    name=m.get("name", m["id"]),
                    provider_id=self._provider_id,
                    capabilities=ModelCapabilities(
                        function_calling=caps.get("function_calling", True),
                        vision=caps.get("vision", False),
                        reasoning=caps.get("reasoning", False),
                        json_output=caps.get("json_output", False),
                        max_context=caps.get("max_context", 128_000),
                        max_output=caps.get("max_output"),
                        prompt_caching=caps.get("prompt_caching", False),
                    ),
                    pricing=ModelPricing(
                        prompt=pricing.get("prompt", 0),
                        completion=pricing.get("completion", 0),
                    ),
                    metadata=m.get("metadata", {}),
                ))
            logger.debug("models.dev: loaded %d models for %s", len(models), self._provider_id)
            return models
        except Exception as e:
            logger.debug("models.dev unavailable for %s: %s", self._provider_id, e)
            return []

    def _load_catalog_models(self) -> list[ModelInfo]:
        """Fallback: load from yakAgent hardcoded catalog."""
        try:
            from yakagent.provider.catalog import PROVIDERS

            pdef = PROVIDERS.get(self._provider_id)
            if pdef is None or not pdef.models:
                return []

            models = []
            for model_id, info in pdef.models.items():
                models.append(ModelInfo(
                    id=model_id,
                    name=info.get("name", model_id),
                    provider_id=self._provider_id,
                    capabilities=ModelCapabilities(
                        function_calling=True,
                        vision=info.get("vision", False),
                        reasoning=info.get("reasoning", False),
                        max_context=info.get("context", 128_000),
                        max_output=info.get("output", 8192),
                    ),
                    pricing=ModelPricing(
                        prompt=info.get("prompt", 0),
                        completion=info.get("completion", 0),
                    ),
                ))
            return models
        except ImportError:
            return []

    async def _fetch_api_models(self) -> list[ModelInfo]:
        """Last resort: fetch models from the provider's /v1/models endpoint."""
        try:
            response = await self._client.models.list()
            models = []
            for m in response.data:
                ctx = _infer_context_from_name(m.id)
                models.append(ModelInfo(
                    id=m.id,
                    name=m.id,
                    provider_id=self._provider_id,
                    capabilities=ModelCapabilities(
                        function_calling=True,
                        max_context=ctx,
                    ),
                ))
            return models
        except Exception as e:
            logger.warning("Failed to fetch models from %s API: %s", self._provider_id, e)
            return []


# ---------------------------------------------------------------------------
# Context-window inference from model name
# ---------------------------------------------------------------------------

# Explicit size suffixes: "128k", "1m", "256K", etc.
_CTX_SUFFIX_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([mkMK])\b")

# Well-known model families → default context windows
_FAMILY_CONTEXT: list[tuple[re.Pattern[str], int]] = [
    (re.compile(r"gpt-?5", re.I), 400_000),
    (re.compile(r"gpt-?4\.?1", re.I), 1_047_576),
    (re.compile(r"gpt-?4o|gpt-?4-?turbo", re.I), 128_000),
    (re.compile(r"gpt-?4", re.I), 128_000),
    (re.compile(r"gpt-?3\.?5", re.I), 16_385),
    (re.compile(r"o[1-9]|o\d+-", re.I), 200_000),
    (re.compile(r"claude", re.I), 200_000),
    (re.compile(r"gemini", re.I), 1_048_576),
    (re.compile(r"llama-?3", re.I), 128_000),
    (re.compile(r"llama-?4", re.I), 128_000),
    (re.compile(r"qwen", re.I), 131_072),
    (re.compile(r"deepseek", re.I), 128_000),
    (re.compile(r"mistral.*large|codestral|pixtral", re.I), 128_000),
    (re.compile(r"mistral", re.I), 32_000),
    (re.compile(r"command-r", re.I), 128_000),
    (re.compile(r"phi-?[34]", re.I), 128_000),
    (re.compile(r"gemma", re.I), 128_000),
]

_DEFAULT_FALLBACK_CONTEXT = 128_000  # Modern models are rarely < 32k


def _infer_context_from_name(model_id: str) -> int:
    """Best-effort context-window inference from a model ID string.

    1. Explicit size in name (e.g. ``llama-3-128k``)
    2. Known model family pattern
    3. Conservative modern default (128 000)
    """
    # 1. Explicit suffix like "128k" or "1m"
    match = _CTX_SUFFIX_RE.search(model_id)
    if match:
        num = float(match.group(1))
        unit = match.group(2).lower()
        multiplier = 1_000_000 if unit == "m" else 1_000
        return int(num * multiplier)

    # 2. Known family
    for pattern, ctx in _FAMILY_CONTEXT:
        if pattern.search(model_id):
            return ctx

    # 3. Reasonable default for unknown modern models
    return _DEFAULT_FALLBACK_CONTEXT
