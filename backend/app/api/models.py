"""Model listing endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.config import Settings
from app.dependencies import ProviderRegistryDep, SettingsDep
from app.provider.registry import ProviderRegistry
from app.schemas.provider import ModelInfo

logger = logging.getLogger(__name__)

router = APIRouter()


async def _refresh_with_token_retry(
    registry: ProviderRegistry,
    settings: Settings,
) -> dict[str, list]:
    """Refresh models, auto-refreshing the proxy JWT on 401.

    If the refresh fails with an auth error (expired JWT) and we have a
    stored refresh token, we transparently refresh the access token and
    retry once — the same pattern used at startup in main.py.
    """
    try:
        return await registry.refresh_models()
    except Exception as e:
        # Check if this is a 401 auth error from the proxy
        if "401" not in str(e):
            logger.warning("Model refresh failed (non-auth): %s", e)
            return {}

        # Try refreshing the proxy JWT
        if not (settings.proxy_url and getattr(settings, "proxy_refresh_token", "")):
            logger.warning("Model refresh failed (401) but no refresh token available: %s", e)
            return {}

        logger.info("Model refresh got 401 — attempting proxy token refresh")
        from app.provider.proxy_auth import refresh_proxy_token

        if not await refresh_proxy_token(settings, registry):
            logger.warning("Proxy token refresh failed — cannot reload models")
            return {}

        # Retry with the new token
        try:
            return await registry.refresh_models()
        except Exception as e2:
            logger.warning("Model refresh still failed after token refresh: %s", e2)
            return {}


@router.get("/models", response_model=list[ModelInfo])
async def list_models(
    registry: ProviderRegistryDep,
    settings: SettingsDep,
) -> list[ModelInfo]:
    """List all available models from registered providers.

    If the model index is empty (e.g. startup fetch failed), attempts a
    single refresh before returning so users don't see an empty list.
    """
    models = registry.all_models()
    if not models:
        logger.info("Model index empty — attempting auto-refresh")
        await _refresh_with_token_retry(registry, settings)
        models = registry.all_models()
    return models


@router.post("/models/refresh")
async def refresh_models(
    registry: ProviderRegistryDep,
    settings: SettingsDep,
) -> dict:
    """Force re-fetch model lists from all providers (also refreshes models.dev)."""
    # Refresh models.dev catalog first so providers pick up latest data
    from app.provider.models_dev import models_dev
    await models_dev.refresh()

    result = await _refresh_with_token_retry(registry, settings)
    counts = {pid: len(models) for pid, models in result.items()}
    return {"refreshed": counts}
