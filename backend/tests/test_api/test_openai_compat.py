import asyncio

import pytest

from app.api.openai_compat import _run_with_semaphore
from app.streaming.manager import GenerationJob, StreamManager


@pytest.mark.asyncio
async def test_openai_compat_generation_lends_its_slot_to_child() -> None:
    stream_manager = StreamManager()
    stream_manager._semaphore = asyncio.Semaphore(1)
    parent = GenerationJob("compat-parent-stream", "compat-parent-session")
    child = GenerationJob("compat-child-stream", "compat-child-session")

    async def run_nested_child() -> None:
        async with stream_manager.generation_slot(
            timeout=0.2,
            owner=child,
            parent=parent,
        ):
            return

    await _run_with_semaphore(stream_manager, parent, run_nested_child())

    assert stream_manager._semaphore._value == 1
    assert parent._generation_slot_credit is None
