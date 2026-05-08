"""Ollama runtime and model management API endpoints."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.dependencies import ProviderRegistryDep, SettingsDep
from app.ollama.library import CATEGORIES, get_library as fetch_library

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────


class OllamaRuntimeStatus(BaseModel):
    binary_installed: bool = False
    running: bool = False
    port: int = 11434
    base_url: str | None = None
    version: str | None = None
    models_dir: str | None = None
    disk_usage_bytes: int = 0


class ModelPullRequest(BaseModel):
    name: str  # e.g. "llama3.2:3b"


class ModelDeleteRequest(BaseModel):
    name: str


class ModelWarmupRequest(BaseModel):
    model: str  # bare model name, e.g. "llama3.2:3b"


# ── Helpers ───────────────────────────────────────────────────────────────


def _get_manager(request: Request):
    """Get the OllamaManager from app state, or raise 503."""
    mgr = getattr(request.app.state, "ollama_manager", None)
    if mgr is None:
        raise HTTPException(503, "Ollama manager not initialized")
    return mgr


def _ollama_url(request: Request) -> str:
    """Get the Ollama base URL from the running manager."""
    mgr = _get_manager(request)
    if not mgr.is_running:
        raise HTTPException(400, "Ollama is not running — start it first")
    return mgr.base_url


def _is_cloud_model_tag(name: str) -> bool:
    """True for Ollama cloud-routed models (e.g. ``glm-5.1:cloud``).

    Cloud tags execute on Ollama's hosted infra rather than pulling local
    weights, so OpenYak's pull/discovery flow doesn't fit them today. Detect
    them up-front and surface a useful message instead of letting the request
    fail with an opaque manifest error.
    """
    return name.split("/")[-1].endswith(":cloud")


_CLOUD_BLOCK_MESSAGE = (
    "{name} is a cloud-hosted Ollama model — not yet supported in OpenYak. "
    "Try a local tag (e.g. qwen3:8b, llama3.2:3b) or use ChatGPT / "
    "OpenRouter in Settings → Providers."
)


# ── Runtime endpoints ─────────────────────────────────────────────────────


@router.get("/ollama/status", response_model=OllamaRuntimeStatus)
async def get_status(request: Request) -> OllamaRuntimeStatus:
    """Get the current Ollama runtime status."""
    mgr = _get_manager(request)
    data = await mgr.status()
    return OllamaRuntimeStatus(**data)


@router.post("/ollama/setup")
async def setup_ollama(request: Request):
    """Download Ollama binary + start the server. Returns SSE progress stream."""
    mgr = _get_manager(request)

    async def stream():
        # Phase 1: Download binary (if needed)
        if not mgr.is_binary_installed:
            async for progress in mgr.download_binary():
                yield f"data: {json.dumps(progress)}\n\n"
                if progress.get("status") == "error":
                    return
        else:
            yield f"data: {json.dumps({'status': 'binary_exists'})}\n\n"

        # Phase 2: Start server
        yield f"data: {json.dumps({'status': 'starting'})}\n\n"
        try:
            base_url = await mgr.start()
            # Register as provider
            await _register_ollama_provider(base_url)
            yield f"data: {json.dumps({'status': 'ready', 'base_url': base_url})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/ollama/start")
async def start_ollama(request: Request):
    """Start the Ollama server (binary must already exist)."""
    mgr = _get_manager(request)
    if not mgr.is_binary_installed:
        raise HTTPException(400, "Ollama binary not installed — run setup first")

    try:
        base_url = await mgr.start()
        await _register_ollama_provider(base_url)
        return {"status": "running", "base_url": base_url}
    except Exception as e:
        raise HTTPException(500, f"Failed to start Ollama: {e}")


@router.post("/ollama/stop")
async def stop_ollama(request: Request, registry: ProviderRegistryDep):
    """Stop the Ollama server."""
    mgr = _get_manager(request)
    await mgr.stop()

    # Unregister provider
    registry.unregister("ollama")

    return {"status": "stopped"}


@router.delete("/ollama/uninstall")
async def uninstall_ollama(
    request: Request, registry: ProviderRegistryDep, settings: SettingsDep,
    delete_models: bool = False,
):
    """Uninstall Ollama binary and optionally all models."""
    mgr = _get_manager(request)

    result = await mgr.uninstall(delete_models=delete_models)

    # Unregister provider and clear config
    registry.unregister("ollama")

    from app.api.config import _remove_env_key
    _remove_env_key("OPENYAK_OLLAMA_BASE_URL")
    settings.ollama_base_url = ""

    return {"status": "uninstalled", **result}


# ── Model management endpoints ────────────────────────────────────────────


@router.get("/ollama/models")
async def list_models(request: Request):
    """List locally installed models."""
    base_url = _ollama_url(request)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{base_url}/api/tags")
        resp.raise_for_status()
        return resp.json()


@router.get("/ollama/models/library")
async def get_library(
    q: str | None = None,
    category: str | None = None,
    sort: str = "popular",  # "popular" | "name" | "provider"
    page: int = 1,
    refresh: bool = False,
):
    """Return the model library for browsing, with search, filter, sort, and pagination.

    Query params:
        q: Search query (searches ollama.com)
        category: Filter by category (chat, code, reasoning, vision, embedding)
        sort: Sort by "popular" (pull count), "name", or "provider"
        page: Page number (1-based) for infinite scroll
        refresh: Force re-fetch (bypass cache)
    """
    models, has_more = await fetch_library(query=q, page=page, force_refresh=refresh)

    # Filter by category (client-side, after remote fetch)
    if category and category != "all":
        models = [m for m in models if m.get("category") == category]

    # Sort (only for non-search — search results are already ranked by relevance)
    if not q:
        if sort == "name":
            models.sort(key=lambda m: m.get("name", "").lower())
        elif sort == "provider":
            models.sort(key=lambda m: (m.get("provider", ""), m.get("name", "").lower()))
        else:  # "popular" — sort by pull count descending
            models.sort(key=lambda m: m.get("pulls", 0), reverse=True)

    return {"categories": CATEGORIES, "models": models, "has_more": has_more, "page": page}


@router.post("/ollama/models/pull")
async def pull_model(request: Request, registry: ProviderRegistryDep, body: ModelPullRequest):
    """Pull (download) a model. Returns SSE stream with progress."""
    if _is_cloud_model_tag(body.name):
        message = _CLOUD_BLOCK_MESSAGE.format(name=body.name)
        logger.info("Ollama: blocked pull for cloud-tagged model %s", body.name)

        async def cloud_block_stream():
            yield f"data: {json.dumps({'status': 'error', 'reason': 'cloud_model_unsupported', 'message': message})}\n\n"

        return StreamingResponse(cloud_block_stream(), media_type="text/event-stream")

    base_url = _ollama_url(request)

    async def stream():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{base_url}/api/pull",
                    json={"name": body.name, "stream": True},
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if line.strip():
                            yield f"data: {line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

        # After pull completes, refresh provider model list
        try:
            provider = registry.get_provider("ollama")
            if provider:
                provider.clear_cache()
                await registry.refresh_models()
        except Exception as e:
            logger.warning("Failed to refresh models after pull: %s", e)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.delete("/ollama/models/{name:path}")
async def delete_model(request: Request, registry: ProviderRegistryDep, name: str):
    """Delete a locally installed model."""
    base_url = _ollama_url(request)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            "DELETE",
            f"{base_url}/api/delete",
            json={"name": name},
        )
        if resp.status_code == 404:
            raise HTTPException(404, f"Model '{name}' not found")
        resp.raise_for_status()

    # Refresh provider model list
    try:
        provider = registry.get_provider("ollama")
        if provider:
            provider.clear_cache()
            await registry.refresh_models()
    except Exception as e:
        logger.warning("Failed to refresh models after delete: %s", e)

    return {"status": "deleted", "name": name}


@router.post("/ollama/warmup")
async def warmup_model(request: Request, body: ModelWarmupRequest):
    """Pre-load a model into memory so the first chat request is fast."""
    base_url = _ollama_url(request)
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{base_url}/api/generate",
                json={"model": body.model, "prompt": "", "keep_alive": "10m"},
            )
            resp.raise_for_status()
        logger.info("Ollama: warmed up model %s", body.model)
        return {"status": "warm", "model": body.model}
    except Exception as e:
        logger.warning("Ollama warmup failed for %s: %s", body.model, e)
        raise HTTPException(500, f"Warmup failed: {e}")


@router.get("/ollama/models/{name:path}/info")
async def model_info(request: Request, name: str):
    """Get detailed information about a model."""
    base_url = _ollama_url(request)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{base_url}/api/show",
            json={"name": name},
        )
        if resp.status_code == 404:
            raise HTTPException(404, f"Model '{name}' not found")
        resp.raise_for_status()
        return resp.json()


# ── Internal helpers ──────────────────────────────────────────────────────


async def _register_ollama_provider(base_url: str) -> None:
    """Register (or re-register) the Ollama provider in the provider registry."""
    from app.api.config import _update_env_file
    from app.dependencies import get_provider_registry, get_settings
    from app.provider.ollama import OllamaProvider

    provider = OllamaProvider(base_url=base_url)
    registry = get_provider_registry()
    registry.register(provider)

    try:
        await registry.refresh_models()
    except Exception as e:
        logger.warning("Failed to refresh models after Ollama registration: %s", e)

    # Persist so it auto-starts next time
    _update_env_file("OPENYAK_OLLAMA_BASE_URL", base_url)
    settings = get_settings()
    settings.ollama_base_url = base_url
