"""Provider and model schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ModelCapabilities(BaseModel):
    """What a model supports."""

    function_calling: bool = False
    vision: bool = False
    reasoning: bool = False
    json_output: bool = False
    max_context: int = 128_000
    max_output: int | None = None
    prompt_caching: bool = False  # Whether model supports prompt caching


class ModelPricing(BaseModel):
    """Per-million-token pricing info (USD)."""

    prompt: float = 0.0  # Cost per million prompt tokens
    completion: float = 0.0  # Cost per million completion tokens


class ModelInfo(BaseModel):
    """A model available through a provider."""

    id: str
    name: str
    provider_id: str
    capabilities: ModelCapabilities = ModelCapabilities()
    pricing: ModelPricing = ModelPricing()
    metadata: dict[str, Any] = {}


class ProviderStatus(BaseModel):
    """Health status of a provider."""

    status: str  # "connected" | "error" | "unconfigured"
    model_count: int = 0
    error: str | None = None


class StreamChunk(BaseModel):
    """A single chunk from LLM streaming."""

    type: str  # "text-delta", "reasoning-delta", "tool-call", "usage", "finish", "error"
    data: dict[str, Any] = {}


class ApiKeyUpdate(BaseModel):
    """Request to update the OpenRouter API key."""

    api_key: str


class ApiKeyStatus(BaseModel):
    """API key configuration status."""

    is_configured: bool = False
    masked_key: str | None = None
    is_valid: bool | None = None


class ProviderKeyUpdate(BaseModel):
    """Request to set/update an API key for any provider."""

    api_key: str
    base_url: str | None = None


class CustomEndpointCreate(BaseModel):
    """Payload to create or update a custom openai-compatible endpoint."""

    name: str = Field(..., min_length=1, max_length=100, description="Endpoint name (1-100 chars)")
    base_url: str = Field(..., min_length=1, description="Base URL for the endpoint")
    api_key: str | None = None


class CustomEndpointConfig(BaseModel):
    """A complete persisted custom endpoint."""

    id: str
    name: str
    base_url: str
    api_key: str | None = None
    enabled: bool = True


class ProviderInfo(BaseModel):
    """Summary info for a provider (used in GET /config/providers)."""

    id: str
    name: str
    is_configured: bool = False
    enabled: bool = True  # False = key set but provider disabled by user
    masked_key: str | None = None
    model_count: int = 0
    status: str = "unconfigured"  # "connected" | "error" | "unconfigured" | "disabled"
    base_url: str | None = None
