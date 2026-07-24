from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.session.manager import create_message, create_session, get_messages
from app.session.processor import SessionProcessor
from app.streaming.manager import GenerationJob


async def test_cancelled_step_persists_partial_text_and_reasoning(
    session_factory,
    monkeypatch,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="cancel-partial-session")
            assistant = await create_message(
                db,
                session_id="cancel-partial-session",
                data={"role": "assistant"},
            )

    job = GenerationJob("cancel-partial-stream", "cancel-partial-session")
    prompt = SimpleNamespace(job=job, session_factory=session_factory)
    processor = SessionProcessor(prompt, [], assistant.id)

    async def cancel_during_stream() -> None:
        processor._accumulated_text = "Partial answer that was visible."
        processor._accumulated_reasoning = "Partial reasoning."
        raise asyncio.CancelledError

    async def no_tools_to_cancel() -> None:
        return None

    monkeypatch.setattr(processor, "_run_step", cancel_during_stream)
    monkeypatch.setattr(processor, "_cancel_running_tools", no_tools_to_cancel)

    with pytest.raises(asyncio.CancelledError):
        await processor.process()

    async with session_factory() as db:
        messages = await get_messages(db, "cancel-partial-session")
    parts = [
        part.data
        for message in messages
        for part in message.parts
    ]
    assert {"type": "text", "text": "Partial answer that was visible."} in parts
    assert {"type": "reasoning", "text": "Partial reasoning."} in parts
