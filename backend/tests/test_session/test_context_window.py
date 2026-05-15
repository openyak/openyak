"""Tests for ContextWindow — the per-Session compaction funnel.

All tests pass fake ``token_counter`` and ``on_summarize`` callables,
exercising the orchestration without a live Provider or DB.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.session.context_window import ContextWindow, FitOutcome


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _counter_by_len(msgs, tools):  # noqa: ARG001
    return len(msgs)


def _counter_constant(value: int):
    def _f(msgs, tools):  # noqa: ARG001
        return value
    return _f


def _msg(role: str = "user", content: str = "hi") -> dict:
    return {"role": role, "content": content}


def _summarize_succeeds(metadata=None):
    """Return an on_summarize fake that resolves to ``metadata``."""
    return AsyncMock(return_value=metadata or {"summary": "ok"})


def _summarize_raises(exc: Exception | None = None):
    fake = AsyncMock()
    fake.side_effect = exc or RuntimeError("boom")
    return fake


# ---------------------------------------------------------------------------
# Preflight (recovery_needed=False)
# ---------------------------------------------------------------------------


async def test_preflight_returns_preflight_strategy():
    cw = ContextWindow()
    out = await cw.fit(
        [_msg(), _msg()],
        on_summarize=_summarize_succeeds(),
        token_counter=_counter_by_len,
    )
    assert out.strategy == "preflight"
    assert out.compaction_part is None
    assert out.summary_metadata is None
    assert out.tokens_saved >= 0


async def test_preflight_does_not_invoke_summarize_callback():
    fake = _summarize_succeeds()
    cw = ContextWindow()
    await cw.fit(
        [_msg()],
        on_summarize=fake,
        token_counter=_counter_by_len,
    )
    fake.assert_not_called()


async def test_preflight_tokens_saved_equals_pre_minus_post():
    """token_counter is called twice (pre, post) and tokens_saved is
    the non-negative diff."""
    calls: list[int] = []

    def counter(msgs, tools):  # noqa: ARG001
        # Return 100 on first call, 60 on second.
        idx = len(calls)
        calls.append(idx)
        return [100, 60][idx]

    cw = ContextWindow()
    out = await cw.fit(
        [_msg()],
        on_summarize=_summarize_succeeds(),
        token_counter=counter,
    )
    assert out.tokens_saved == 40
    assert len(calls) == 2


async def test_preflight_tokens_saved_clamped_to_zero():
    """If post > pre (counter monotonic-decreasing-not-guaranteed),
    don't return a negative savings."""
    calls: list[int] = []

    def counter(msgs, tools):  # noqa: ARG001
        calls.append(0)
        return 50 if len(calls) == 1 else 80

    cw = ContextWindow()
    out = await cw.fit([_msg()], on_summarize=_summarize_succeeds(), token_counter=counter)
    assert out.tokens_saved == 0


# ---------------------------------------------------------------------------
# Recovery — layer 3 (collapse)
# ---------------------------------------------------------------------------


async def test_recovery_collapse_returns_boundary_part_and_messages():
    """When context_collapse frees tokens, fit returns strategy=collapse,
    a non-None compaction_part (the boundary marker), and the collapsed
    message list as the messages payload."""
    # Build enough messages for context_collapse to actually drop some.
    msgs = [_msg(content=f"msg-{i}") for i in range(20)]
    fake = _summarize_succeeds()
    cw = ContextWindow()

    out = await cw.fit(
        msgs,
        on_summarize=fake,
        token_counter=_counter_by_len,
        recovery_needed=True,
    )
    assert out.strategy == "collapse"
    assert out.compaction_part is not None
    assert isinstance(out.messages, list)
    assert len(out.messages) < len(msgs)
    fake.assert_not_called()  # collapse short-circuited summarize


async def test_recovery_falls_through_when_collapse_yields_no_savings():
    """A short message list can't be collapsed (min_messages_to_keep
    floor in microcompact). fit() marks collapse exhausted and falls
    through to summarize."""
    msgs = [_msg() for _ in range(2)]  # below min_messages_to_keep
    fake = _summarize_succeeds()
    cw = ContextWindow()

    out = await cw.fit(
        msgs,
        on_summarize=fake,
        token_counter=_counter_by_len,
        recovery_needed=True,
    )
    assert out.strategy == "summarize"
    assert cw.context_collapse_exhausted is True
    fake.assert_awaited_once()


async def test_recovery_after_exhaustion_skips_collapse():
    """Once exhausted, subsequent recovery calls go straight to layer 4
    without re-attempting collapse."""
    cw = ContextWindow()
    cw._context_collapse_exhausted = True

    fake = _summarize_succeeds()
    out = await cw.fit(
        [_msg(content=f"m-{i}") for i in range(20)],  # would normally collapse
        on_summarize=fake,
        token_counter=_counter_by_len,
        recovery_needed=True,
    )
    assert out.strategy == "summarize"
    fake.assert_awaited_once()


async def test_recovery_collapse_exception_marks_exhausted(monkeypatch):
    """If context_collapse raises, exhaust the flag and fall through to
    summarize. The exception itself is swallowed."""
    cw = ContextWindow()

    def boom(msgs):
        raise RuntimeError("collapse blew up")

    monkeypatch.setattr(
        "app.session.context_window.context_collapse",
        boom,
    )

    out = await cw.fit(
        [_msg(content=f"m-{i}") for i in range(20)],
        on_summarize=_summarize_succeeds(),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert cw.context_collapse_exhausted is True
    assert out.strategy == "summarize"


# ---------------------------------------------------------------------------
# Recovery — layer 4 (summarize) success and failure semantics
# ---------------------------------------------------------------------------


async def test_summarize_success_resets_failure_counter():
    cw = ContextWindow()
    cw._consecutive_compact_failures = 2
    cw._context_collapse_exhausted = True  # skip layer 3

    out = await cw.fit(
        [_msg()],
        on_summarize=_summarize_succeeds({"a": 1}),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert out.strategy == "summarize"
    assert out.summary_metadata == {"a": 1}
    assert cw.consecutive_compact_failures == 0


async def test_summarize_failure_increments_counter():
    cw = ContextWindow()
    cw._context_collapse_exhausted = True

    out = await cw.fit(
        [_msg()],
        on_summarize=_summarize_raises(),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert out.strategy == "summarize_failed"
    assert cw.consecutive_compact_failures == 1
    assert cw.compaction_circuit_open is False


async def test_circuit_opens_after_max_failures():
    cw = ContextWindow(max_consecutive_compact_failures=2)
    cw._context_collapse_exhausted = True

    # First failure: still under threshold.
    out1 = await cw.fit(
        [_msg()],
        on_summarize=_summarize_raises(),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert out1.strategy == "summarize_failed"
    assert cw.compaction_circuit_open is False

    # Second failure: hits threshold.
    out2 = await cw.fit(
        [_msg()],
        on_summarize=_summarize_raises(),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert out2.strategy == "circuit_open"
    assert cw.compaction_circuit_open is True


async def test_success_after_failures_resets_circuit():
    cw = ContextWindow(max_consecutive_compact_failures=3)
    cw._context_collapse_exhausted = True

    # Two failures.
    for _ in range(2):
        await cw.fit(
            [_msg()],
            on_summarize=_summarize_raises(),
            token_counter=lambda m, t: 0,
            recovery_needed=True,
        )
    assert cw.consecutive_compact_failures == 2

    # A success resets.
    out = await cw.fit(
        [_msg()],
        on_summarize=_summarize_succeeds(),
        token_counter=lambda m, t: 0,
        recovery_needed=True,
    )
    assert out.strategy == "summarize"
    assert cw.consecutive_compact_failures == 0
    assert cw.compaction_circuit_open is False


# ---------------------------------------------------------------------------
# State preservation across calls
# ---------------------------------------------------------------------------


async def test_preflight_does_not_touch_recovery_state():
    """Pre-flight calls must not advance failure counters or set the
    exhaustion flag — only the recovery path mutates those."""
    cw = ContextWindow()
    for _ in range(5):
        await cw.fit(
            [_msg(content=f"m-{i}") for i in range(20)],
            on_summarize=_summarize_raises(),
            token_counter=_counter_by_len,
        )
    assert cw.consecutive_compact_failures == 0
    assert cw.context_collapse_exhausted is False


# ---------------------------------------------------------------------------
# FitOutcome shape
# ---------------------------------------------------------------------------


async def test_fit_outcome_is_a_dataclass_with_expected_fields():
    cw = ContextWindow()
    out = await cw.fit(
        [_msg()],
        on_summarize=_summarize_succeeds(),
        token_counter=_counter_by_len,
    )
    assert isinstance(out, FitOutcome)
    assert {"messages", "compaction_part", "tokens_saved", "strategy", "summary_metadata"} <= set(
        out.__dataclass_fields__.keys()  # type: ignore[attr-defined]
    )
