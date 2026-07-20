"""Context collapse must be a *stored event*, never data loss.

docs/adr/0005-compaction-is-a-persistent-part.md: the pre-collapse history
stays in the database; only the prompt is trimmed. These tests pin both
halves of that invariant, and — crucially — exercise the case the bug lived
in: a single assistant Message row that expands into several LLM messages
(one per tool result), so the stored rows and the LLM-formatted history do
*not* line up 1:1. A prior compaction summary is seeded too, so the row that
anchors history is in play and must survive a collapse.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.message import Message
from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_message_history_for_llm,
    get_messages,
)
from app.session.prompt import _persist_context_collapse

BASE_TIME = datetime(2026, 1, 1, tzinfo=timezone.utc)


async def _user(db: AsyncSession, session_id: str, text: str, t: datetime) -> Message:
    m = await create_message(db, session_id=session_id, data={"role": "user"})
    m.time_created = t
    await create_part(
        db, message_id=m.id, session_id=session_id,
        data={"type": "text", "text": text},
    )
    return m


async def _assistant(
    db: AsyncSession,
    session_id: str,
    text: str,
    t: datetime,
    tools: list[tuple[str, str]] | None = None,
) -> Message:
    """An assistant turn, optionally carrying several tool parts.

    Each tool part becomes its own ``role: tool`` entry in the LLM history, so
    a single row here expands into ``1 + len(tools)`` LLM messages — this is
    the row/LLM-entry divergence the collapse bug hinged on.
    """
    m = await create_message(db, session_id=session_id, data={"role": "assistant"})
    m.time_created = t
    await create_part(
        db, message_id=m.id, session_id=session_id,
        data={"type": "text", "text": text},
    )
    for i, (name, output) in enumerate(tools or []):
        await create_part(
            db, message_id=m.id, session_id=session_id,
            data={
                "type": "tool",
                "tool": name,
                "call_id": f"{m.id}-{i}",
                "state": {"status": "completed", "input": {"q": name}, "output": output},
            },
        )
    return m


async def _compaction_summary(
    db: AsyncSession, session_id: str, text: str, t: datetime
) -> Message:
    """A full-compaction summary row, matching app.session.compaction output."""
    m = await create_message(
        db,
        session_id=session_id,
        data={"role": "user", "agent": "compaction", "system": True},
    )
    m.time_created = t
    await create_part(
        db, message_id=m.id, session_id=session_id,
        data={"type": "text", "text": f"[Context Summary]\n\n{text}", "synthetic": True},
    )
    await create_part(
        db, message_id=m.id, session_id=session_id,
        data={"type": "compaction", "auto": True},
    )
    return m


async def _seed_tool_conversation(
    db: AsyncSession, session_id: str, turns: int
) -> list[str]:
    """``turns`` user/assistant pairs where assistants carry tool parts.

    Returns the user/assistant text labels in order. DB rows and LLM entries
    deliberately diverge: every assistant row expands into 1 + (#tools) LLM
    messages.
    """
    texts: list[str] = []
    clock = 0
    for i in range(turns):
        await _user(db, session_id, f"user-{i}", BASE_TIME + timedelta(minutes=clock))
        clock += 1
        await _assistant(
            db, session_id, f"assistant-{i}", BASE_TIME + timedelta(minutes=clock),
            tools=[(f"grep-{i}", f"tool-out-{i}-a"), (f"read-{i}", f"tool-out-{i}-b")],
        )
        clock += 1
        texts.extend([f"user-{i}", f"assistant-{i}"])
    await db.flush()
    return texts


async def _collapse(db: AsyncSession, session_factory, session_id: str) -> int:
    """Run the real collapse path; returns tokens saved. Commits pending seed."""
    await db.commit()
    return await _persist_context_collapse(session_id, session_factory=session_factory)


def _prompt_text(history: list[dict]) -> str:
    parts: list[str] = []
    for m in history:
        content = m.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
    return " ".join(parts)


class TestContextCollapsePersistence:
    @pytest.mark.asyncio
    async def test_rows_and_llm_entries_actually_diverge(
        self, db: AsyncSession, session_factory
    ):
        """Guard the premise: the two lists are NOT 1:1, so counting is wrong."""
        session = await create_session(db, title="Divergence")
        await _seed_tool_conversation(db, session.id, turns=10)
        await db.commit()

        async with session_factory() as fresh:
            rows = await get_messages(fresh, session.id)
            history = await get_message_history_for_llm(fresh, session.id)

        # 20 rows (10 user + 10 assistant), but each assistant expands into
        # 1 assistant + 2 tool entries → far more LLM messages than rows.
        assert len(rows) == 20
        assert len(history) > len(rows)

    @pytest.mark.asyncio
    async def test_collapse_keeps_every_row(self, db: AsyncSession, session_factory):
        """The user's transcript survives a collapse — nothing is deleted."""
        session = await create_session(db, title="Collapse")
        await _seed_tool_conversation(db, session.id, turns=10)

        before = [m.id for m in await get_messages(db, session.id)]
        assert len(before) == 20

        tokens_saved = await _collapse(db, session_factory, session.id)
        assert tokens_saved > 0

        async with session_factory() as fresh:
            after = await get_messages(fresh, session.id)
        after_ids = [m.id for m in after]

        # Every original row is still there (plus the new boundary marker).
        assert set(before) <= set(after_ids)
        assert len(after_ids) == len(before) + 1

        # ...and their parts were not cascade-deleted.
        collapsed = [m for m in after if m.collapsed_at is not None]
        assert collapsed, "expected some messages to be marked collapsed"
        assert all(m.parts for m in collapsed)

    @pytest.mark.asyncio
    async def test_collapse_excludes_marked_rows_from_prompt(
        self, db: AsyncSession, session_factory
    ):
        """Collapsed messages, including their tool output, stop being sent."""
        session = await create_session(db, title="Collapse Prompt")
        await _seed_tool_conversation(db, session.id, turns=10)

        await _collapse(db, session_factory, session.id)

        async with session_factory() as fresh:
            stored = await get_messages(fresh, session.id)
            history = await get_message_history_for_llm(fresh, session.id)

        collapsed_texts = {
            p.data["text"]
            for m in stored
            if m.collapsed_at is not None
            for p in m.parts
            if p.data.get("type") == "text"
        }
        # Tool outputs from collapsed assistant rows must also leave the prompt.
        collapsed_tool_outputs = {
            (p.data.get("state") or {}).get("output")
            for m in stored
            if m.collapsed_at is not None
            for p in m.parts
            if p.data.get("type") == "tool"
        }
        assert collapsed_texts
        assert collapsed_tool_outputs

        prompt_text = _prompt_text(history)
        for text in collapsed_texts:
            assert text not in prompt_text
        for out in collapsed_tool_outputs:
            assert out and out not in prompt_text

        # The surviving tail is still in the prompt, and the boundary marker
        # explains the gap.
        assert "user-9" in prompt_text
        assert "[Context collapsed:" in prompt_text

    @pytest.mark.asyncio
    async def test_boundary_counts_match_collapsed_rows(
        self, db: AsyncSession, session_factory
    ):
        """The user-visible boundary number describes the rows really dropped."""
        session = await create_session(db, title="Collapse Counts")
        await _seed_tool_conversation(db, session.id, turns=10)

        await _collapse(db, session_factory, session.id)

        async with session_factory() as fresh:
            stored = await get_messages(fresh, session.id)

        collapsed_rows = [m for m in stored if m.collapsed_at is not None]
        users = sum(1 for m in collapsed_rows if (m.data or {}).get("role") == "user")
        assistants = sum(
            1 for m in collapsed_rows if (m.data or {}).get("role") == "assistant"
        )
        tool_parts = sum(
            1
            for m in collapsed_rows
            for p in m.parts
            if p.data.get("type") == "tool"
        )

        marker_text = next(
            p.data["text"]
            for m in stored
            if (m.data or {}).get("collapse_boundary")
            for p in m.parts
            if p.data.get("type") == "text"
        )
        # Boundary is phrased from DB rows: "N earlier messages removed
        # (U user, A assistant, T tool results ...)".
        assert f"{len(collapsed_rows)} earlier messages removed" in marker_text
        assert f"{users} user" in marker_text
        assert f"{assistants} assistant" in marker_text
        assert f"{tool_parts} tool results" in marker_text

    @pytest.mark.asyncio
    async def test_boundary_marker_precedes_surviving_history(
        self, db: AsyncSession, session_factory
    ):
        """The marker renders at the trim point, not appended after the tail."""
        session = await create_session(db, title="Collapse Order")
        await _seed_tool_conversation(db, session.id, turns=10)

        await _collapse(db, session_factory, session.id)

        async with session_factory() as fresh:
            stored = await get_messages(fresh, session.id)

        marker_idx = next(
            i for i, m in enumerate(stored)
            if (m.data or {}).get("collapse_boundary")
        )
        live_after = [m for m in stored[marker_idx + 1:] if m.collapsed_at is None]
        assert live_after, "boundary marker must come before the kept messages"
        assert all(m.collapsed_at is not None for m in stored[:marker_idx])

    @pytest.mark.asyncio
    async def test_prior_compaction_summary_survives_collapse(
        self, db: AsyncSession, session_factory
    ):
        """BLOCKER: a collapse must never drop the compaction anchor.

        The summary anchors all pre-compaction history. If collapse marks it
        ``collapsed_at``, ``find_compaction_anchor`` then points at a hidden
        row and the summary — with everything it stands for — vanishes from
        the prompt. It must still be sent after a collapse.
        """
        session = await create_session(db, title="Anchor Survives")

        # Pre-compaction turns, then the summary that replaced them, then a
        # long tail so there is plenty for collapse to bite into.
        clock = 0
        await _user(db, session.id, "ancient-user", BASE_TIME + timedelta(minutes=clock))
        clock += 1
        await _assistant(
            db, session.id, "ancient-assistant", BASE_TIME + timedelta(minutes=clock)
        )
        clock += 1
        await _compaction_summary(
            db, session.id, "SUMMARY-OF-ANCIENT-HISTORY",
            BASE_TIME + timedelta(minutes=clock),
        )
        clock += 1
        for i in range(9):
            await _user(db, session.id, f"post-{i}", BASE_TIME + timedelta(minutes=clock))
            clock += 1
            await _assistant(
                db, session.id, f"post-asst-{i}",
                BASE_TIME + timedelta(minutes=clock),
                tools=[(f"tool-{i}", f"post-out-{i}")],
            )
            clock += 1
        await db.flush()

        tokens_saved = await _collapse(db, session_factory, session.id)
        assert tokens_saved > 0, "collapse should have fired on the post-summary tail"

        async with session_factory() as fresh:
            stored = await get_messages(fresh, session.id)
            history = await get_message_history_for_llm(fresh, session.id)

        summary_row = next(
            m for m in stored
            for p in m.parts
            if p.data.get("type") == "compaction"
        )
        # The anchor itself was never collapsed...
        assert summary_row.collapsed_at is None
        # ...and it is still sent to the model.
        prompt_text = _prompt_text(history)
        assert "SUMMARY-OF-ANCIENT-HISTORY" in prompt_text
        # Some post-summary rows were collapsed out of the prompt.
        assert "post-0" not in prompt_text
        # The recent tail is retained.
        assert "post-8" in prompt_text

    @pytest.mark.asyncio
    async def test_same_timestamp_rows_order_deterministically(
        self, db: AsyncSession, session_factory
    ):
        """Same-flush inserts (identical time_created) must order stably.

        Without a secondary sort key, colliding timestamps leave row order
        (and the boundary marker's position) up to the DB's whim. The id
        tiebreak pins it: reads are repeatable and the marker still lands
        ahead of every surviving row.
        """
        session = await create_session(db, title="Collision")
        # Every row shares one timestamp — the worst case for ordering.
        collide = BASE_TIME
        for i in range(12):
            await _user(db, session.id, f"user-{i}", collide)
            await _assistant(db, session.id, f"assistant-{i}", collide)
        await db.commit()

        tokens_saved = await _persist_context_collapse(
            session.id, session_factory=session_factory
        )
        assert tokens_saved > 0

        async with session_factory() as fresh:
            order_a = [m.id for m in await get_messages(fresh, session.id)]
        async with session_factory() as fresh:
            order_b = [m.id for m in await get_messages(fresh, session.id)]
            stored = await get_messages(fresh, session.id)

        # Repeated reads agree — no non-determinism.
        assert order_a == order_b

        marker_idx = next(
            i for i, m in enumerate(stored)
            if (m.data or {}).get("collapse_boundary")
        )
        # Every surviving (non-collapsed) real row is after the marker.
        for m in stored[:marker_idx]:
            assert m.collapsed_at is not None
        live_after = [m for m in stored[marker_idx + 1:] if m.collapsed_at is None]
        assert live_after

    @pytest.mark.asyncio
    async def test_second_collapse_does_not_re_collapse(
        self, db: AsyncSession, session_factory
    ):
        """Already-collapsed rows are not candidates again, and stay intact."""
        session = await create_session(db, title="Collapse Twice")
        await _seed_tool_conversation(db, session.id, turns=20)

        await _collapse(db, session_factory, session.id)
        async with session_factory() as fresh:
            first = {
                m.id: m.collapsed_at
                for m in await get_messages(fresh, session.id)
                if m.collapsed_at is not None
            }

        await _persist_context_collapse(session.id, session_factory=session_factory)

        async with session_factory() as fresh:
            rows = await get_messages(fresh, session.id)
        second = {m.id: m.collapsed_at for m in rows if m.collapsed_at is not None}

        # First batch keeps its original stamp; the second collapse only adds.
        for msg_id, stamp in first.items():
            assert second[msg_id] == stamp
        assert len(second) > len(first)
        assert len(rows) >= 40  # no row was ever removed

    @pytest.mark.asyncio
    async def test_api_still_returns_collapsed_messages(
        self, db: AsyncSession, session_factory
    ):
        """Collapsed rows remain visible to the history endpoint layer."""
        session = await create_session(db, title="Collapse API")
        await _seed_tool_conversation(db, session.id, turns=10)
        await _collapse(db, session_factory, session.id)

        async with session_factory() as fresh:
            stmt = (
                select(Message)
                .where(Message.session_id == session.id)
                .options(selectinload(Message.parts))
                .order_by(Message.time_created.asc())
            )
            rows = list((await fresh.execute(stmt)).scalars().all())

        from app.api.messages import _msg_to_response

        responses = [_msg_to_response(m) for m in rows]
        assert any(r.collapsed_at is not None for r in responses)
        assert all(r.parts for r in responses if r.collapsed_at is not None)
