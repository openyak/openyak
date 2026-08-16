"""Every provider stream failure must reach the retry classifier.

``tests/test_session/test_retry.py`` covers the pure classifiers in
``app.session.retry``. It cannot catch the failure these tests guard against:
a provider that reports an error *without raising* never reaches those
classifiers at all, so backoff, the 429/5xx retry budget, and context-overflow
recovery are silently skipped for it. These tests drive the real
``_stream_llm_with_retry`` loop instead.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, AsyncIterator

import pytest

from app.provider.base import ProviderStreamError
from app.schemas.provider import StreamChunk
from app.session.manager import create_message, create_session
from app.session.processor import SessionProcessor
from app.streaming.manager import GenerationJob


def _text_chunk(text: str) -> StreamChunk:
    return StreamChunk(type="text-delta", data={"text": text})


async def _make_processor(session_factory, session_id: str) -> SessionProcessor:
    """A processor wired far enough to run ``_stream_llm_with_retry``."""
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)
            assistant = await create_message(
                db, session_id=session_id, data={"role": "assistant"}
            )

    job = GenerationJob(f"{session_id}-stream", session_id)
    prompt = SimpleNamespace(
        job=job,
        session_factory=session_factory,
        provider=SimpleNamespace(id="generic"),
        model_id="test-model",
        request=SimpleNamespace(format=None),
        agent=SimpleNamespace(name="general"),
        tool_registry=SimpleNamespace(to_openai_specs=lambda *a, **k: []),
        merged_permissions=None,
        discovered_tools=None,
        system_prompt=None,
    )
    processor = SessionProcessor(prompt, [], assistant.id)
    processor._init_step_state()
    return processor


def _stub_stream_prerequisites(processor: SessionProcessor, monkeypatch) -> None:
    """Skip arg-building and the vision gate; keep the retry loop itself real."""

    async def build_args() -> tuple[Any, int, set[str] | None]:
        return None, 1024, None

    async def not_vision_blocked() -> None:
        return None

    monkeypatch.setattr(processor, "_build_stream_args", build_args)
    monkeypatch.setattr(processor, "_check_vision_blocked", not_vision_blocked)


def _no_backoff(monkeypatch) -> list[float]:
    """Record backoff delays without actually sleeping."""
    slept: list[float] = []

    async def fake_sleep(delay: float, abort_event=None) -> bool:
        slept.append(delay)
        return False

    monkeypatch.setattr("app.session.processor.sleep_with_abort", fake_sleep)
    return slept


@pytest.mark.parametrize(
    "signal",
    ["raise", "chunk"],
    ids=["provider raises", "provider yields an error chunk"],
)
async def test_rate_limit_is_retried_however_the_provider_reports_it(
    session_factory, monkeypatch, signal: str
) -> None:
    """A 429 must be retried whether the provider raises or yields a chunk.

    The chunk case is the regression: it used to return straight out of the
    retry loop, so no OpenAI-compatible provider ever retried anything.
    """
    processor = await _make_processor(session_factory, f"retry-429-{signal}")
    _stub_stream_prerequisites(processor, monkeypatch)
    slept = _no_backoff(monkeypatch)

    attempts = 0

    async def flaky_stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            if signal == "raise":
                raise ProviderStreamError("Error code: 429 - rate limit exceeded")
            yield StreamChunk(
                type="error", data={"message": "Error code: 429 - rate limit exceeded"}
            )
            return
        yield _text_chunk("recovered")

    monkeypatch.setattr("app.session.processor.stream_llm", flaky_stream)

    early = await processor._stream_llm_with_retry()

    assert early is None, "a retryable error must not end the step"
    assert attempts == 2, "the stream must be re-attempted after a 429"
    assert processor._accumulated_text == "recovered"
    assert processor._stream_error is None
    assert len(slept) == 1, "the retry must go through backoff"


async def test_context_overflow_is_not_retried_and_reaches_reactive_compaction(
    session_factory, monkeypatch
) -> None:
    """Overflow is non-retryable and must hand off to compaction, not stop."""
    processor = await _make_processor(session_factory, "retry-overflow")
    _stub_stream_prerequisites(processor, monkeypatch)
    slept = _no_backoff(monkeypatch)

    attempts = 0

    async def overflowing_stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        nonlocal attempts
        attempts += 1
        yield StreamChunk(
            type="error",
            data={"message": "This model's maximum context length is 8192 tokens"},
        )

    monkeypatch.setattr("app.session.processor.stream_llm", overflowing_stream)

    early = await processor._stream_llm_with_retry()

    assert early is None
    assert attempts == 1, "overflow must not be retried"
    assert slept == [], "overflow must not back off"
    assert processor._stream_error is not None

    assert await processor._handle_stream_error() == "compact"


async def test_non_retryable_error_stops_after_one_attempt(
    session_factory, monkeypatch
) -> None:
    """A 400 is neither retried nor mistaken for overflow."""
    processor = await _make_processor(session_factory, "retry-bad-request")
    _stub_stream_prerequisites(processor, monkeypatch)
    _no_backoff(monkeypatch)

    attempts = 0

    async def failing_stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        nonlocal attempts
        attempts += 1
        raise ProviderStreamError("Error code: 400 - invalid tool schema")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr("app.session.processor.stream_llm", failing_stream)

    assert await processor._stream_llm_with_retry() is None
    assert attempts == 1
    assert await processor._handle_stream_error() == "stop"


async def test_error_chunk_code_survives_onto_the_exception(
    session_factory, monkeypatch
) -> None:
    """``needs_reauth`` and friends must not be dropped in translation."""
    processor = await _make_processor(session_factory, "retry-code")
    _stub_stream_prerequisites(processor, monkeypatch)
    _no_backoff(monkeypatch)

    async def reauth_stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        yield StreamChunk(
            type="error",
            data={"message": "Authentication failed.", "code": "needs_reauth"},
        )

    monkeypatch.setattr("app.session.processor.stream_llm", reauth_stream)

    await processor._stream_llm_with_retry()

    assert isinstance(processor._stream_error, ProviderStreamError)
    assert processor._stream_error.code == "needs_reauth"
