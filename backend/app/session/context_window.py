"""Per-Session compaction funnel — ADR-0009 ContextWindow Module.

Encapsulates the four-stage funnel that ``SessionPrompt._loop()``
previously inlined:

1. **microcompact** — replace old tool outputs with compact stubs
2. **tool-result budget** — enforce aggregate tool-output token cap
3. **context collapse** — drop the oldest fraction of messages, insert
   a synthetic boundary marker (zero-LLM-cost recovery)
4. **summarize** — run full LLM-based compaction via an injected
   callback (the most expensive recovery)

Layers 1+2 fire on every step (cheap pre-flight). Layers 3+4 fire only
when the LLM signals overflow (``recovery_needed=True``); the caller
decides when to set that flag. Within the recovery path, we try layer 3
first; if it's exhausted or yields nothing, we fall through to layer 4.

The Module is **per-Session stateful**: it carries
``_context_collapse_exhausted`` and ``_consecutive_compact_failures``
privately, preserving today's circuit-breaker semantics. After
``max_consecutive_compact_failures`` failures of layer 4, the circuit
opens and the caller should surface a user-facing error and stop.

Persistence is **not** owned here — :meth:`fit` returns a
:class:`FitOutcome` carrying enough information for the caller to
persist the collapsed messages (layer 3) or for the ``on_summarize``
callback to have done its own persistence (layer 4 — ``run_compaction``
already writes to the DB internally). This keeps ``ContextWindow``
unit-testable without a live DB.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal

from app.session.microcompact import (
    apply_tool_result_budget,
    context_collapse,
    microcompact_messages,
)

logger = logging.getLogger(__name__)


Strategy = Literal[
    "preflight",
    "collapse",
    "summarize",
    "summarize_failed",
    "circuit_open",
]


@dataclass
class FitOutcome:
    """Result of one :meth:`ContextWindow.fit` invocation.

    Attributes:
        messages: The messages after the funnel. Always set; on the
            collapse path this is the collapsed list (caller persists
            via the existing ``_persist_context_collapse`` helper).
        compaction_part: For the collapse path, the synthetic boundary
            marker dict (the first element of the collapsed list).
            ``None`` for other strategies — layer 4 persists internally
            so the caller doesn't need a part dict.
        tokens_saved: Sum of token savings across whichever layers ran
            (measured via the ``token_counter``). Zero on the summarize
            path where savings live in the DB after compaction.
        strategy: Which funnel layer made the final decision.
        summary_metadata: Whatever the ``on_summarize`` callback
            returned, for telemetry / logging. Opaque to ContextWindow.
    """

    messages: list[dict[str, Any]]
    compaction_part: dict[str, Any] | None
    tokens_saved: int
    strategy: Strategy
    summary_metadata: dict[str, Any] | None


# Callback signatures: kept narrow so tests can supply trivial fakes.
TokenCounter = Callable[[list[dict[str, Any]], Any], int]
"""Estimate the token cost of (messages, scheduled_tools). Pure."""

OnSummarize = Callable[[], Awaitable[dict[str, Any] | None]]
"""Run full LLM-based compaction. Persists to the DB internally; the
returned dict is opaque metadata that surfaces in ``FitOutcome``."""


class ContextWindow:
    """Per-Session compaction funnel."""

    def __init__(self, *, max_consecutive_compact_failures: int = 3) -> None:
        self._context_collapse_exhausted: bool = False
        self._consecutive_compact_failures: int = 0
        self._max_compact_failures: int = max_consecutive_compact_failures

    @property
    def compaction_circuit_open(self) -> bool:
        """True once layer 4 has failed enough times that the caller
        should surface a user-facing error and break out of the loop."""
        return self._consecutive_compact_failures >= self._max_compact_failures

    @property
    def context_collapse_exhausted(self) -> bool:
        """Public read of the layer-3 exhaustion flag, for assertions
        in tests and SSE telemetry. Not intended for callers to set."""
        return self._context_collapse_exhausted

    @property
    def consecutive_compact_failures(self) -> int:
        return self._consecutive_compact_failures

    async def fit(
        self,
        messages: list[dict[str, Any]],
        scheduled_tools: Any = None,
        *,
        on_summarize: OnSummarize,
        token_counter: TokenCounter,
        recovery_needed: bool = False,
    ) -> FitOutcome:
        """Run the funnel.

        ``recovery_needed=False`` (default) is the cheap pre-flight path
        — layers 1+2 only. ``recovery_needed=True`` is the post-overflow
        recovery path — try layer 3 (collapse if not exhausted); fall
        through to layer 4 (``on_summarize``) if collapse couldn't free
        anything.
        """
        pre_tokens = token_counter(messages, scheduled_tools)
        msgs = microcompact_messages(messages)
        msgs = apply_tool_result_budget(msgs)

        if not recovery_needed:
            post_tokens = token_counter(msgs, scheduled_tools)
            return FitOutcome(
                messages=msgs,
                compaction_part=None,
                tokens_saved=max(0, pre_tokens - post_tokens),
                strategy="preflight",
                summary_metadata=None,
            )

        # Recovery path — caller has been told the LLM hit overflow.
        if not self._context_collapse_exhausted:
            try:
                collapsed, collapse_saved = context_collapse(msgs)
            except Exception:
                logger.debug(
                    "context_collapse failed, marking exhausted",
                    exc_info=True,
                )
                self._context_collapse_exhausted = True
            else:
                if collapse_saved > 0:
                    boundary = collapsed[0] if collapsed else None
                    return FitOutcome(
                        messages=collapsed,
                        compaction_part=boundary,
                        tokens_saved=collapse_saved,
                        strategy="collapse",
                        summary_metadata=None,
                    )
                # Nothing to collapse — exhaust so we go straight to
                # layer 4 next time.
                self._context_collapse_exhausted = True

        # Layer 4: full LLM-based compaction via the caller's callback.
        try:
            summary_metadata = await on_summarize()
        except Exception:
            self._consecutive_compact_failures += 1
            logger.warning(
                "Compaction callback failed (%d/%d)",
                self._consecutive_compact_failures,
                self._max_compact_failures,
                exc_info=True,
            )
            strategy: Strategy = (
                "circuit_open" if self.compaction_circuit_open else "summarize_failed"
            )
            return FitOutcome(
                messages=msgs,
                compaction_part=None,
                tokens_saved=0,
                strategy=strategy,
                summary_metadata=None,
            )

        self._consecutive_compact_failures = 0
        return FitOutcome(
            messages=msgs,
            compaction_part=None,
            tokens_saved=0,
            strategy="summarize",
            summary_metadata=summary_metadata,
        )
