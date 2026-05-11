"""Model listing endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.dependencies import ProviderRegistryDep
from app.provider.registry import ProviderRegistry
from app.schemas.provider import ModelInfo

logger = logging.getLogger(__name__)

router = APIRouter()


async def _refresh_with_token_retry(
    registry: ProviderRegistry,
) -> dict[str, list]:
    try:
        return await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed: %s", e)
        return {}


@router.get("/models", response_model=list[ModelInfo])
async def list_models(
    registry: ProviderRegistryDep,
) -> list[ModelInfo]:
    """List all available models from registered providers.

    If the model index is empty (e.g. startup fetch failed), attempts a
    single refresh before returning so users don't see an empty list.
    """
    models = registry.all_models()
    if not models:
        logger.info("Model index empty — attempting auto-refresh")
        await _refresh_with_token_retry(registry)
        models = registry.all_models()
    return models


@router.post("/models/refresh")
async def refresh_models(
    registry: ProviderRegistryDep,
) -> dict:
    """Force re-fetch model lists from all providers (also refreshes models.dev)."""
    # Refresh models.dev catalog first so providers pick up latest data
    from app.provider.models_dev import models_dev
    await models_dev.refresh()

    result = await _refresh_with_token_retry(registry)
    counts = {pid: len(models) for pid, models in result.items()}
    return {"refreshed": counts}
