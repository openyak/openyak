"""Base provider ABC."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator

from app.schemas.provider import ModelInfo, ProviderStatus, StreamChunk


class ProviderStreamError(RuntimeError):
    """An error a provider reported while streaming.

    Providers signal stream failures by raising, never by yielding a chunk, so
    that a single consumer path handles every failure. This matters because
    ``app.session.retry`` classifies retryability from the raised exception: an
    error delivered as a chunk instead bypasses backoff, the 429/5xx retry
    budget, and context-overflow recovery.

    Raise this when the failure originates in the provider's own protocol (an
    error event in the response body, a non-200 status). Re-raise the original
    exception unchanged when one exists — ``retry_delay`` reads ``Retry-After``
    off its ``.response.headers``, which a wrapper would discard.

    ``code`` carries a provider-specific signal (e.g. ``needs_reauth``) for
    callers that can act on it.
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class BaseProvider(ABC):
    """Abstract LLM provider."""

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique provider identifier (e.g. 'openrouter')."""

    @abstractmethod
    async def list_models(self) -> list[ModelInfo]:
        """List available models from this provider."""

    @abstractmethod
    async def stream_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system: str | list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Stream chat completion. Yields StreamChunk objects."""

    @abstractmethod
    async def health_check(self) -> ProviderStatus:
        """Check provider connectivity and return status."""

    def clear_cache(self) -> None:
        """Clear cached models to force refresh on next list_models() call.

        Default implementation does nothing (for providers without caching).
        """
        pass
