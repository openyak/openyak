"""GenerationJob and StreamManager for resumable SSE streaming."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from collections.abc import Callable
from typing import Any, Awaitable, TypeVar

from app.streaming.events import (
    AGENT_ERROR,
    DESYNC,
    DONE,
    PERMISSION_REQUEST,
    PLAN_REVIEW,
    QUESTION,
    SSEEvent,
)

# Events that MUST be delivered to the frontend even when the queue overflows.
# Losing these causes the UI to get permanently stuck in "generating" state.
_TERMINAL_EVENTS = frozenset({DONE, AGENT_ERROR})
_CHILD_INTERACTIVE_EVENTS = frozenset(
    {PERMISSION_REQUEST, QUESTION, PLAN_REVIEW}
)

logger = logging.getLogger(__name__)
_T = TypeVar("_T")


class GenerationCapacityError(TimeoutError):
    """Raised when the global generation pool cannot accept more work."""


class LinkedAbortEvent:
    """One-way child abort signal composed with a parent signal.

    Parent cancellation is visible to the child, while a child timeout only
    sets the child's local event and cannot cancel its parent or siblings.
    """

    def __init__(
        self,
        local: asyncio.Event | "LinkedAbortEvent",
        parent: asyncio.Event | "LinkedAbortEvent",
    ) -> None:
        self._local = local
        self._parent = parent

    def is_set(self) -> bool:
        return self._local.is_set() or self._parent.is_set()

    def set(self) -> None:
        self._local.set()

    def clear(self) -> None:
        self._local.clear()

    async def wait(self) -> bool:
        if self.is_set():
            return True
        local_wait = asyncio.create_task(self._local.wait())
        parent_wait = asyncio.create_task(self._parent.wait())
        try:
            await asyncio.wait(
                {local_wait, parent_wait},
                return_when=asyncio.FIRST_COMPLETED,
            )
            return True
        finally:
            for waiter in (local_wait, parent_wait):
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(
                local_wait,
                parent_wait,
                return_exceptions=True,
            )


async def await_with_abort(
    awaitable: Awaitable[_T],
    *,
    abort_event: asyncio.Event | LinkedAbortEvent,
    timeout: float | None = None,
) -> _T:
    """Await an operation with prompt abort and optional timeout propagation."""
    operation = asyncio.ensure_future(awaitable)
    abort_waiter = asyncio.create_task(abort_event.wait())
    try:
        done, _ = await asyncio.wait(
            {operation, abort_waiter},
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if abort_waiter in done:
            raise asyncio.CancelledError("Generation aborted")
        if operation in done:
            return operation.result()
        raise asyncio.TimeoutError
    except BaseException:
        if not operation.done():
            operation.cancel()
        if not abort_waiter.done():
            abort_waiter.cancel()
        cleanup = asyncio.gather(
            operation,
            abort_waiter,
            return_exceptions=True,
        )
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                continue
        await cleanup
        raise
    finally:
        if not abort_waiter.done():
            abort_waiter.cancel()
            await asyncio.gather(abort_waiter, return_exceptions=True)


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
        self.abort_event: asyncio.Event | LinkedAbortEvent = asyncio.Event()
        self._completed = False
        self._event_counter = 0
        self._response_queue: asyncio.Queue[tuple[str, Any]] | None = None
        self._response_futures: dict[str, asyncio.Future[Any]] = {}
        self._event_listeners: set[Callable[[SSEEvent], None]] = set()

        # Strong reference to the asyncio.Task running this job's generation.
        # Prevents GC from silently cancelling fire-and-forget tasks.
        self.task: asyncio.Task[None] | None = None

        # Interactive mode: True when a client is connected via SSE.
        # When False (tests, headless), permission "ask" auto-approves.
        self.interactive: bool = False

        # Nesting depth for subtask recursion guard
        self._depth: int = 0

        # Child jobs use the parent's interactive stream as their response
        # broker. Only user-interaction events are forwarded; child text/tool
        # deltas remain isolated in the child Session.
        self._parent_job: GenerationJob | None = None
        self._parent_event_context: dict[str, Any] = {}
        # A held global generation permit can be lent to one child at a time
        # while this Job is blocked in an exclusive orchestration Tool.
        self._generation_slot_credit: asyncio.Semaphore | None = None
        # Hard per-generation budget consumed by every Swarm invocation.
        # The synchronous reservation is atomic within the event loop.
        self._swarm_agents_reserved: int = 0

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

        for listener in tuple(self._event_listeners):
            try:
                listener(event)
            except Exception:
                logger.exception(
                    "Generation event listener failed for stream %s",
                    self.stream_id,
                )

        if (
            self._parent_job is not None
            and event.event in _CHILD_INTERACTIVE_EVENTS
        ):
            forwarded_data = {**event.data, **self._parent_event_context}
            call_id = forwarded_data.get("call_id")
            if isinstance(call_id, str):
                forwarded_data["call_id"] = self._parent_call_id(call_id)
            self._parent_job.publish(
                SSEEvent(
                    event.event,
                    forwarded_data,
                )
            )

    def add_event_listener(
        self,
        listener: Callable[[SSEEvent], None],
    ) -> Callable[[], None]:
        """Observe in-process events without creating an SSE subscriber queue."""
        self._event_listeners.add(listener)

        def remove() -> None:
            self._event_listeners.discard(listener)

        return remove

    def link_parent(
        self,
        parent: "GenerationJob",
        *,
        event_context: dict[str, Any] | None = None,
    ) -> None:
        """Inherit abort/interaction handling from a parent GenerationJob."""
        self._parent_job = parent
        self._parent_event_context = dict(event_context or {})
        self.abort_event = LinkedAbortEvent(
            self.abort_event,
            parent.abort_event,
        )
        self.interactive = parent.interactive

    def link_abort_event(
        self,
        parent: asyncio.Event | LinkedAbortEvent,
    ) -> None:
        """Observe another abort signal without allowing reverse propagation."""
        self.abort_event = LinkedAbortEvent(self.abort_event, parent)

    def reserve_swarm_agents(self, count: int, limit: int) -> bool:
        """Atomically reserve child-Agent budget for this generation."""
        if count < 1 or limit < 1:
            return False
        if self._swarm_agents_reserved + count > limit:
            return False
        self._swarm_agents_reserved += count
        return True

    def _parent_call_id(self, call_id: str) -> str:
        """Namespace a child response id on the shared parent broker."""
        return f"{self.stream_id}:{call_id}"

    def subscribe(self, last_event_id: int = 0) -> asyncio.Queue[SSEEvent | None]:
        """Create a subscriber queue. Replays missed events if last_event_id > 0."""
        q: asyncio.Queue[SSEEvent | None] = asyncio.Queue(maxsize=5000)

        # Replay buffered events after last_event_id. On long generations the
        # replay slice can be larger than the queue capacity; if that happens,
        # trim the oldest replay events instead of raising QueueFull (which
        # would turn a harmless reconnect into an HTTP 500 and strand the UI in
        # "finalizing"). The frontend treats DESYNC as a signal to refetch DB
        # state, so it is safe to explicitly notify it when replay is trimmed.
        replay_events = [
            event
            for event in self.events
            if event.id is not None and event.id > last_event_id
        ]
        reserve = 1 if self._completed else 0
        oldest_buffered_id = (
            self.events[0].id if self.events else None
        )
        dropped_event_id = (
            oldest_buffered_id - 1
            if oldest_buffered_id is not None
            and oldest_buffered_id > last_event_id + 1
            else None
        )
        needs_desync = dropped_event_id is not None
        capacity = max(
            0,
            q.maxsize - reserve - (1 if needs_desync else 0),
        )
        if len(replay_events) > capacity:
            # DESYNC itself occupies a queue slot. If the job is already
            # completed, also reserve one slot for the terminal None sentinel;
            # otherwise the sentinel insertion below can evict DESYNC and leave
            # the frontend unaware that replay was trimmed.
            needs_desync = True
            capacity = max(0, q.maxsize - reserve - 1)
            dropped = len(replay_events) - capacity
            logger.warning(
                "Replay buffer overflow for stream %s: dropping %d old replay events",
                self.stream_id,
                dropped,
            )
            dropped_event_id = replay_events[dropped - 1].id
            replay_events = replay_events[dropped:]

        if needs_desync and dropped_event_id is not None:
            desync = SSEEvent(
                DESYNC,
                {"dropped_event_id": dropped_event_id},
            )
            desync.id = dropped_event_id
            q.put_nowait(desync)

        for event in replay_events:
            q.put_nowait(event)

        # If already completed, signal end immediately
        if self._completed:
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(None)
        else:
            self.subscribers.append(q)

        return q

    def unsubscribe(self, queue: asyncio.Queue[SSEEvent | None]) -> None:
        """Detach a disconnected consumer without disturbing other subscribers."""
        try:
            self.subscribers.remove(queue)
        except ValueError:
            # Completed jobs clear the list after broadcasting the sentinel.
            pass

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
        if self._parent_job is not None:
            return await await_with_abort(
                self._parent_job.wait_for_response(
                    self._parent_call_id(call_id),
                    timeout,
                ),
                abort_event=self.abort_event,
            )

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
        abort_waiter = asyncio.create_task(self.abort_event.wait())

        try:
            done, _ = await asyncio.wait(
                {fut, abort_waiter},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                raise TimeoutError(
                    f"No response received for call_id={call_id}"
                )
            if abort_waiter in done:
                raise asyncio.CancelledError("Generation aborted")
            return fut.result()
        finally:
            self._response_futures.pop(call_id, None)
            for waiter in (fut, abort_waiter):
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(
                fut,
                abort_waiter,
                return_exceptions=True,
            )

    def submit_response(self, call_id: str, response: Any) -> None:
        """Submit a user response (from POST /api/chat/respond)."""
        if self._parent_job is not None:
            self._parent_job.submit_response(
                self._parent_call_id(call_id),
                response,
            )
            return

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
        self._workspace_mutation_locks: dict[
            str, tuple[asyncio.Lock, int]
        ] = {}
        self._workspace_mutation_locks_guard = asyncio.Lock()

    def create_job(self, stream_id: str, session_id: str) -> GenerationJob:
        """Create a new generation job and auto-cleanup old completed ones."""
        job = GenerationJob(stream_id=stream_id, session_id=session_id)
        self.register_job(job)
        return job

    def register_job(self, job: GenerationJob) -> GenerationJob:
        """Register an existing root or child Job for lifecycle operations."""
        existing = self._jobs.get(job.stream_id)
        if existing is not None and existing is not job:
            raise ValueError(f"Generation stream already exists: {job.stream_id}")
        self._jobs[job.stream_id] = job
        # Proactively cleanup old completed jobs on each new creation
        self.cleanup_completed()
        return job

    async def _acquire_generation_slot(
        self,
        *,
        parent_credit: asyncio.Semaphore | None,
        owner: GenerationJob | None,
        caller_abort: asyncio.Event,
        timeout: float | None,
    ) -> asyncio.Semaphore:
        """Race available permits against abort signals inside one owned Task."""
        global_wait = asyncio.create_task(self._semaphore.acquire())
        acquisitions: list[
            tuple[asyncio.Task[bool], asyncio.Semaphore]
        ] = [(global_wait, self._semaphore)]
        if parent_credit is not None:
            parent_wait = asyncio.create_task(parent_credit.acquire())
            acquisitions.insert(0, (parent_wait, parent_credit))

        abort_waiters = [asyncio.create_task(caller_abort.wait())]
        if owner is not None:
            abort_waiters.append(
                asyncio.create_task(owner.abort_event.wait())
            )
        waiters = {
            *(task for task, _ in acquisitions),
            *abort_waiters,
        }

        try:
            done, pending = await asyncio.wait(
                waiters,
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                raise GenerationCapacityError(
                    "Timed out waiting for a generation slot"
                )
            if any(waiter in done for waiter in abort_waiters):
                raise asyncio.CancelledError("Generation aborted")

            chosen_task, acquired_from = next(
                (task, semaphore)
                for task, semaphore in acquisitions
                if task in done
            )
            for waiter in pending:
                waiter.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            # A supposedly pending acquisition may win immediately before its
            # cancellation is delivered. Return every successful extra permit.
            for task, semaphore in acquisitions:
                if (
                    task is not chosen_task
                    and task.done()
                    and not task.cancelled()
                    and task.exception() is None
                    and task.result()
                ):
                    semaphore.release()
            return acquired_from
        except BaseException:
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()
            await asyncio.gather(*waiters, return_exceptions=True)
            for task, semaphore in acquisitions:
                if (
                    task.done()
                    and not task.cancelled()
                    and task.exception() is None
                    and task.result()
                ):
                    semaphore.release()
            raise

    @asynccontextmanager
    async def generation_slot(
        self,
        timeout: float | None = 30.0,
        *,
        owner: GenerationJob | None = None,
        parent: GenerationJob | None = None,
    ):
        """Reserve or transfer one global generation permit.

        Root Jobs acquire the global pool. A child races the pool against the
        parent's transferable credit, preventing nested Agent deadlock when
        the global pool is otherwise full while still preserving its bound.
        """
        parent_credit = parent._generation_slot_credit if parent else None
        caller_abort = asyncio.Event()
        acquisition = asyncio.create_task(
            self._acquire_generation_slot(
                parent_credit=parent_credit,
                owner=owner,
                caller_abort=caller_abort,
                timeout=timeout,
            )
        )
        try:
            acquired_from = await asyncio.shield(acquisition)
        except asyncio.CancelledError as cancel_exc:
            # Never cancel the acquisition Task directly. A dedicated signal
            # lets it finish its permit bookkeeping even under repeated caller
            # cancellation.
            caller_abort.set()
            while not acquisition.done():
                try:
                    await asyncio.shield(acquisition)
                except asyncio.CancelledError:
                    continue
            try:
                acquired_after_cancel = acquisition.result()
            except BaseException:
                pass
            else:
                acquired_after_cancel.release()
            raise cancel_exc

        previous_credit = owner._generation_slot_credit if owner else None
        slot_credit = asyncio.Semaphore(1)
        if owner is not None:
            owner._generation_slot_credit = slot_credit
        try:
            yield
        finally:
            if owner is not None and owner._generation_slot_credit is slot_credit:
                owner._generation_slot_credit = previous_credit
            acquired_from.release()

    @asynccontextmanager
    async def workspace_mutation_slot(self, workspace: str | None):
        """Serialize Swarm mutations that target the same Workspace."""
        key = os.path.realpath(workspace or ".")
        async with self._workspace_mutation_locks_guard:
            lock, users = self._workspace_mutation_locks.get(
                key,
                (asyncio.Lock(), 0),
            )
            self._workspace_mutation_locks[key] = (lock, users + 1)

        try:
            async with lock:
                yield
        finally:
            async with self._workspace_mutation_locks_guard:
                current = self._workspace_mutation_locks.get(key)
                if current is None:
                    return
                current_lock, current_users = current
                if current_users <= 1:
                    self._workspace_mutation_locks.pop(key, None)
                else:
                    self._workspace_mutation_locks[key] = (
                        current_lock,
                        current_users - 1,
                    )

    def get_job(self, stream_id: str) -> GenerationJob | None:
        """Get a job by stream ID."""
        return self._jobs.get(stream_id)

    def interaction_views(
        self,
        job: GenerationJob,
        call_id: str,
    ) -> list[tuple[GenerationJob, str]]:
        """Return every linked stream view of one interactive call."""
        broker = job
        broker_call_id = call_id
        while broker._parent_job is not None:
            broker_call_id = broker._parent_call_id(broker_call_id)
            broker = broker._parent_job

        views: list[tuple[GenerationJob, str]] = []

        def add_linked_views(
            current: GenerationJob,
            current_call_id: str,
        ) -> None:
            views.append((current, current_call_id))
            for candidate in self._jobs.values():
                if candidate._parent_job is not current:
                    continue
                prefix = f"{candidate.stream_id}:"
                if current_call_id.startswith(prefix):
                    add_linked_views(
                        candidate,
                        current_call_id[len(prefix):],
                    )
                    break

        add_linked_views(broker, broker_call_id)
        return views

    def remove_job(self, stream_id: str) -> None:
        """Remove a completed job."""
        self._jobs.pop(stream_id, None)

    @staticmethod
    def _abort_job(job: GenerationJob) -> None:
        job.abort()
        task = job.task
        if task is None or task.done():
            return
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if task is not current:
            task.cancel()

    def abort_job(self, stream_id: str) -> bool:
        """Abort one registered Job and cancel its running task when possible."""
        job = self._jobs.get(stream_id)
        if job is None or job.completed:
            return False
        self._abort_job(job)
        return True

    def active_jobs(self) -> list[dict[str, Any]]:
        """List all active (non-completed) jobs."""
        jobs: list[dict[str, Any]] = []
        for job in self._jobs.values():
            if job.completed:
                continue
            data: dict[str, Any] = {
                "stream_id": job.stream_id,
                "session_id": job.session_id,
                "needs_input": bool(job._response_futures),
            }
            if job._parent_job is not None:
                data["parent_session_id"] = job._parent_job.session_id
            jobs.append(data)
        return jobs

    def abort_session(self, session_id: str) -> int:
        """Abort all active jobs for a given session. Used when deleting a session."""
        count = 0
        for job in self._jobs.values():
            if job.session_id == session_id and not job.completed:
                self._abort_job(job)
                count += 1
        return count

    def abort_all(self) -> int:
        """Abort all active jobs. Used during graceful shutdown."""
        count = 0
        for job in self._jobs.values():
            if not job.completed:
                self._abort_job(job)
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
