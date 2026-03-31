"""GenerationJob and StreamManager for resumable SSE streaming."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.streaming.events import AGENT_ERROR, DESYNC, DONE, SSEEvent

# Events that MUST be delivered to the frontend even when the queue overflows.
# Losing these causes the UI to get permanently stuck in "generating" state.
_TERMINAL_EVENTS = frozenset({DONE, AGENT_ERROR})

logger = logging.getLogger(__name__)


class GenerationJob:
    """Tracks a single generation lifecycle.

    - Buffers all events for replay on reconnect
    - Supports multiple subscriber queues
    - Provides abort signaling
    - Interactive mode for permission/question prompts
    """

    # Max events to keep in the replay buffer per job
    _MAX_EVENT_BUFFER = 5000

    def __init__(self, stream_id: str, session_id: str):
        self.stream_id = stream_id
        self.session_id = session_id
        self.events: list[SSEEvent] = []
        self.subscribers: list[asyncio.Queue[SSEEvent | None]] = []
        self.abort_event = asyncio.Event()
        self._completed = False
        self._event_counter = 0
        self._response_queue: asyncio.Queue[tuple[str, Any]] | None = None
        self._response_futures: dict[str, asyncio.Future[Any]] = {}

        # Strong reference to the asyncio.Task running this job's generation.
        # Prevents GC from silently cancelling fire-and-forget tasks.
        self.task: asyncio.Task[None] | None = None

        # Interactive mode: True when a client is connected via SSE.
        # When False (tests, headless), permission "ask" auto-approves.
        self.interactive: bool = False

        # Nesting depth for subtask recursion guard
        self._depth: int = 0

        # Artifact content cache: identifier → {content, type, title, language}
        # Populated from message history at generation start, updated by artifact tool
        self.artifact_cache: dict[str, dict[str, Any]] = {}

    @property
    def completed(self) -> bool:
        return self._completed

    def publish(self, event: SSEEvent) -> None:
        """Publish an event to all subscribers and buffer for replay."""
        self._event_counter += 1
        event.id = self._event_counter
        self.events.append(event)

        # Cap replay buffer to prevent unbounded memory growth
        if len(self.events) > self._MAX_EVENT_BUFFER:
            self.events = self.events[-self._MAX_EVENT_BUFFER:]

        for q in self.subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("Subscriber queue full, dropping event %d (type=%s)", event.id, event.event)
                # Make room by clearing queue
                while not q.empty():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break

                if event.event in _TERMINAL_EVENTS:
                    # Terminal events MUST be delivered — losing DONE/AGENT_ERROR
                    # causes the frontend to stay stuck in "generating" forever.
                    try:
                        q.put_nowait(event)
                    except Exception:
                        pass
                else:
                    # Non-terminal: notify client that events were lost
                    try:
                        q.put_nowait(SSEEvent(DESYNC, {"dropped_event_id": event.id}))
                    except Exception:
                        pass

    def subscribe(self, last_event_id: int = 0) -> asyncio.Queue[SSEEvent | None]:
        """Create a subscriber queue. Replays missed events if last_event_id > 0."""
        q: asyncio.Queue[SSEEvent | None] = asyncio.Queue(maxsize=5000)

        # Replay buffered events after last_event_id
        for event in self.events:
            if event.id is not None and event.id > last_event_id:
                q.put_nowait(event)

        # If already completed, signal end immediately
        if self._completed:
            q.put_nowait(None)
        else:
            self.subscribers.append(q)

        return q

    def complete(self) -> None:
        """Mark generation as complete. Signal all subscribers."""
        self._completed = True
        for q in self.subscribers:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self.subscribers.clear()

    def abort(self) -> None:
        """Signal abort to the generation loop."""
        self.abort_event.set()

    async def wait_for_response(self, call_id: str, timeout: float = 300.0) -> Any:
        """Wait for user response to a specific call_id.

        Uses per-call_id Futures instead of a shared queue to avoid
        busy-loop polling when multiple calls are pending.
        """
        # Check if response arrived before we started waiting (race condition)
        if self._response_queue is not None:
            pending: list[tuple[str, Any]] = []
            while not self._response_queue.empty():
                cid, resp = self._response_queue.get_nowait()
                if cid == call_id:
                    # Put back any non-matching items
                    for item in pending:
                        self._response_queue.put_nowait(item)
                    return resp
                pending.append((cid, resp))
            for item in pending:
                self._response_queue.put_nowait(item)

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._response_futures[call_id] = fut

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"No response received for call_id={call_id}")
        finally:
            self._response_futures.pop(call_id, None)

    def submit_response(self, call_id: str, response: Any) -> None:
        """Submit a user response (from POST /api/chat/respond)."""
        fut = self._response_futures.get(call_id)
        if fut is not None and not fut.done():
            fut.set_result(response)
        else:
            # Future not yet created — store for later pickup via a fallback queue
            if self._response_queue is None:
                self._response_queue = asyncio.Queue()
            self._response_queue.put_nowait((call_id, response))


class StreamManager:
    """Manages all active GenerationJobs.

    Thread-safe singleton for creating, looking up, and cleaning up jobs.
    """

    def __init__(self):
        from app.config import get_settings as _get_settings
        self._jobs: dict[str, GenerationJob] = {}
        self._semaphore = asyncio.Semaphore(_get_settings().max_concurrent_generations)

    def create_job(self, stream_id: str, session_id: str) -> GenerationJob:
        """Create a new generation job and auto-cleanup old completed ones."""
        job = GenerationJob(stream_id=stream_id, session_id=session_id)
        self._jobs[stream_id] = job
        # Proactively cleanup old completed jobs on each new creation
        self.cleanup_completed()
        return job

    def get_job(self, stream_id: str) -> GenerationJob | None:
        """Get a job by stream ID."""
        return self._jobs.get(stream_id)

    def remove_job(self, stream_id: str) -> None:
        """Remove a completed job."""
        self._jobs.pop(stream_id, None)

    def active_jobs(self) -> list[dict[str, str]]:
        """List all active (non-completed) jobs."""
        return [
            {"stream_id": j.stream_id, "session_id": j.session_id}
            for j in self._jobs.values()
            if not j.completed
        ]

    def abort_session(self, session_id: str) -> int:
        """Abort all active jobs for a given session. Used when deleting a session."""
        count = 0
        for job in self._jobs.values():
            if job.session_id == session_id and not job.completed:
                job.abort()
                count += 1
        return count

    def abort_all(self) -> int:
        """Abort all active jobs. Used during graceful shutdown."""
        count = 0
        for job in self._jobs.values():
            if not job.completed:
                job.abort()
                count += 1
        return count

    def cleanup_completed(self, keep_last: int = 50) -> int:
        """Remove old completed jobs, keeping the most recent ones."""
        completed = [
            sid for sid, j in self._jobs.items() if j.completed
        ]
        to_remove = completed[:-keep_last] if len(completed) > keep_last else []
        for sid in to_remove:
            del self._jobs[sid]
        return len(to_remove)
