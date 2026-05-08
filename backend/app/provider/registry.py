"""Provider registry — manages provider instances and model lookup."""

from __future__ import annotations

import asyncio
import logging

from app.provider.base import BaseProvider
from app.schemas.provider import ModelInfo, ProviderStatus
from app.session.utils import compute_effective_context_window

logger = logging.getLogger(__name__)

MODEL_REFRESH_TIMEOUT_SECONDS = 45.0

# Aggregator providers — their models should yield to direct providers
# when no explicit provider_id is given.
_AGGREGATOR_PROVIDERS = {"openrouter"}


def _provider_priority(provider_id: str) -> int:
    """Lower is better when deduplicating model IDs across providers."""
    if provider_id in _AGGREGATOR_PROVIDERS:
        return 1
    return 0


class ProviderRegistry:
    """Registry of LLM providers."""

    def __init__(self) -> None:
        self._providers: dict[str, BaseProvider] = {}
        # Quick lookup: model_id → best (provider, model) — used when no provider_id given
        self._model_index: dict[str, tuple[BaseProvider, ModelInfo]] = {}
        # Full list: ALL (provider, model) pairs — used for all_models() and provider-aware resolve
        self._full_models: list[tuple[BaseProvider, ModelInfo]] = []

    def register(self, provider: BaseProvider) -> None:
        """Register a provider."""
        self._providers[provider.id] = provider
        logger.info("Registered provider: %s", provider.id)

    def unregister(self, provider_id: str) -> None:
        """Remove a provider and its models from the index."""
        self._providers.pop(provider_id, None)
        self._model_index = {
            mid: (p, m)
            for mid, (p, m) in self._model_index.items()
            if p.id != provider_id
        }
        self._full_models = [
            (p, m) for p, m in self._full_models if p.id != provider_id
        ]
        logger.info("Unregistered provider: %s", provider_id)

    def get_provider(self, provider_id: str) -> BaseProvider | None:
        """Get provider by ID."""
        return self._providers.get(provider_id)

    async def refresh_models(self) -> dict[str, list[ModelInfo]]:
        """Refresh model lists from all providers."""
        result: dict[str, list[ModelInfo]] = {}
        new_index: dict[str, tuple[BaseProvider, ModelInfo]] = {}
        new_full: list[tuple[BaseProvider, ModelInfo]] = []

        failed: list[tuple[str, Exception]] = []
        refreshes = await asyncio.gather(
            *(
                self._refresh_provider_models(pid, provider)
                for pid, provider in self._providers.items()
            ),
        )
        for pid, provider, models, error in refreshes:
            if error is not None:
                logger.error("Failed to refresh models for %s: %s", pid, error)
                result[pid] = []
                failed.append((pid, error))
                continue

            result[pid] = models
            for m in models:
                metadata = dict(m.metadata or {})
                effective = compute_effective_context_window(
                    m.capabilities.max_context,
                    metadata.get("effective_context_window"),
                )
                if effective is not None:
                    metadata["effective_context_window"] = effective
                    m.metadata = metadata

                # Full list keeps everything (including duplicates)
                new_full.append((provider, m))

                # Quick index: direct providers win over aggregators
                existing = new_index.get(m.id)
                if existing is not None:
                    existing_priority = _provider_priority(existing[0].id)
                    new_priority = _provider_priority(pid)
                    if new_priority < existing_priority:
                        new_index[m.id] = (provider, m)
                else:
                    new_index[m.id] = (provider, m)

        if new_index or not failed:
            self._model_index = new_index
            self._full_models = new_full

        if failed and not new_index:
            raise failed[0][1]

        logger.info(
            "Model index: %d unique models, %d total across %d providers",
            len(self._model_index),
            len(self._full_models),
            len(self._providers),
        )
        return result

    async def _refresh_provider_models(
        self,
        pid: str,
        provider: BaseProvider,
    ) -> tuple[str, BaseProvider, list[ModelInfo], Exception | None]:
        try:
            provider.clear_cache()
            models = await asyncio.wait_for(
                provider.list_models(),
                timeout=MODEL_REFRESH_TIMEOUT_SECONDS,
            )
            return pid, provider, models, None
        except Exception as e:
            if isinstance(e, TimeoutError):
                e = TimeoutError(
                    f"Timed out refreshing models for {pid} after "
                    f"{MODEL_REFRESH_TIMEOUT_SECONDS:g}s"
                )
            return pid, provider, [], e

    def resolve_model(
        self,
        model_id: str,
        provider_id: str | None = None,
    ) -> tuple[BaseProvider, ModelInfo] | None:
        """Resolve a model ID to its provider and info.

        If provider_id is given, returns the model from that specific provider.
        Otherwise falls back to the default priority (direct > aggregator).
        """
        if provider_id:
            for p, m in self._full_models:
                if m.id == model_id and p.id == provider_id:
                    return (p, m)
            # Provider specified but not found — fall through to default
        return self._model_index.get(model_id)

    def all_models(self) -> list[ModelInfo]:
        """All models from all providers (includes duplicates from different providers)."""
        return [info for _, info in self._full_models]

    async def health(self) -> dict[str, ProviderStatus]:
        """Health check all providers."""
        result = {}
        for pid, provider in self._providers.items():
            result[pid] = await provider.health_check()
        return result
