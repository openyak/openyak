"""Provider and model schemas."""

from __future__ import annotations

import ipaddress
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


BLOCKED_IP_RANGES = [
    ipaddress.ip_network("169.254.169.254/32"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _is_safe_url(url: str) -> tuple[bool, str]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, "URL must use http:// or https:// scheme"
    if not parsed.netloc:
        return False, "URL must include a valid host"
    host = parsed.hostname
    if not host:
        return False, "URL must include a valid host"
    if host.lower() in ("localhost", "localhost.localdomain") or host == "127.0.0.1":
        return True, ""
    try:
        ip = ipaddress.ip_address(host)
        for blocked in BLOCKED_IP_RANGES:
            if ip in blocked:
                return False, f"URL targets blocked IP range: {blocked}"
    except ValueError:
        pass
    return True, ""


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

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        url = v.strip().rstrip("/")
        is_safe, error = _is_safe_url(url)
        if not is_safe:
            raise ValueError(error)
        return url


class CustomEndpointUpdate(BaseModel):
    """Payload to patch-update a custom endpoint."""

    name: str | None = Field(None, min_length=1, max_length=100, description="Endpoint name (1-100 chars)")
    base_url: str | None = Field(None, min_length=1, description="Base URL for the endpoint")
    api_key: str | None = None
    enabled: bool | None = None

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        url = v.strip().rstrip("/")
        is_safe, error = _is_safe_url(url)
        if not is_safe:
            raise ValueError(error)
        return url


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
