import asyncio

import pytest

from app.api.chat import _run_with_semaphore
from app.api.openai_compat import (
    _run_with_semaphore as _run_openai_compat_with_semaphore,
)
from app.streaming.events import DONE
from app.streaming.manager import StreamManager


@pytest.mark.asyncio
async def test_aborting_queued_chat_generation_finishes_its_stream() -> None:
    stream_manager = StreamManager()
    stream_manager._semaphore = asyncio.Semaphore(0)
    job = stream_manager.create_job("queued-stream", "queued-session")
    generation_started = False

    async def run_generation() -> None:
        nonlocal generation_started
        generation_started = True

    task = asyncio.create_task(
        _run_with_semaphore(stream_manager, job, run_generation())
    )
    job.task = task
    await asyncio.sleep(0)

    assert stream_manager.abort_job(job.stream_id) is True
    with pytest.raises(asyncio.CancelledError):
        await task

    assert generation_started is False
    assert job.completed
    assert stream_manager.active_jobs() == []
    done = [event for event in job.events if event.event == DONE]
    assert len(done) == 1
    assert done[0].data == {
        "session_id": job.session_id,
        "finish_reason": "aborted",
    }


@pytest.mark.asyncio
async def test_aborting_queued_openai_generation_finishes_its_stream() -> None:
    stream_manager = StreamManager()
    stream_manager._semaphore = asyncio.Semaphore(0)
    job = stream_manager.create_job("queued-stream", "queued-session")
    generation_started = False

    async def run_generation() -> None:
        nonlocal generation_started
        generation_started = True

    task = asyncio.create_task(
        _run_openai_compat_with_semaphore(
            stream_manager,
            job,
            run_generation(),
        )
    )
    job.task = task
    await asyncio.sleep(0)

    assert stream_manager.abort_job(job.stream_id) is True
    with pytest.raises(asyncio.CancelledError):
        await task

    assert generation_started is False
    assert job.completed
    assert stream_manager.active_jobs() == []
    done = [event for event in job.events if event.event == DONE]
    assert len(done) == 1
    assert done[0].data == {
        "session_id": job.session_id,
        "finish_reason": "aborted",
    }
