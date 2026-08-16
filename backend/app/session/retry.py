"""Error retry with exponential backoff + jitter.

Improvements over OpenCode:
  - Jitter prevents thundering herd on rate limits
  - Explicit non-retryable classification (context overflow)
  - Retry-After header support from provider responses
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Any

logger = logging.getLogger(__name__)

BASE_DELAY = 2.0  # seconds
BACKOFF_FACTOR = 2
MAX_DELAY = 30.0  # seconds
MAX_RETRIES = 5  # Increased from 3 (Claude Code uses 10)

# Capacity overload (529) — retry for foreground, fail fast for background
MAX_OVERLOAD_RETRIES = 3  # Separate limit for 529 to prevent amplification

# Context overflow keywords — NEVER retry these (handled by reactive compact
# instead). Each must name the *input* being too large. A bare "max_tokens"
# does not: providers reject an oversized completion budget with a 400 that
# mentions the parameter by name, and treating that as overflow sends the
# session into a compaction loop that can never fix it.
_OVERFLOW_PATTERNS = [
    "context_length_exceeded",
    "maximum context length",
    "max_tokens is too large",
    "exceed context limit",
    "too many tokens",
    "context window",
    "input too long",
    "prompt is too long",
]

# Capacity overload patterns
_OVERLOAD_PATTERNS = [
    "529",
    "overloaded",
    "capacity",
]


def is_context_overflow(error: Exception) -> bool:
    """Check if an error is a context length overflow.

    These errors can be recovered from via reactive compaction
    (inspired by Claude Code's reactive compact pattern).
    """
    error_str = str(error).lower()
    return any(pattern in error_str for pattern in _OVERFLOW_PATTERNS)


def is_auth_error(error: Exception) -> bool:
    """Check if an error is an authentication/authorization failure (401)."""
    error_str = str(error).lower()
    return "401" in error_str or "unauthorized" in error_str or "authentication" in error_str


def is_overload_error(error: Exception) -> bool:
    """Check if an error is a capacity/overload error (529).

    Inspired by Claude Code: overload errors should be retried for
    foreground/interactive sessions but fail fast for background operations
    (subagent tasks, compaction) to prevent amplifying load.
    """
    error_str = str(error).lower()
    return any(pattern in error_str for pattern in _OVERLOAD_PATTERNS)


def is_retryable(error: Exception) -> str | None:
    """Classify whether an error is retryable.

    Returns a human-readable reason string if retryable, None otherwise.
    """
    error_str = str(error).lower()

    # Context overflow — NEVER retryable (handled by reactive compact)
    for pattern in _OVERFLOW_PATTERNS:
        if pattern in error_str:
            return None

    # Rate limit (429)
    if ("rate" in error_str and "limit" in error_str) or "429" in error_str:
        return "Rate limited"
    if "too_many_requests" in error_str:
        return "Rate limited"

    # Provider overloaded (529) — retryable but with separate limit
    if is_overload_error(error):
        return "Provider overloaded"

    # Server errors
    for code in (500, 502, 503, 504):
        if str(code) in error_str:
            return f"Server error ({code})"

    # Network errors
    for term in ("timeout", "connection", "network", "econnreset", "econnrefused"):
        if term in error_str:
            return "Network error"

    return None


def max_retries_for_error(error: Exception) -> int:
    """Return the appropriate max retry count for an error type.

    Overload errors (529) get a lower retry limit (MAX_OVERLOAD_RETRIES)
    to prevent amplifying server load. Other retryable errors use MAX_RETRIES.
    """
    if is_overload_error(error):
        return MAX_OVERLOAD_RETRIES
    return MAX_RETRIES


def retry_delay(attempt: int, error: Exception | None = None) -> float:
    """Calculate retry delay with exponential backoff + jitter.

    Better than OpenCode: adds jitter (±20%) to prevent thundering herd.
    Respects Retry-After headers from provider responses when available.
    """
    # Try to extract Retry-After from HTTP response headers
    if error is not None:
        delay = _extract_retry_after(error)
        if delay is not None:
            return delay

    # Exponential backoff with jitter (±20%)
    base = min(BASE_DELAY * (BACKOFF_FACTOR ** attempt), MAX_DELAY)
    jitter = base * 0.2 * (2 * random.random() - 1)
    return max(0.1, base + jitter)


def _extract_retry_after(error: Exception) -> float | None:
    """Try to extract Retry-After from HTTP error response headers."""
    # openai.APIError and similar have .response with headers
    response = getattr(error, "response", None)
    if response is None:
        return None

    headers: Any = getattr(response, "headers", None)
    if headers is None:
        return None

    # retry-after-ms (milliseconds — used by some providers)
    retry_after_ms = headers.get("retry-after-ms")
    if retry_after_ms:
        try:
            return float(retry_after_ms) / 1000.0
        except (ValueError, TypeError):
            pass

    # retry-after (seconds — standard HTTP header)
    retry_after = headers.get("retry-after")
    if retry_after:
        try:
            return float(retry_after)
        except (ValueError, TypeError):
            pass

    return None


async def sleep_with_abort(delay: float, abort_event: asyncio.Event | None = None) -> bool:
    """Sleep for delay seconds, but wake early if abort_event is set.

    Returns True if aborted, False if delay completed normally.
    """
    if abort_event is None:
        await asyncio.sleep(delay)
        return False

    try:
        await asyncio.wait_for(abort_event.wait(), timeout=delay)
        return True  # Abort was signaled
    except asyncio.TimeoutError:
        return False  # Normal timeout — delay completed
