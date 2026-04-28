"""Configuration management endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_custom_endpoints
from app.dependencies import ProviderRegistryDep, SettingsDep
from app.provider.catalog import PROVIDER_CATALOG
from app.provider.factory import create_provider as create_desktop_provider
from app.provider.local import (
    LOCAL_BASE_URL_ENV,
    LOCAL_PROVIDER_ID,
    create_local_provider,
)
from app.provider.openrouter import OpenRouterProvider
from app.schemas.provider import (
    ApiKeyStatus,
    ApiKeyUpdate,
    CustomEndpointConfig,
    CustomEndpointCreate,
    CustomEndpointUpdate,
    ProviderInfo,
    ProviderKeyUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_custom_endpoints_lock = asyncio.Lock()

# Persist runtime config in current working directory.
#
# Desktop mode (`run.py`) changes cwd to the app data directory, so this
# becomes a writable per-user `.env` (instead of the read-only app bundle path
# when running from a mounted DMG volume).
# Server mode runs with `/opt/openyak-proxy` as working directory, so behavior
# remains compatible there as well.
_ENV_PATH = Path(".env")


def _mask_key(key: str) -> str:
    """Mask API key for display: show first 7 and last 4 chars."""
    if len(key) <= 11:
        return "****"
    return f"{key[:7]}...{key[-4:]}"


def _build_custom_endpoint_info(
    ce: dict[str, Any],
    *,
    enabled: bool,
    status: str,
    model_count: int = 0,
) -> ProviderInfo:
    """Build ProviderInfo for a custom endpoint."""
    return ProviderInfo(
        id=ce["id"],
        name=ce.get("name", "Custom Endpoint"),
        is_configured=True,
        enabled=enabled,
        masked_key=_mask_key(ce.get("api_key", "")) if ce.get("api_key") else None,
        model_count=model_count,
        status=status,
        base_url=ce.get("base_url"),
    )


def _update_env_file(key: str, value: str) -> None:
    """Update or add a key=value pair in the backend .env file.

    Values are single-quoted to prevent python-dotenv from interpreting
    special characters (``#`` as inline comments, whitespace stripping, etc.).
    """
    lines: list[str] = []
    found = False
    # Single-quote the value; escape any embedded single quotes.
    escaped = value.replace("'", "'\\''")
    entry = f"{key}='{escaped}'"

    if _ENV_PATH.exists():
        lines = _ENV_PATH.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if line.startswith(f"{key}=") or line.startswith(f"{key} ="):
                lines[i] = entry
                found = True
                break

    if not found:
        lines.append(entry)

    _ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _remove_env_key(key: str) -> None:
    """Remove a key from the backend .env file entirely."""
    if not _ENV_PATH.exists():
        return
    lines = _ENV_PATH.read_text(encoding="utf-8").splitlines()
    lines = [l for l in lines if not l.startswith(f"{key}=") and not l.startswith(f"{key} =")]
    _ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


class LocalProviderStatus(BaseModel):
    """Status for the locally-configured OpenAI-compatible endpoint."""

    base_url: str = ""
    is_configured: bool = False
    is_connected: bool = False
    status: str = "unconfigured"  # "connected" | "error" | "unconfigured"


class LocalProviderUpdate(BaseModel):
    """Request payload for configuring the local endpoint."""

    base_url: str


def _normalize_local_base_url(value: str) -> str:
    """Normalize user input and ensure it includes a scheme."""
    trimmed = value.strip()
    if not trimmed:
        raise HTTPException(400, "Base URL cannot be empty")
    parsed = urlparse(trimmed)
    if not parsed.scheme or not parsed.netloc:
        raise HTTPException(400, "Base URL must include http:// or https://")
    return trimmed.rstrip("/")


def _local_provider_status(settings: Any, registry: Any) -> LocalProviderStatus:
    """Build a status object from the current configuration + registry state."""
    base_url = settings.local_base_url or ""
    provider = registry.get_provider(LOCAL_PROVIDER_ID)
    is_connected = bool(base_url and provider)
    status = "connected" if is_connected else ("error" if base_url else "unconfigured")
    return LocalProviderStatus(
        base_url=base_url,
        is_configured=bool(base_url),
        is_connected=is_connected,
        status=status,
    )


@router.get("/config/api-key", response_model=ApiKeyStatus)
async def get_api_key_status(registry: ProviderRegistryDep) -> ApiKeyStatus:
    """Get the current API key configuration status."""
    provider = registry.get_provider("openrouter")

    if provider is None or not getattr(provider, "_api_key", ""):
        return ApiKeyStatus(is_configured=False)

    return ApiKeyStatus(
        is_configured=True,
        masked_key=_mask_key(provider._api_key),
    )


@router.post("/config/api-key", response_model=ApiKeyStatus)
async def update_api_key(registry: ProviderRegistryDep, body: ApiKeyUpdate) -> ApiKeyStatus:
    """Update the OpenRouter API key, validate it, and re-initialize the provider."""
    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="API key cannot be empty")

    # Validate by attempting to fetch models with the new key
    test_provider = OpenRouterProvider(api_key)
    try:
        models = await test_provider.list_models()
        if not models:
            raise HTTPException(
                status_code=400,
                detail="API key is valid but returned no models",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("API key validation failed: %s", e)
        raise HTTPException(
            status_code=400,
            detail=f"API key validation failed: {e}",
        )

    # Key is valid — replace the provider in the registry
    new_provider = OpenRouterProvider(api_key)
    registry.register(new_provider)

    # Refresh the model index so the frontend picks up the new models
    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after API key update: %s — will retry on next request", e)

    # Persist to .env so it survives restarts
    _update_env_file("OPENYAK_OPENROUTER_API_KEY", api_key)

    return ApiKeyStatus(
        is_configured=True,
        masked_key=_mask_key(api_key),
        is_valid=True,
    )


@router.delete("/config/api-key", response_model=ApiKeyStatus)
async def delete_api_key(settings: SettingsDep, registry: ProviderRegistryDep) -> ApiKeyStatus:
    """Delete the stored OpenRouter API key."""
    settings.openrouter_api_key = ""
    _remove_env_key("OPENYAK_OPENROUTER_API_KEY")

    # Only unregister the provider if not in proxy mode.
    # In proxy mode the active "openrouter" provider belongs to the proxy,
    # not the direct API key — don't remove it.
    if not (settings.proxy_url and settings.proxy_token):
        registry.unregister("openrouter")

    return ApiKeyStatus(is_configured=False)


# ── OpenYak Account (proxy mode) ───────────────────────────────────────────

class OpenYakAccountStatus(BaseModel):
    is_connected: bool = False
    proxy_url: str = ""
    email: str = ""
    has_refresh_token: bool = False


class OpenYakAccountConnect(BaseModel):
    proxy_url: str  # e.g. "https://api.openyak.app"
    token: str  # JWT from proxy auth
    refresh_token: str = ""  # Refresh token for auto-renewal


class OpenYakAccountDisconnect(BaseModel):
    pass


def _is_unauthorized_error(exc: Exception) -> bool:
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 401


async def _refresh_openyak_proxy_token(
    proxy_url: str,
    refresh_token: str,
) -> tuple[str, str] | None:
    """Refresh an OpenYak proxy access token without mutating persisted settings."""
    if not refresh_token:
        return None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{proxy_url}/api/auth/refresh",
                json={"refresh_token": refresh_token},
                timeout=15.0,
            )
    except Exception as exc:
        logger.warning("OpenYak token refresh failed: %s", exc)
        return None

    if resp.status_code != 200:
        logger.warning(
            "OpenYak token refresh rejected: HTTP %d - %s",
            resp.status_code,
            resp.text[:200],
        )
        return None

    data = resp.json()
    access_token = data.get("access_token", "")
    if not access_token:
        logger.warning("OpenYak token refresh returned empty access_token")
        return None

    return access_token, data.get("refresh_token", "") or refresh_token


@router.get("/config/openyak-account", response_model=OpenYakAccountStatus)
async def get_openyak_account_status(settings: SettingsDep) -> OpenYakAccountStatus:
    """Check if an OpenYak account is connected (proxy mode active)."""
    if settings.proxy_url and settings.proxy_token:
        return OpenYakAccountStatus(
            is_connected=True,
            proxy_url=settings.proxy_url,
            has_refresh_token=bool(settings.proxy_refresh_token),
        )
    return OpenYakAccountStatus(is_connected=False)


@router.post("/config/openyak-account", response_model=OpenYakAccountStatus)
async def connect_openyak_account(
    settings: SettingsDep, registry: ProviderRegistryDep, body: OpenYakAccountConnect,
) -> OpenYakAccountStatus:
    """Connect an OpenYak account: switch provider to proxy mode.

    The local app will now route all LLM requests through the OpenYak
    cloud proxy, which handles billing transparently.
    """
    proxy_url = body.proxy_url.rstrip("/")
    token = body.token.strip()

    if not proxy_url or not token:
        raise HTTPException(400, "proxy_url and token are required")

    # Validate by trying to list models through the proxy. Existing desktop
    # installs may hold an expired access token while still having a valid
    # refresh token, so refresh once on 401 before asking the user to sign in.
    refresh_token = body.refresh_token.strip()

    async def _list_proxy_models(access_token: str):
        test_provider = OpenRouterProvider(access_token, base_url=proxy_url + "/v1", provider_id="openyak-proxy")
        return await test_provider.list_models()

    try:
        models = await _list_proxy_models(token)
    except HTTPException:
        raise
    except Exception as e:
        if _is_unauthorized_error(e) and refresh_token:
            refreshed = await _refresh_openyak_proxy_token(proxy_url, refresh_token)
            if not refreshed:
                raise HTTPException(400, "OpenYak session expired. Please sign in again.") from e
            token, refresh_token = refreshed
            try:
                models = await _list_proxy_models(token)
            except Exception as retry_error:
                logger.warning("OpenYak account connection failed after token refresh: %s", retry_error)
                raise HTTPException(400, f"Failed to connect to proxy: {retry_error}") from retry_error
        else:
            logger.warning("OpenYak account connection failed: %s", e)
            raise HTTPException(400, f"Failed to connect to proxy: {e}") from e

    if not models:
        raise HTTPException(400, "Proxy returned no models")

    # Switch the provider registry to use the proxy
    new_provider = OpenRouterProvider(token, base_url=proxy_url + "/v1", provider_id="openyak-proxy")
    registry.register(new_provider)
    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after proxy connect: %s — will retry on next request", e)

    # Persist to .env and update runtime settings
    _update_env_file("OPENYAK_PROXY_URL", proxy_url)
    _update_env_file("OPENYAK_PROXY_TOKEN", token)
    settings.proxy_url = proxy_url
    settings.proxy_token = token

    if refresh_token:
        _update_env_file("OPENYAK_PROXY_REFRESH_TOKEN", refresh_token)
        settings.proxy_refresh_token = refresh_token

    return OpenYakAccountStatus(is_connected=True, proxy_url=proxy_url)


@router.delete("/config/openyak-account", response_model=OpenYakAccountStatus)
async def disconnect_openyak_account(settings: SettingsDep, registry: ProviderRegistryDep) -> OpenYakAccountStatus:
    """Disconnect OpenYak account: revert to local API key mode."""
    # Clear proxy settings
    settings.proxy_url = ""
    settings.proxy_token = ""
    settings.proxy_refresh_token = ""
    _update_env_file("OPENYAK_PROXY_URL", "")
    _update_env_file("OPENYAK_PROXY_TOKEN", "")
    _remove_env_key("OPENYAK_PROXY_REFRESH_TOKEN")

    # Unregister proxy provider
    registry.unregister("openyak-proxy")

    return OpenYakAccountStatus(is_connected=False)


# ── Ollama (Local LLM) ────────────────────────────────────────────────────


class OllamaStatus(BaseModel):
    is_configured: bool = False
    base_url: str | None = None
    model_count: int = 0
    error: str | None = None


class OllamaConnect(BaseModel):
    base_url: str = "http://localhost:11434"


@router.get("/config/ollama", response_model=OllamaStatus)
async def get_ollama_status(settings: SettingsDep, registry: ProviderRegistryDep) -> OllamaStatus:
    """Get the current Ollama configuration status."""
    provider = registry.get_provider("ollama")

    if provider is None or not settings.ollama_base_url:
        return OllamaStatus(is_configured=False)

    # Check live connectivity
    status = await provider.health_check()
    return OllamaStatus(
        is_configured=True,
        base_url=settings.ollama_base_url,
        model_count=status.model_count,
        error=status.error,
    )


@router.post("/config/ollama", response_model=OllamaStatus)
async def connect_ollama(
    settings: SettingsDep, registry: ProviderRegistryDep, body: OllamaConnect,
) -> OllamaStatus:
    """Connect to an Ollama instance: validate, register provider, persist."""
    from app.provider.ollama import OllamaProvider

    base_url = body.base_url.strip().rstrip("/")
    if not base_url:
        raise HTTPException(400, "base_url cannot be empty")

    # Validate by health-checking the target URL
    test_provider = OllamaProvider(base_url=base_url)
    status = await test_provider.health_check()
    if status.status != "connected":
        raise HTTPException(
            400,
            f"Cannot connect to Ollama at {base_url}: {status.error or 'unknown error'}",
        )

    # Register (replaces any prior Ollama provider)
    registry.register(test_provider)
    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after Ollama connect: %s", e)

    # Persist to .env and runtime settings
    _update_env_file("OPENYAK_OLLAMA_BASE_URL", base_url)
    settings.ollama_base_url = base_url

    return OllamaStatus(
        is_configured=True,
        base_url=base_url,
        model_count=status.model_count,
    )


@router.delete("/config/ollama", response_model=OllamaStatus)
async def disconnect_ollama(settings: SettingsDep, registry: ProviderRegistryDep) -> OllamaStatus:
    """Disconnect Ollama: remove provider and clear config."""
    settings.ollama_base_url = ""
    _remove_env_key("OPENYAK_OLLAMA_BASE_URL")

    registry.unregister("ollama")

    return OllamaStatus(is_configured=False)


# ── Generic Multi-Provider API ─────────────────────────────────────────────


def _get_disabled_set(settings) -> set[str]:
    return {s.strip() for s in settings.disabled_providers.split(",") if s.strip()}


@router.get("/config/providers", response_model=list[ProviderInfo])
async def list_providers(settings: SettingsDep, registry: ProviderRegistryDep) -> list[ProviderInfo]:
    """List all BYOK providers with their configuration status."""
    disabled = _get_disabled_set(settings)

    result: list[ProviderInfo] = []
    for pid, pdef in PROVIDER_CATALOG.items():
        api_key = getattr(settings, pdef.settings_key, "")
        is_disabled = pid in disabled
        provider = registry.get_provider(pid)

        base_url = None
        if pdef.kind == "openai_compat_azure":
            base_url = getattr(settings, "azure_openai_base_url", "")

        if api_key and is_disabled:
            result.append(ProviderInfo(
                id=pid,
                name=pdef.name,
                is_configured=True,
                enabled=False,
                masked_key=_mask_key(api_key),
                status="disabled",
                base_url=base_url,
            ))
        elif provider and api_key:
            models = [m for p, m in registry._full_models if m.provider_id == pid]
            result.append(ProviderInfo(
                id=pid,
                name=pdef.name,
                is_configured=True,
                enabled=True,
                masked_key=_mask_key(api_key),
                model_count=len(models),
                status="connected",
                base_url=base_url,
            ))
        elif api_key:
            result.append(ProviderInfo(
                id=pid,
                name=pdef.name,
                is_configured=True,
                enabled=True,
                masked_key=_mask_key(api_key),
                status="error",
                base_url=base_url,
            ))
        else:
            result.append(ProviderInfo(
                id=pid,
                name=pdef.name,
                is_configured=False,
                enabled=not is_disabled,
                status="unconfigured",
                base_url=base_url,
            ))


    # Inject Custom Endpoints
    for ce in get_custom_endpoints(settings):
        pid = ce["id"]
        is_disabled = pid in disabled or not ce.get("enabled", True)
        provider = registry.get_provider(pid)

        if is_disabled:
            result.append(_build_custom_endpoint_info(ce, enabled=False, status="disabled"))
        elif provider:
            models = [m for p, m in registry._full_models if m.provider_id == pid]
            result.append(_build_custom_endpoint_info(ce, enabled=True, status="connected", model_count=len(models)))
        else:
            result.append(_build_custom_endpoint_info(ce, enabled=True, status="error"))

    return result


@router.post("/config/providers/{provider_id}/key", response_model=ProviderInfo)
async def set_provider_key(
    provider_id: str, body: ProviderKeyUpdate, settings: SettingsDep, registry: ProviderRegistryDep,
) -> ProviderInfo:
    """Set/update API key for a provider. Validates, registers, and persists."""
    pdef = PROVIDER_CATALOG.get(provider_id)
    if not pdef:
        raise HTTPException(404, f"Unknown provider: {provider_id}")

    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(400, "API key cannot be empty")

    # Azure needs a base_url from the request body or existing settings
    extra_kwargs: dict[str, str] = {}
    if pdef.kind in ("openai_compat_azure",):
        url_setting_map = {
            "openai_compat_azure": "azure_openai_base_url",
        }
        url_setting = url_setting_map[pdef.kind]
        base_url = getattr(body, "base_url", None) or getattr(settings, url_setting, "")
        if not base_url:
            raise HTTPException(400, f"{pdef.name} requires a base_url to be set")
        extra_kwargs["base_url"] = base_url

        # Persist base_url
        setattr(settings, url_setting, base_url)
        _update_env_file(f"OPENYAK_{url_setting.upper()}", base_url)

    # Validate by creating a test provider and listing models
    try:
        test_provider = create_desktop_provider(provider_id, api_key, **extra_kwargs)
        models = await test_provider.list_models()
    except ImportError as e:
        raise HTTPException(
            400,
            f"Provider '{provider_id}' requires an additional package: {e}",
        )
    except Exception as e:
        logger.warning("API key validation failed for %s: %s", provider_id, e)
        raise HTTPException(400, f"API key validation failed: {e}")

    # Register in the registry (replaces any existing instance)
    new_provider = create_desktop_provider(provider_id, api_key, **extra_kwargs)
    registry.register(new_provider)

    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning(
            "Model refresh failed after %s key update: %s — will retry on next request",
            provider_id, e,
        )

    # Persist to .env
    env_key = f"OPENYAK_{pdef.settings_key.upper()}"
    _update_env_file(env_key, api_key)

    # Update runtime settings
    setattr(settings, pdef.settings_key, api_key)

    return ProviderInfo(
        id=provider_id,
        name=pdef.name,
        is_configured=True,
        masked_key=_mask_key(api_key),
        model_count=len(models),
        status="connected",
        base_url=extra_kwargs.get("base_url"),
    )


@router.delete("/config/providers/{provider_id}/key", response_model=ProviderInfo)
async def delete_provider_key(
    provider_id: str, settings: SettingsDep, registry: ProviderRegistryDep,
) -> ProviderInfo:
    """Remove API key for a provider."""
    pdef = PROVIDER_CATALOG.get(provider_id)
    if not pdef:
        raise HTTPException(404, f"Unknown provider: {provider_id}")

    # Clear runtime settings
    setattr(settings, pdef.settings_key, "")

    # Remove from .env
    env_key = f"OPENYAK_{pdef.settings_key.upper()}"
    _remove_env_key(env_key)

    if pdef.kind == "openai_compat_azure":
        settings.azure_openai_base_url = ""
        _remove_env_key("OPENYAK_AZURE_OPENAI_BASE_URL")

    # Unregister provider
    registry.unregister(provider_id)

    return ProviderInfo(
        id=provider_id,
        name=pdef.name,
        is_configured=False,
        status="unconfigured",
    )


@router.post("/config/providers/{provider_id}/toggle", response_model=ProviderInfo)
async def toggle_provider(
    provider_id: str, settings: SettingsDep, registry: ProviderRegistryDep,
) -> ProviderInfo:
    """Enable or disable a provider. Disabled providers keep their key but aren't used."""
    pdef = PROVIDER_CATALOG.get(provider_id)
    if not pdef:
        raise HTTPException(404, f"Unknown provider: {provider_id}")
    disabled = _get_disabled_set(settings)

    api_key = getattr(settings, pdef.settings_key, "")
    is_currently_disabled = provider_id in disabled

    if is_currently_disabled:
        # Enable: remove from disabled list, register provider
        disabled.discard(provider_id)
        if api_key:
            try:
                extra_kwargs: dict[str, str] = {}
                if pdef.kind == "openai_compat_azure":
                    azure_url = getattr(settings, "azure_openai_base_url", "")
                    if azure_url:
                        extra_kwargs["base_url"] = azure_url
                provider = create_desktop_provider(provider_id, api_key, **extra_kwargs)
                registry.register(provider)
                await registry.refresh_models()
            except Exception as e:
                logger.warning("Failed to enable provider %s: %s", provider_id, e)
    else:
        # Disable: add to disabled list, unregister provider
        disabled.add(provider_id)
        registry.unregister(provider_id)

    # Persist disabled list
    settings.disabled_providers = ",".join(sorted(disabled))
    _update_env_file("OPENYAK_DISABLED_PROVIDERS", settings.disabled_providers)

    # Build response
    provider = registry.get_provider(provider_id)
    new_enabled = provider_id not in disabled
    if new_enabled and provider and api_key:
        models = [m for p, m in registry._full_models if m.provider_id == provider_id]
        return ProviderInfo(
            id=provider_id, name=pdef.name, is_configured=True, enabled=True,
            masked_key=_mask_key(api_key), model_count=len(models), status="connected",
        )
    elif api_key and not new_enabled:
        return ProviderInfo(
            id=provider_id, name=pdef.name, is_configured=True, enabled=False,
            masked_key=_mask_key(api_key), status="disabled",
        )
    else:
        return ProviderInfo(
            id=provider_id, name=pdef.name, is_configured=bool(api_key),
            enabled=new_enabled, status="unconfigured",
        )


@router.post("/config/custom", response_model=ProviderInfo)
async def create_custom_endpoint(
    body: CustomEndpointCreate, settings: SettingsDep, registry: ProviderRegistryDep
) -> ProviderInfo:
    """Create a new custom endpoint."""
    base_url = body.base_url
    api_key = body.api_key.strip() if body.api_key else ""
    name = body.name.strip() or "Custom Endpoint"

    endpoint_id = f"custom_{uuid.uuid4().hex[:8]}"

    try:
        test_provider = create_desktop_provider(endpoint_id, api_key, base_url=base_url)
        models = await test_provider.list_models()
    except Exception as e:
        logger.warning("Failed validation for custom endpoint %s: %s", name, e)
        raise HTTPException(400, f"Validation failed: {e}")

    async with _custom_endpoints_lock:
        endpoints = get_custom_endpoints(settings)
        new_config = {
            "id": endpoint_id,
            "name": name,
            "base_url": base_url,
            "api_key": api_key,
            "enabled": True
        }
        endpoints.append(new_config)

        settings.custom_endpoints = json.dumps(endpoints)
        _update_env_file("OPENYAK_CUSTOM_ENDPOINTS", settings.custom_endpoints)

    registry.register(test_provider)
    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Failed to refresh models after adding custom endpoint %s: %s", endpoint_id, e)

    return ProviderInfo(
        id=endpoint_id, name=name, is_configured=True, enabled=True,
        masked_key=_mask_key(api_key) if api_key else None,
        model_count=len(models), status="connected", base_url=base_url
    )

@router.delete("/config/custom/{endpoint_id}", response_model=ProviderInfo)
async def delete_custom_endpoint(
    endpoint_id: str, settings: SettingsDep, registry: ProviderRegistryDep
) -> ProviderInfo:
    async with _custom_endpoints_lock:
        endpoints = get_custom_endpoints(settings)
        found = None
        for i, e in enumerate(endpoints):
            if e.get("id") == endpoint_id:
                found = endpoints.pop(i)
                break

        if not found:
            raise HTTPException(404, "Custom endpoint not found")

        settings.custom_endpoints = json.dumps(endpoints)
        _update_env_file("OPENYAK_CUSTOM_ENDPOINTS", settings.custom_endpoints)

    registry.unregister(endpoint_id)

    return ProviderInfo(
        id=endpoint_id, name=found.get("name", "Custom Endpoint"),
        is_configured=False, status="unconfigured"
    )

@router.patch("/config/custom/{endpoint_id}", response_model=ProviderInfo)
async def update_custom_endpoint(
    endpoint_id: str,
    body: CustomEndpointUpdate,
    settings: SettingsDep,
    registry: ProviderRegistryDep,
) -> ProviderInfo:
    """Update a custom endpoint (partial update)."""
    models: list = []
    test_provider = None
    needs_rebuild = body.base_url is not None or body.api_key is not None

    # --- Phase 1: read current config (under lock) ---
    async with _custom_endpoints_lock:
        endpoints = get_custom_endpoints(settings)

        found = None
        found_idx = -1
        for i, e in enumerate(endpoints):
            if e.get("id") == endpoint_id:
                found = e
                found_idx = i
                break

        if not found:
            raise HTTPException(404, "Custom endpoint not found")

    name = body.name.strip() if body.name is not None else found.get("name", "Custom Endpoint")
    base_url = body.base_url if body.base_url is not None else found.get("base_url", "")
    api_key = body.api_key.strip() if body.api_key is not None else found.get("api_key", "")
    enabled = body.enabled if body.enabled is not None else found.get("enabled", True)

    # --- Phase 2: validate (outside lock — network I/O) ---
    if needs_rebuild:
        try:
            test_provider = create_desktop_provider(endpoint_id, api_key, base_url=base_url)
            models = await test_provider.list_models()
        except Exception as e:
            logger.warning("Failed validation for custom endpoint %s: %s", name, e)
            raise HTTPException(400, f"Validation failed: {e}")
    else:
        provider = registry.get_provider(endpoint_id)
        models = [m for p, m in registry._full_models if m.provider_id == endpoint_id] if provider else []

    # --- Phase 3: persist (under lock) ---
    async with _custom_endpoints_lock:
        # Re-read in case another request mutated while we validated.
        endpoints = get_custom_endpoints(settings)
        found_idx = next((i for i, e in enumerate(endpoints) if e.get("id") == endpoint_id), -1)
        if found_idx == -1:
            raise HTTPException(404, "Custom endpoint was deleted during update")

        updated_config = {
            "id": endpoint_id,
            "name": name,
            "base_url": base_url,
            "api_key": api_key,
            "enabled": enabled,
        }
        endpoints[found_idx] = updated_config

        settings.custom_endpoints = json.dumps(endpoints)
        _update_env_file("OPENYAK_CUSTOM_ENDPOINTS", settings.custom_endpoints)

    if enabled and needs_rebuild and test_provider is not None:
        registry.unregister(endpoint_id)
        registry.register(test_provider)
        try:
            await registry.refresh_models()
        except Exception as e:
            logger.warning("Failed to refresh models after updating custom endpoint %s: %s", endpoint_id, e)
    elif not enabled:
        registry.unregister(endpoint_id)

    return ProviderInfo(
        id=endpoint_id, name=name, is_configured=True, enabled=enabled,
        masked_key=_mask_key(api_key) if api_key else None,
        model_count=len(models), status="connected" if enabled else "disabled", base_url=base_url
    )

@router.get("/config/local", response_model=LocalProviderStatus)
async def get_local_provider(settings: SettingsDep, registry: ProviderRegistryDep) -> LocalProviderStatus:
    """Return the stored local endpoint configuration."""
    return _local_provider_status(settings, registry)


@router.post("/config/local", response_model=LocalProviderStatus)
async def set_local_provider(
    settings: SettingsDep, registry: ProviderRegistryDep, body: LocalProviderUpdate,
) -> LocalProviderStatus:
    """Register a locally-hosted OpenAI-compatible endpoint."""
    base_url = _normalize_local_base_url(body.base_url)
    try:
        test_provider = create_local_provider(base_url)
        models = await test_provider.list_models()
        if not models:
            raise HTTPException(400, "Local endpoint returned no models")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Local provider validation failed for %s: %s", base_url, e)
        raise HTTPException(400, f"Local endpoint validation failed: {e}")
    registry.unregister(LOCAL_PROVIDER_ID)
    registry.register(create_local_provider(base_url))

    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after local provider registration: %s", e)

    _update_env_file(LOCAL_BASE_URL_ENV, base_url)
    settings.local_base_url = base_url

    return LocalProviderStatus(
        base_url=base_url,
        is_configured=True,
        is_connected=True,
        status="connected",
    )


@router.delete("/config/local", response_model=LocalProviderStatus)
async def delete_local_provider(settings: SettingsDep, registry: ProviderRegistryDep) -> LocalProviderStatus:
    """Remove the local endpoint configuration."""
    settings.local_base_url = ""
    _remove_env_key(LOCAL_BASE_URL_ENV)

    registry.unregister(LOCAL_PROVIDER_ID)

    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Model refresh failed after removing local provider: %s", e)

    return LocalProviderStatus()
