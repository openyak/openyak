"""The provider layer's own behaviour, driven directly.

``test_stream_error_path`` monkeypatches ``stream_llm``, so it never reaches a
real provider — the ``raise`` in ``OpenAICompatProvider.stream_chat`` that the
whole unified-error-path change rests on had no coverage at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.provider.openai_compat import OpenAICompatProvider
from app.schemas.provider import ModelPricing


class _ExplodingStream:
    """Stands in for the OpenAI SDK's streaming call."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def create(self, **kwargs: Any):
        raise self._error


class _Client:
    def __init__(self, error: Exception) -> None:
        self.chat = type("chat", (), {"completions": _ExplodingStream(error)})()


class _Provider(OpenAICompatProvider):
    @property
    def id(self) -> str:
        return "test-compat"

    async def list_models(self):
        return []

    async def health_check(self):  # pragma: no cover - not exercised here
        raise NotImplementedError


async def test_a_provider_failure_propagates_instead_of_becoming_a_chunk() -> None:
    """Yielding an error chunk instead bypasses the retry classifier entirely.

    The classifier reads the exception — including ``Retry-After`` off
    ``e.response.headers`` — so the original object must survive unwrapped.
    """
    original = RuntimeError("Error code: 429 - rate limited")
    original.response = type("r", (), {"headers": {"retry-after": "7"}})()

    provider = _Provider(api_key="k", base_url="https://example.invalid")
    provider._client = _Client(original)

    with pytest.raises(RuntimeError) as caught:
        async for _ in provider.stream_chat("m", [{"role": "user", "content": "hi"}]):
            pass

    assert caught.value is original, "the original exception must not be rewrapped"

    from app.session.retry import is_retryable, retry_delay

    assert is_retryable(caught.value) == "Rate limited"
    assert retry_delay(0, caught.value) == 7.0


async def test_no_error_chunk_is_ever_emitted() -> None:
    provider = _Provider(api_key="k", base_url="https://example.invalid")
    provider._client = _Client(RuntimeError("boom"))

    chunks = []
    with pytest.raises(RuntimeError):
        async for chunk in provider.stream_chat("m", [{"role": "user", "content": "hi"}]):
            chunks.append(chunk)

    assert not any(c.type == "error" for c in chunks)


def test_openrouter_publishes_the_catalog_cache_rates() -> None:
    """Without these the cost calculator falls back to the prompt price.

    Anthropic reads cache at ~0.1x prompt, so the fallback over-states a long
    cached session by roughly an order of magnitude.
    """
    from app.provider.openrouter import _optional_per_million

    assert _optional_per_million("0.0000005") == pytest.approx(0.5)
    assert _optional_per_million(None) is None
    assert _optional_per_million("not-a-number") is None
    assert _optional_per_million("0") == 0.0, "a real zero is not 'unknown'"


def test_a_published_rate_is_what_prices_a_cached_read() -> None:
    """Wiring the catalog rate is the whole mechanism — there is no fallback.

    Guessing the prompt price for an unpublished rate over-states by ~10x, so
    an unpriced model contributes nothing and the fix is to publish the rate.
    """
    from app.provider.openrouter import _optional_per_million
    from app.schemas.provider import ModelInfo
    from app.session.utils import calculate_step_cost

    priced = ModelInfo(
        id="m", name="m", provider_id="openrouter",
        pricing=ModelPricing(
            prompt=5.0, completion=25.0, cache_read=_optional_per_million("0.0000005")
        ),
    )
    unpriced = ModelInfo(
        id="m", name="m", provider_id="openrouter",
        pricing=ModelPricing(prompt=5.0, completion=25.0),
    )
    usage = {"input": 0, "output": 0, "cache_read": 1_000_000}

    assert calculate_step_cost(usage, priced) == pytest.approx(0.5)
    assert calculate_step_cost(usage, unpriced) == pytest.approx(0.0)


def test_every_models_dev_provider_publishes_its_cache_rate() -> None:
    """The rate is parsed centrally; each consumer has to actually read it.

    Only OpenRouter did, so three providers priced every cached read at zero.
    """
    import inspect

    from app.provider import anthropic_provider, generic_openai, gemini_provider

    for module in (anthropic_provider, generic_openai, gemini_provider):
        source = inspect.getsource(module)
        assert "cache_read_price" in source, (
            f"{module.__name__} builds ModelPricing without the parsed cache rate"
        )
