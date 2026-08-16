"""Compaction must shrink the context without destroying the user's copy.

The newest summary becomes the permanent history anchor, so a bad summary is
not a wasted call — it permanently replaces everything it was supposed to
summarise. These tests pin the guards that stop a bad one from landing, and pin
that pruning stays reversible.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, AsyncIterator

import pytest

from app.schemas.provider import StreamChunk
from app.session import compaction as compaction_mod
from app.session.compaction import (
    PROTECTED_TOKEN_BUDGET,
    SKIP_RECENT_TURNS,
    _phase1_prune,
    _phase2_summarize,
)
from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_message_history_for_llm,
    get_messages,
)
from app.streaming.manager import GenerationJob


async def _session_with_big_tool_output(session_factory, session_id: str, output: str):
    """A history long enough to prune, ending at one oversized tool result.

    The pruner protects the first ``PROTECTED_TOKEN_BUDGET`` tokens of tool
    output outright, so the session needs an earlier tool result to absorb that
    budget before the one under test becomes prunable.
    """
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)
            for index, text in enumerate((("f" * PROTECTED_TOKEN_BUDGET * 8), output)):
                message = await create_message(
                    db, session_id=session_id, data={"role": "assistant"}
                )
                await create_part(
                    db,
                    message_id=message.id,
                    session_id=session_id,
                    data={
                        "type": "tool",
                        "tool": "bash",
                        "call_id": f"call-{index}",
                        "state": {
                            "status": "completed",
                            "input": {"command": "cat report.txt"},
                            "output": text,
                        },
                    },
                )
                target = message
            # Recent turns are skipped by the pruner, so add enough after them.
            for i in range(SKIP_RECENT_TURNS * 2 + 2):
                await create_message(
                    db, session_id=session_id, data={"role": "user", "text": f"turn {i}"}
                )
    return target


async def test_prune_flags_the_part_without_destroying_the_stored_output(
    session_factory,
) -> None:
    """The flag alone drives the model-facing substitution.

    Overwriting the stored output produces a byte-identical prompt while
    throwing away the user's only copy of a tool result — for an agent whose
    deliverables live in tool output, that is data loss for no gain.
    """
    original = "x" * (PROTECTED_TOKEN_BUDGET * 8)
    target = await _session_with_big_tool_output(
        session_factory, "prune-keeps-output", original
    )

    pruned_parts, tokens_freed = await _phase1_prune(
        "prune-keeps-output", session_factory=session_factory
    )

    assert pruned_parts == 1
    assert tokens_freed > 0

    async with session_factory() as db:
        messages = await get_messages(db, "prune-keeps-output")
    state = next(
        part.data["state"]
        for message in messages
        if message.id == target.id
        for part in message.parts
        if part.data.get("type") == "tool"
    )
    assert state["time_compacted"] == "auto"
    assert state["output"] == original, "the original tool output must survive pruning"


async def test_pruned_output_is_still_hidden_from_the_model(session_factory) -> None:
    """Keeping the row must not leak the bytes back into the prompt."""
    original = "y" * (PROTECTED_TOKEN_BUDGET * 8)
    await _session_with_big_tool_output(session_factory, "prune-hides-output", original)

    await _phase1_prune("prune-hides-output", session_factory=session_factory)

    async with session_factory() as db:
        async with db.begin():
            llm_messages = await get_message_history_for_llm(db, "prune-hides-output")

    rendered = str(llm_messages)
    assert "[truncated]" in rendered
    assert original not in rendered


def _summarizer(
    monkeypatch, *, text: str, finish_reason: str | None = "stop"
) -> None:
    """Point _phase2_summarize at a scripted model and a fixed history."""

    async def fake_history(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return [{"role": "user", "content": "z" * 40_000}]

    async def fake_stream(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        yield StreamChunk(type="text-delta", data={"text": text})
        if finish_reason is not None:
            yield StreamChunk(type="finish", data={"reason": finish_reason})

    monkeypatch.setattr(
        "app.session.manager.get_message_history_for_llm", fake_history
    )
    provider = SimpleNamespace(id="fake", stream_chat=fake_stream)
    monkeypatch.setattr(
        compaction_mod.ProviderRegistry,
        "resolve_model",
        lambda self, model_id: (provider, SimpleNamespace(id=model_id)),
        raising=False,
    )


async def _summarize(session_factory, agent_registry) -> tuple[str | None, int]:
    return await _phase2_summarize(
        "summary-session",
        job=GenerationJob("summary-stream", "summary-session"),
        session_factory=session_factory,
        provider_registry=compaction_mod.ProviderRegistry(),
        agent_registry=agent_registry,
        model_id="test-model",
    )


async def test_summary_truncated_at_the_output_cap_is_discarded(
    session_factory, agent_registry, monkeypatch
) -> None:
    """A ``length`` finish means a half-written checkpoint — never persist it."""
    _summarizer(monkeypatch, text="## Goal\nThe user asked me to", finish_reason="length")

    summary, freed = await _summarize(session_factory, agent_registry)

    assert summary is None
    assert freed == 0


async def test_summary_that_does_not_shrink_is_discarded(
    session_factory, agent_registry, monkeypatch
) -> None:
    """Anchoring past 40k tokens of history behind a bigger summary is a loss."""
    _summarizer(monkeypatch, text="q" * 200_000)

    summary, freed = await _summarize(session_factory, agent_registry)

    assert summary is None
    assert freed == 0


async def test_good_summary_is_kept_and_reports_what_it_freed(
    session_factory, agent_registry, monkeypatch
) -> None:
    _summarizer(monkeypatch, text="## Goal\nShip the release.\n## Accomplished\nTagged rc.4.")

    summary, freed = await _summarize(session_factory, agent_registry)

    assert summary is not None
    assert summary.startswith("## Goal")
    assert freed > 0


def test_circuit_breaker_trips_after_three_unproductive_compactions() -> None:
    """``run_compaction`` swallows provider failures and returns normally, so
    "freed nothing" is the only signal the caller has that it must stop."""
    from app.session.prompt import SessionPrompt

    prompt = SessionPrompt.__new__(SessionPrompt)
    prompt._consecutive_compact_failures = 0
    published: list[Any] = []
    prompt.job = SimpleNamespace(session_id="cb", publish=published.append)

    for expected in (1, 2):
        assert prompt._record_compaction_failure() is False
        assert prompt._consecutive_compact_failures == expected
        assert published == []

    assert prompt._record_compaction_failure() is True
    assert len(published) == 1, "the user must be told compaction gave up"
