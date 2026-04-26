"""SSE generation lifecycle contract tests.

These tests lock down the protocol shared by the backend stream manager and
frontend SSE recovery logic. They intentionally avoid real LLM calls.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.dependencies import set_stream_manager
from app.streaming.events import (
    AGENT_ERROR,
    DESYNC,
    DONE,
    STEP_FINISH,
    TEXT_DELTA,
    SSEEvent,
)
from app.streaming.manager import GenerationJob, StreamManager


def _drain_queue(job: GenerationJob) -> list[SSEEvent | None]:
    queue = job.subscribe()
    items: list[SSEEvent | None] = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def _event_types(items: list[SSEEvent | None]) -> list[str | None]:
    return [item.event if item is not None else None for item in items]


def _parse_sse_events(body: str) -> list[dict[str, Any]]:
    """Parse the subset of SSE wire format emitted by SSEEvent.encode()."""
    events: list[dict[str, Any]] = []
    for block in body.split("\n\n"):
        block = block.strip()
        if not block or block.startswith(":"):
            continue

        parsed: dict[str, Any] = {"data": {}}
        for line in block.splitlines():
            if line.startswith(":"):
                continue
            key, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value
            if key == "id":
                parsed["id"] = int(value)
            elif key == "event":
                parsed["event"] = value
            elif key == "data":
                parsed["data"] = json.loads(value)

        if "event" in parsed:
            events.append(parsed)
    return events


class TestGenerationLifecycleContract:
    def test_done_is_terminal_and_replayed_to_late_subscribers(self) -> None:
        job = GenerationJob("stream-1", "session-1")

        job.publish(SSEEvent(TEXT_DELTA, {"text": "hello"}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        items = _drain_queue(job)

        assert _event_types(items) == [TEXT_DELTA, DONE, None]
        assert items[1] is not None
        assert items[1].id == 2
        assert items[1].data["finish_reason"] == "stop"

    def test_completed_job_reconnect_replays_done_with_end_sentinel(self) -> None:
        job = GenerationJob("stream-1", "session-1")

        job.publish(SSEEvent(TEXT_DELTA, {"text": "hello"}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        queue = job.subscribe(last_event_id=1)
        done = queue.get_nowait()
        sentinel = queue.get_nowait()

        assert done is not None
        assert done.event == DONE
        assert done.id == 2
        assert sentinel is None
        assert queue.empty()

    def test_agent_error_is_terminal_and_replayed_to_late_subscribers(self) -> None:
        job = GenerationJob("stream-1", "session-1")

        job.publish(SSEEvent(TEXT_DELTA, {"text": "partial"}))
        job.publish(SSEEvent(AGENT_ERROR, {"error_message": "provider failed"}))
        job.complete()

        items = _drain_queue(job)

        assert _event_types(items) == [TEXT_DELTA, AGENT_ERROR, None]
        assert items[1] is not None
        assert items[1].data["error_message"] == "provider failed"

    def test_subscriber_overflow_reports_desync_for_non_terminal_events(self) -> None:
        job = GenerationJob("stream-1", "session-1")
        queue = job.subscribe()

        for i in range(queue.maxsize + 1):
            job.publish(SSEEvent(TEXT_DELTA, {"text": str(i)}))

        queued_types = []
        while not queue.empty():
            item = queue.get_nowait()
            assert item is not None
            queued_types.append(item.event)

        assert DESYNC in queued_types

    @pytest.mark.parametrize("terminal_event", [DONE, AGENT_ERROR])
    def test_terminal_events_survive_subscriber_queue_overflow(self, terminal_event: str) -> None:
        job = GenerationJob("stream-1", "session-1")
        queue = job.subscribe()

        for i in range(queue.maxsize):
            job.publish(SSEEvent(TEXT_DELTA, {"text": str(i)}))

        job.publish(SSEEvent(terminal_event, {"error_message": "boom"} if terminal_event == AGENT_ERROR else {}))

        queued_types = []
        while not queue.empty():
            item = queue.get_nowait()
            assert item is not None
            queued_types.append(item.event)

        assert queued_types[-1] == terminal_event

    def test_replay_trims_with_desync_when_last_event_id_is_too_old(self) -> None:
        job = GenerationJob("stream-1", "session-1")

        for i in range(GenerationJob._MAX_EVENT_BUFFER + 10):
            job.publish(SSEEvent(TEXT_DELTA, {"text": str(i)}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        queue = job.subscribe(last_event_id=1)
        first = queue.get_nowait()

        assert first is not None
        assert first.event == DESYNC
        assert first.id is not None

    def test_tool_use_step_finish_does_not_complete_generation(self) -> None:
        sm = StreamManager()
        job = sm.create_job("stream-1", "session-1")

        job.publish(SSEEvent(STEP_FINISH, {"reason": "tool_use"}))

        assert not job.completed
        assert sm.active_jobs() == [
            {"stream_id": "stream-1", "session_id": "session-1", "needs_input": False}
        ]

    def test_terminal_step_finish_without_done_keeps_job_active_for_frontend_recovery(self) -> None:
        sm = StreamManager()
        job = sm.create_job("stream-1", "session-1")

        job.publish(SSEEvent(STEP_FINISH, {"reason": "stop"}))

        assert not job.completed
        assert sm.active_jobs()[0]["stream_id"] == "stream-1"


class TestChatStreamEndpointContract:
    @pytest.mark.asyncio
    async def test_stream_replays_from_last_event_id_query_param(self, app_client) -> None:
        sm = StreamManager()
        set_stream_manager(sm)
        job = sm.create_job("stream-1", "session-1")
        job.publish(SSEEvent(TEXT_DELTA, {"text": "one"}))
        job.publish(SSEEvent(TEXT_DELTA, {"text": "two"}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        response = await app_client.get("/api/chat/stream/stream-1?last_event_id=1")
        events = _parse_sse_events(response.text)

        assert response.status_code == 200
        assert [event["event"] for event in events] == [TEXT_DELTA, DONE]
        assert events[0]["data"]["text"] == "two"

    @pytest.mark.asyncio
    async def test_stream_replays_from_last_event_id_header(self, app_client) -> None:
        sm = StreamManager()
        set_stream_manager(sm)
        job = sm.create_job("stream-1", "session-1")
        job.publish(SSEEvent(TEXT_DELTA, {"text": "one"}))
        job.publish(SSEEvent(TEXT_DELTA, {"text": "two"}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        response = await app_client.get(
            "/api/chat/stream/stream-1",
            headers={"Last-Event-ID": "1"},
        )
        events = _parse_sse_events(response.text)

        assert response.status_code == 200
        assert [event["event"] for event in events] == [TEXT_DELTA, DONE]
        assert events[0]["data"]["text"] == "two"

    @pytest.mark.asyncio
    async def test_missing_stream_returns_agent_error_in_sse_body(self, app_client) -> None:
        set_stream_manager(StreamManager())

        response = await app_client.get("/api/chat/stream/missing-after-backend-restart")
        events = _parse_sse_events(response.text)

        assert response.status_code == 200
        assert [event["event"] for event in events] == [AGENT_ERROR]
        assert events[0]["data"]["error_message"] == "Job not found"

    @pytest.mark.asyncio
    async def test_active_jobs_exposes_terminal_step_without_done(self, app_client) -> None:
        sm = StreamManager()
        set_stream_manager(sm)
        job = sm.create_job("stream-1", "session-1")
        job.publish(SSEEvent(STEP_FINISH, {"reason": "stop"}))

        response = await app_client.get("/api/chat/active")

        assert response.status_code == 200
        assert response.json() == [
            {"stream_id": "stream-1", "session_id": "session-1", "needs_input": False}
        ]

    @pytest.mark.asyncio
    async def test_active_jobs_drops_job_after_done_and_complete(self, app_client) -> None:
        sm = StreamManager()
        set_stream_manager(sm)
        job = sm.create_job("stream-1", "session-1")
        job.publish(SSEEvent(STEP_FINISH, {"reason": "stop"}))
        job.publish(SSEEvent(DONE, {"session_id": "session-1", "finish_reason": "stop"}))
        job.complete()

        response = await app_client.get("/api/chat/active")

        assert response.status_code == 200
        assert response.json() == []
