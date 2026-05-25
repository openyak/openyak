from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.models.session import Session
from app.schemas.chat import TaskBatchRequest
from app.session.task_batch import run_task_batch
from app.streaming.events import (
    DONE,
    SSEEvent,
    TASK_BATCH_FINISH,
    TASK_BATCH_START,
    TASK_BATCH_UPDATE,
    TEXT_DELTA,
)
from app.streaming.manager import GenerationJob


pytestmark = pytest.mark.asyncio


def _task(title: str, prompt: str, *, model: str | None = None) -> dict:
    return {
        "title": title,
        "prompt": prompt,
        "agent": "explore",
        "model": model,
    }


async def test_parallel_task_batch_streams_progress_and_persists_children(
    session_factory,
    monkeypatch,
) -> None:
    calls: list[tuple[str, str | None]] = []

    async def fake_run_generation(job, request, **_kwargs):
        calls.append((request.text, request.model))
        job.publish(SSEEvent(TEXT_DELTA, {"text": f"done {request.text}"}))

    monkeypatch.setattr("app.session.task_batch.run_generation", fake_run_generation)

    job = GenerationJob("stream-1", "parent-1")
    body = TaskBatchRequest(
        session_id="parent-1",
        mode="parallel",
        tasks=[
            _task("One", "first", model="model-a"),
            _task("Two", "second", model="model-b"),
        ],
    )

    await run_task_batch(
        job,
        body,
        session_factory=session_factory,
        provider_registry=MagicMock(),
        agent_registry=MagicMock(),
        tool_registry=MagicMock(),
    )

    assert calls == [("first", "model-a"), ("second", "model-b")]
    assert [event.event for event in job.events].count(TASK_BATCH_START) == 1
    assert [event.event for event in job.events].count(TASK_BATCH_FINISH) == 1
    assert job.events[-1].event == DONE

    finish_event = next(event for event in job.events if event.event == TASK_BATCH_FINISH)
    assert [task["status"] for task in finish_event.data["tasks"]] == ["completed", "completed"]

    async with session_factory() as db:
        sessions = (await db.execute(Session.__table__.select())).mappings().all()

    parent_rows = [row for row in sessions if row["id"] == "parent-1"]
    child_rows = [row for row in sessions if row["parent_id"] == "parent-1"]
    assert len(parent_rows) == 1
    assert len(child_rows) == 2


async def test_sequential_task_batch_cancels_pending_after_failure(
    session_factory,
    monkeypatch,
) -> None:
    calls: list[str] = []

    async def fake_run_generation(job, request, **_kwargs):
        calls.append(request.text)
        if request.text == "fail":
            job.publish(SSEEvent("agent-error", {"error_message": "child failed"}))
        else:
            job.publish(SSEEvent(TEXT_DELTA, {"text": "ok"}))

    monkeypatch.setattr("app.session.task_batch.run_generation", fake_run_generation)

    job = GenerationJob("stream-1", "parent-1")
    body = TaskBatchRequest(
        session_id="parent-1",
        mode="sequential",
        tasks=[
            _task("One", "ok"),
            _task("Two", "fail"),
            _task("Three", "never"),
        ],
    )

    await run_task_batch(
        job,
        body,
        session_factory=session_factory,
        provider_registry=MagicMock(),
        agent_registry=MagicMock(),
        tool_registry=MagicMock(),
    )

    assert calls == ["ok", "fail"]
    finish_event = next(event for event in job.events if event.event == TASK_BATCH_FINISH)
    assert [task["status"] for task in finish_event.data["tasks"]] == [
        "completed",
        "failed",
        "cancelled",
    ]

    updates = [event for event in job.events if event.event == TASK_BATCH_UPDATE]
    assert updates[-1].data["tasks"][1]["error"] == "child failed"
