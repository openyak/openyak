"""Rapid-MLX runtime API endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.dependencies import ProviderRegistryDep, SettingsDep
from app.rapid_mlx.manager import DEFAULT_PORT

logger = logging.getLogger(__name__)

router = APIRouter()


class RapidMLXRuntimeStatus(BaseModel):
    platform_supported: bool = False
    binary_installed: bool = False
    running: bool = False
    process_running: bool = False
    port: int = DEFAULT_PORT
    base_url: str | None = None
    version: str | None = None
    current_model: str = "default"
    executable_path: str | None = None
    install_commands: list[str] = Field(default_factory=list)


class RapidMLXStartRequest(BaseModel):
    model: str = Field("qwen3.5-4b", min_length=1, max_length=200)
    port: int = Field(DEFAULT_PORT, ge=1024, le=65535)


class RapidMLXCachedRequest(BaseModel):
    aliases: list[str] = Field(default_factory=list)


class RapidMLXCachedResponse(BaseModel):
    cached: dict[str, bool] = Field(default_factory=dict)


class RapidMLXRemoveRequest(BaseModel):
    alias: str = Field(..., min_length=1, max_length=200)


def _get_manager(request: Request):
    mgr = getattr(request.app.state, "rapid_mlx_manager", None)
    if mgr is None:
        raise HTTPException(503, "Rapid-MLX manager not initialized")
    return mgr


@router.get("/rapid-mlx/status", response_model=RapidMLXRuntimeStatus)
async def get_status(
    request: Request,
    settings: SettingsDep,
    registry: ProviderRegistryDep,
) -> RapidMLXRuntimeStatus:
    mgr = _get_manager(request)
    data = await mgr.status(
        configured_base_url=settings.rapid_mlx_base_url,
        configured_model=settings.rapid_mlx_model,
    )
    if data["running"]:
        await _register_rapid_mlx_provider(
            data["base_url"] or settings.rapid_mlx_base_url,
            registry,
            settings,
        )
    return RapidMLXRuntimeStatus(**data)


@router.post("/rapid-mlx/cached", response_model=RapidMLXCachedResponse)
async def get_cached_rapid_mlx_models(
    request: Request,
    body: RapidMLXCachedRequest,
) -> RapidMLXCachedResponse:
    mgr = _get_manager(request)
    return RapidMLXCachedResponse(cached=mgr.cached_models(body.aliases))


@router.post("/rapid-mlx/remove", response_model=RapidMLXCachedResponse)
async def remove_rapid_mlx_model(
    request: Request,
    body: RapidMLXRemoveRequest,
) -> RapidMLXCachedResponse:
    mgr = _get_manager(request)
    try:
        await mgr.remove_model(body.alias)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    return RapidMLXCachedResponse(cached=mgr.cached_models([body.alias]))


@router.post("/rapid-mlx/start", response_model=RapidMLXRuntimeStatus)
async def start_rapid_mlx(
    request: Request,
    body: RapidMLXStartRequest,
    settings: SettingsDep,
    registry: ProviderRegistryDep,
) -> RapidMLXRuntimeStatus:
    mgr = _get_manager(request)
    try:
        base_url = await mgr.start(model=body.model, port=body.port)
    except Exception as exc:
        raise HTTPException(400, str(exc))

    from app.api.config import _update_env_file

    _update_env_file("OPENYAK_RAPID_MLX_BASE_URL", base_url)
    _update_env_file("OPENYAK_RAPID_MLX_MODEL", body.model)
    settings.rapid_mlx_base_url = base_url
    settings.rapid_mlx_model = body.model

    data = await mgr.status(
        configured_base_url=settings.rapid_mlx_base_url,
        configured_model=settings.rapid_mlx_model,
    )
    if data["running"]:
        await _register_rapid_mlx_provider(base_url, registry, settings)
    return RapidMLXRuntimeStatus(**data)


@router.post("/rapid-mlx/stop", response_model=RapidMLXRuntimeStatus)
async def stop_rapid_mlx(
    request: Request,
    settings: SettingsDep,
    registry: ProviderRegistryDep,
) -> RapidMLXRuntimeStatus:
    mgr = _get_manager(request)
    try:
        await mgr.stop()
    except Exception as exc:
        raise HTTPException(400, str(exc))

    registry.unregister("rapid-mlx")
    data = await mgr.status(
        configured_base_url=settings.rapid_mlx_base_url,
        configured_model=settings.rapid_mlx_model,
    )
    return RapidMLXRuntimeStatus(**data)


async def _register_rapid_mlx_provider(
    base_url: str,
    registry: ProviderRegistryDep,
    settings: SettingsDep,
) -> None:
    from app.provider.rapid_mlx import RapidMLXProvider

    if not base_url:
        return
    existing = registry.get_provider("rapid-mlx")
    if (
        existing is not None
        and getattr(existing, "_base_url", None) == base_url.rstrip("/")
    ):
        return

    registry.register(RapidMLXProvider(base_url=base_url))
    try:
        await registry.refresh_models()
    except Exception as exc:
        logger.warning("Failed to refresh models after Rapid-MLX registration: %s", exc)
    settings.rapid_mlx_base_url = base_url
