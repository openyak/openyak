"""Provider and model schemas."""

from __future__ import annotations

import ipaddress
import re
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


# Slug format for user-defined custom provider IDs. Persisted as
# ``custom_{slug}`` to avoid collisions with the BYOK catalog.
CUSTOM_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,49}$")

# Provider IDs that cannot be reused as a custom-endpoint slug because
# they collide with built-in modes (BYOK catalog, ChatGPT subscription,
# Ollama, Rapid-MLX, or the legacy "local" endpoint).
RESERVED_CUSTOM_SLUGS = {
    "openrouter", "openai", "anthropic", "google", "groq", "deepseek",
    "mistral", "xai", "together", "deepinfra", "cerebras", "cohere",
    "perplexity", "fireworks", "azure", "qwen", "kimi", "minimax",
    "zhipu", "siliconflow", "xiaomi",
    "openai-subscription", "openai_subscription",
    "ollama", "rapid-mlx", "rapid_mlx", "local", "custom",
}


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


class CustomEndpointModel(BaseModel):
    """A user-declared model on a custom endpoint."""

    id: str = Field(..., min_length=1, max_length=200, description="Model ID sent on /v1/chat/completions")
    name: str | None = Field(None, max_length=200, description="Optional human label; defaults to the ID")


_FORBIDDEN_HEADER_NAMES = {"host", "content-length", "transfer-encoding"}


def _validate_header_name(raw_name: object) -> str:
    if not isinstance(raw_name, str):
        raise ValueError("Header names must be strings")
    name = raw_name.strip()
    if not name:
        raise ValueError("Header name cannot be empty")
    if any(ch in name for ch in "\r\n\0 \t:"):
        raise ValueError(f"Invalid header name: {raw_name!r}")
    if name.lower() in _FORBIDDEN_HEADER_NAMES:
        raise ValueError(f"Header {name!r} is reserved and cannot be overridden")
    return name


def _validate_header_value(name: str, raw_value: object) -> str:
    if not isinstance(raw_value, str):
        raise ValueError(f"Header value for {name!r} must be a string")
    if "\r" in raw_value or "\n" in raw_value or "\0" in raw_value:
        raise ValueError(f"Header value for {name!r} must not contain control characters")
    if len(raw_value) > 4096:
        raise ValueError(f"Header value for {name!r} exceeds 4096 chars")
    return raw_value


def _validate_headers(value: dict[str, str] | None) -> dict[str, str]:
    """Coerce + validate a header dict for full-set semantics (POST). Empty/None → {}."""
    if not value:
        return {}
    cleaned: dict[str, str] = {}
    for raw_name, raw_value in value.items():
        name = _validate_header_name(raw_name)
        cleaned[name] = _validate_header_value(name, raw_value)
    return cleaned


def _validate_headers_delta(
    value: dict[str, str | None] | None,
) -> dict[str, str | None] | None:
    """Validate a PATCH delta — JSON Merge Patch semantics (RFC 7396).

    ``None`` value marks the key for deletion; string value is upsert.
    A ``None`` delta dict means "no change" (caller decides whether to skip).
    """
    if value is None:
        return None
    cleaned: dict[str, str | None] = {}
    for raw_name, raw_value in value.items():
        name = _validate_header_name(raw_name)
        if raw_value is None:
            cleaned[name] = None
        else:
            cleaned[name] = _validate_header_value(name, raw_value)
    return cleaned


class CustomEndpointCreate(BaseModel):
    """Payload to create a custom openai-compatible endpoint."""

    slug: str = Field(..., min_length=1, max_length=50, description="Provider ID slug (lowercase, digits, hyphen, underscore)")
    name: str = Field(..., min_length=1, max_length=100, description="Display name shown in the UI")
    base_url: str = Field(..., min_length=1, description="Base URL for the endpoint")
    api_key: str | None = None
    models: list[CustomEndpointModel] = Field(default_factory=list, description="Optional manual model list; empty = auto-discover via /v1/models")
    headers: dict[str, str] = Field(default_factory=dict, description="Extra headers attached to every request")

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, v: str) -> str:
        s = v.strip().lower()
        if not CUSTOM_SLUG_RE.match(s):
            raise ValueError("Slug must start with a letter or digit and contain only lowercase letters, digits, hyphens, or underscores (max 50 chars)")
        if s in RESERVED_CUSTOM_SLUGS:
            raise ValueError(f"Slug '{s}' is reserved and cannot be used")
        return s

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        url = v.strip().rstrip("/")
        is_safe, error = _is_safe_url(url)
        if not is_safe:
            raise ValueError(error)
        return url

    @field_validator("headers")
    @classmethod
    def validate_headers(cls, v: dict[str, str] | None) -> dict[str, str]:
        return _validate_headers(v)


class CustomEndpointUpdate(BaseModel):
    """Payload to patch-update a custom endpoint. Slug is immutable.

    ``headers`` follows JSON Merge Patch semantics (RFC 7396): the field
    is a *delta*, not a full replacement. Keys with string values upsert,
    keys with ``null`` delete, keys omitted from the delta are preserved.
    Pass ``headers: None`` (field omitted) to leave the entire dict
    untouched.
    """

    name: str | None = Field(None, min_length=1, max_length=100, description="Display name")
    base_url: str | None = Field(None, min_length=1, description="Base URL for the endpoint")
    api_key: str | None = None
    enabled: bool | None = None
    models: list[CustomEndpointModel] | None = None
    headers: dict[str, str | None] | None = None

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

    @field_validator("headers")
    @classmethod
    def validate_headers(
        cls, v: dict[str, str | None] | None
    ) -> dict[str, str | None] | None:
        return _validate_headers_delta(v)


class CustomEndpointConfig(BaseModel):
    """A complete persisted custom endpoint."""

    id: str
    slug: str
    name: str
    base_url: str
    api_key: str | None = None
    enabled: bool = True
    models: list[CustomEndpointModel] = Field(default_factory=list)
    headers: dict[str, str] = Field(default_factory=dict)


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
    # Custom-endpoint-only fields (None / empty for built-in providers)
    slug: str | None = None
    models: list[CustomEndpointModel] | None = None
    # Header values are masked (first 4 / last 2 chars) — full values stay
    # server-side so the form can't be used as a credential exfiltration path.
    headers: dict[str, str] | None = None
