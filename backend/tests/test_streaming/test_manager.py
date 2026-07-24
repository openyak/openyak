"""Streaming manager tests — GenerationJob lifecycle, interactive mode, permissions."""

import asyncio

import pytest

from app.streaming.events import SSEEvent, TEXT_DELTA, DONE, PERMISSION_REQUEST
from app.streaming.manager import (
    GenerationJob,
    StreamManager,
    await_with_abort,
)


class TestGenerationJobInteractive:
    """Tests for the interactive permission flow."""

    def test_default_not_interactive(self):
        job = GenerationJob("s1", "sess1")
        assert job.interactive is False

    def test_set_interactive(self):
        job = GenerationJob("s1", "sess1")
        job.interactive = True
        assert job.interactive is True

    def test_default_depth_zero(self):
        job = GenerationJob("s1", "sess1")
        assert job._depth == 0

    @pytest.mark.asyncio
    async def test_wait_for_response(self):
        """Test that wait_for_response receives a submitted response."""
        job = GenerationJob("s1", "sess1")

        async def submit_later():
            await asyncio.sleep(0.05)
            job.submit_response("call-1", "allow")

        asyncio.create_task(submit_later())
        response = await job.wait_for_response("call-1", timeout=5.0)
        assert response == "allow"

    @pytest.mark.asyncio
    async def test_wait_for_response_timeout(self):
        """Test that wait_for_response raises on timeout."""
        job = GenerationJob("s1", "sess1")
        with pytest.raises(TimeoutError):
            await job.wait_for_response("call-1", timeout=0.05)

    @pytest.mark.asyncio
    async def test_wait_for_response_stops_when_generation_is_aborted(self):
        job = GenerationJob("s1", "sess1")
        waiter = asyncio.create_task(
            job.wait_for_response("call-1", timeout=5.0)
        )
        await asyncio.sleep(0)

        job.abort()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, timeout=0.2)

    @pytest.mark.asyncio
    async def test_abort_cancels_blocked_nested_operation(self):
        abort_event = asyncio.Event()
        operation = asyncio.create_task(asyncio.sleep(10))
        waiter = asyncio.create_task(
            await_with_abort(
                operation,
                abort_event=abort_event,
                timeout=None,
            )
        )
        await asyncio.sleep(0)

        abort_event.set()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, timeout=0.2)
        assert operation.cancelled()

    @pytest.mark.asyncio
    async def test_submit_before_wait(self):
        """Response submitted before wait_for_response is called."""
        job = GenerationJob("s1", "sess1")
        job.submit_response("call-1", "deny")
        response = await job.wait_for_response("call-1", timeout=1.0)
        assert response == "deny"

    @pytest.mark.asyncio
    async def test_child_forwards_interaction_and_uses_parent_response_broker(self):
        parent = GenerationJob("parent-stream", "parent-session")
        parent.interactive = True
        child = GenerationJob("child-stream", "child-session")
        child.link_parent(
            parent,
            event_context={"agent_run_id": "run-1"},
        )

        child.publish(SSEEvent(PERMISSION_REQUEST, {"call_id": "call-1"}))
        forwarded = parent.events[-1]
        assert forwarded.event == PERMISSION_REQUEST
        assert forwarded.data["agent_run_id"] == "run-1"
        assert forwarded.data["call_id"] == "child-stream:call-1"

        waiter = asyncio.create_task(
            child.wait_for_response("call-1", timeout=1.0)
        )
        await asyncio.sleep(0)
        child.submit_response("call-1", "allow")
        assert await waiter == "allow"
        assert child.abort_event is not parent.abort_event

        child.abort()
        assert child.abort_event.is_set()
        assert not parent.abort_event.is_set()

        sibling = GenerationJob("sibling-stream", "sibling-session")
        sibling.link_parent(parent)
        parent.abort()
        assert sibling.abort_event.is_set()

    @pytest.mark.asyncio
    async def test_child_abort_stops_waiting_on_parent_response_broker(self):
        parent = GenerationJob("parent-stream", "parent-session")
        child = GenerationJob("child-stream", "child-session")
        child.link_parent(parent)
        waiter = asyncio.create_task(
            child.wait_for_response("call-1", timeout=5)
        )
        await asyncio.sleep(0)

        child.abort()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, timeout=0.2)
        assert not parent.abort_event.is_set()
        assert parent._response_futures == {}

    def test_linked_abort_signal_is_one_way_without_parent_interaction(self):
        parent_abort = asyncio.Event()
        child = GenerationJob("child-stream", "child-session")

        child.link_abort_event(parent_abort)
        child.abort()

        assert child.abort_event.is_set()
        assert not parent_abort.is_set()

        sibling = GenerationJob("sibling-stream", "sibling-session")
        sibling.link_abort_event(parent_abort)
        parent_abort.set()
        assert sibling.abort_event.is_set()


class TestStreamManagerCleanup:
    def test_unsubscribe_removes_only_the_disconnected_consumer(self):
        job = GenerationJob("stream", "session")
        first = job.subscribe()
        second = job.subscribe()

        job.unsubscribe(first)
        job.publish(SSEEvent(TEXT_DELTA, {"text": "still live"}))

        assert first.empty()
        assert second.get_nowait().data["text"] == "still live"
        assert job.subscribers == [second]

    def test_cleanup_completed(self):
        sm = StreamManager()
        # Insert jobs directly to avoid auto-cleanup in create_job
        for i in range(60):
            job = GenerationJob(stream_id=f"s{i}", session_id=f"sess{i}")
            sm._jobs[f"s{i}"] = job
            if i < 55:
                job.settle()

        removed = sm.cleanup_completed(keep_last=10)
        assert removed == 45  # 55 completed, keep 10

    def test_active_jobs_excludes_completed(self):
        sm = StreamManager()
        j1 = sm.create_job("s1", "sess1")
        j2 = sm.create_job("s2", "sess2")
        j1.complete()

        active = sm.active_jobs()
        assert len(active) == 1
        assert active[0]["stream_id"] == "s2"

    def test_registered_child_job_can_be_aborted_by_session(self):
        sm = StreamManager()
        child = GenerationJob("child-stream", "child-session")
        sm.register_job(child)

        assert sm.abort_session("child-session") == 1
        assert child.abort_event.is_set()

        sm.remove_job(child.stream_id)
        assert sm.get_job(child.stream_id) is None

    def test_active_jobs_identifies_child_sessions(self):
        sm = StreamManager()
        parent = sm.create_job("parent-stream", "parent-session")
        child = GenerationJob("child-stream", "child-session")
        child.link_parent(parent)
        sm.register_job(child)

        active = {job["stream_id"]: job for job in sm.active_jobs()}

        assert "parent_session_id" not in active["parent-stream"]
        assert active["child-stream"]["parent_session_id"] == "parent-session"

    @pytest.mark.asyncio
    async def test_abort_job_cancels_registered_running_task(self):
        sm = StreamManager()
        job = sm.create_job("running-stream", "running-session")
        job.task = asyncio.create_task(asyncio.sleep(10))

        assert sm.abort_job(job.stream_id) is True

        assert job.abort_event.is_set()
        with pytest.raises(asyncio.CancelledError):
            await job.task

    @pytest.mark.asyncio
    async def test_abort_sessions_waits_for_terminal_job_cleanup(self):
        sm = StreamManager()
        job = sm.create_job("running-stream", "running-session")
        cleanup_started = asyncio.Event()
        cleanup_finished = asyncio.Event()
        allow_settlement = asyncio.Event()

        async def run_until_cancelled():
            await job.abort_event.wait()
            job.complete()
            cleanup_started.set()
            await allow_settlement.wait()
            cleanup_finished.set()
            job.settle()

        job.task = asyncio.create_task(run_until_cancelled())
        await asyncio.sleep(0)

        abort_and_wait = asyncio.create_task(
            sm.abort_sessions_and_wait({"running-session"})
        )
        await cleanup_started.wait()

        assert job.completed
        assert not job.settled
        assert not abort_and_wait.done()
        allow_settlement.set()
        aborted = await abort_and_wait
        assert aborted == 1
        assert cleanup_finished.is_set()
        assert job.settled

    @pytest.mark.asyncio
    async def test_abort_sessions_rejects_waiting_on_its_own_owner_task(self):
        sm = StreamManager()
        job = sm.create_job("self-stream", "self-session")
        job.set_settlement_owner(asyncio.current_task())

        with pytest.raises(
            TimeoutError,
            match="own generation Task",
        ):
            await sm.abort_sessions_and_wait({"self-session"})

        job.settle()

    @pytest.mark.asyncio
    async def test_workspace_mutation_slot_serializes_same_workspace(self):
        sm = StreamManager()
        active = 0
        max_active = 0

        async def mutate(workspace: str):
            nonlocal active, max_active
            async with sm.workspace_mutation_slot(workspace):
                active += 1
                max_active = max(max_active, active)
                await asyncio.sleep(0.01)
                active -= 1

        await asyncio.gather(
            mutate("/tmp/project/../project"),
            mutate("/tmp/project"),
        )

        assert max_active == 1

    @pytest.mark.asyncio
    async def test_child_generation_borrows_parent_slot_at_capacity(self):
        sm = StreamManager()
        sm._semaphore = asyncio.Semaphore(1)
        parent = GenerationJob("parent-stream", "parent-session")
        child = GenerationJob("child-stream", "child-session")

        async with sm.generation_slot(owner=parent):
            async def run_child():
                async with sm.generation_slot(
                    owner=child,
                    parent=parent,
                ):
                    return "completed"

            assert await asyncio.wait_for(run_child(), timeout=0.2) == "completed"

    @pytest.mark.asyncio
    async def test_child_generation_never_exceeds_global_permits_or_overreleases(self):
        sm = StreamManager()
        sm._semaphore = asyncio.Semaphore(2)
        parent = GenerationJob("parent-stream", "parent-session")
        active = 0
        max_active = 0

        async with sm.generation_slot(owner=parent):
            async def run_child(index: int) -> None:
                nonlocal active, max_active
                child = GenerationJob(
                    f"child-stream-{index}",
                    f"child-session-{index}",
                )
                async with sm.generation_slot(
                    timeout=None,
                    owner=child,
                    parent=parent,
                ):
                    active += 1
                    max_active = max(max_active, active)
                    await asyncio.sleep(0.01)
                    active -= 1

            await asyncio.gather(*(run_child(index) for index in range(8)))

        assert max_active == 2
        assert sm._semaphore._value == 2

    @pytest.mark.asyncio
    async def test_repeated_slot_cancellation_does_not_leak_permits(self):
        sm = StreamManager()
        sm._semaphore = asyncio.Semaphore(2)
        parent = GenerationJob("parent-stream", "parent-session")
        parent._generation_slot_credit = asyncio.Semaphore(1)

        for index in range(25):
            child = GenerationJob(
                f"child-stream-{index}",
                f"child-session-{index}",
            )

            async def contend() -> None:
                async with sm.generation_slot(
                    timeout=None,
                    owner=child,
                    parent=parent,
                ):
                    await asyncio.sleep(10)

            contender = asyncio.create_task(contend())
            await asyncio.sleep(0)
            contender.cancel()
            await asyncio.sleep(0)
            contender.cancel()
            await asyncio.gather(contender, return_exceptions=True)

            assert parent._generation_slot_credit._value == 1
            assert sm._semaphore._value == 2

    @pytest.mark.asyncio
    async def test_child_abort_stops_global_wait_without_parent_credit(self):
        sm = StreamManager()
        sm._semaphore = asyncio.Semaphore(0)
        parent = GenerationJob("parent-stream", "parent-session")
        child = GenerationJob("child-stream", "child-session")

        async def wait_for_slot() -> None:
            async with sm.generation_slot(
                timeout=None,
                owner=child,
                parent=parent,
            ):
                raise AssertionError("aborted child must not enter the slot")

        waiter = asyncio.create_task(wait_for_slot())
        await asyncio.sleep(0)
        child.abort()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, timeout=0.2)
        assert sm._semaphore._value == 0
