"""Streaming tool executor — overlaps tool I/O with LLM streaming.

Tools are submitted as their call chunks arrive, so a read can start before the
model has finished writing the next call. That overlap is the point of this
class; the ordering rules below are what keep it safe.

**Execution follows model order.** An exclusive tool is a barrier: everything
the model asked for before it finishes first, and nothing after it starts until
it is done. Running every concurrent tool first and the exclusive ones
afterwards would be faster and wrong — the model that emits
``[write(f), read(f)]`` means "write, then read what I wrote", and reordering
silently answers from the pre-write file. Results are reported in model order
either way, so a reordering bug is invisible in the transcript.

**Concurrency is bounded.** A run of consecutive concurrency-safe calls executes
in parallel up to ``max_parallel_tool_calls``. Unbounded fan-out puts one
model turn's worth of ``web_fetch`` calls on the network at once, from the
user's own machine and against their own rate limits.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext

logger = logging.getLogger(__name__)


# A failure in one of these cancels the calls the model placed *after* it.
# Bash commands form implicit dependency chains — once one fails, running the
# rest produces confusing cascading errors against a state that never happened.
# Only later calls are cancelled: an earlier one has already run, and under the
# barrier rules its result was correct when it was produced.
SIBLING_ABORT_TOOLS = frozenset({"bash"})


@dataclass
class ToolCallInfo:
    """A single tool call to be executed."""

    index: int  # Submission order
    tool: ToolDefinition
    tool_name: str
    tool_args: dict[str, Any]
    call_id: str
    ctx: ToolContext
    timeout: float = 300.0


@dataclass
class ToolExecutionResult:
    """Result of a single tool execution."""

    index: int
    tool_name: str
    call_id: str
    tool_args: dict[str, Any]
    result: ToolResult | None = None
    error: Exception | None = None
    timed_out: bool = False
    aborted_by_sibling: bool = False


async def _execute_single(info: ToolCallInfo) -> ToolExecutionResult:
    """Execute a single tool call with timeout and error handling."""
    if info.ctx.is_aborted:
        return ToolExecutionResult(
            index=info.index, tool_name=info.tool_name,
            call_id=info.call_id, tool_args=info.tool_args,
            error=asyncio.CancelledError("Aborted"),
        )
    try:
        result = await asyncio.wait_for(
            info.tool(info.tool_args, info.ctx),
            timeout=info.timeout,
        )
        return ToolExecutionResult(
            index=info.index, tool_name=info.tool_name,
            call_id=info.call_id, tool_args=info.tool_args,
            result=result,
        )
    except asyncio.TimeoutError:
        return ToolExecutionResult(
            index=info.index, tool_name=info.tool_name,
            call_id=info.call_id, tool_args=info.tool_args,
            timed_out=True,
        )
    except Exception as e:
        return ToolExecutionResult(
            index=info.index, tool_name=info.tool_name,
            call_id=info.call_id, tool_args=info.tool_args,
            error=e,
        )


class StreamingToolExecutor:
    """Manages tool execution during and after LLM streaming.

    Usage:
        executor = StreamingToolExecutor(abort_event)

        # During streaming — called each time a tool-call chunk arrives:
        executor.submit(tool_call_info)

        # After streaming completes — wait for all results:
        results = await executor.collect()
    """

    def __init__(
        self, abort_event: asyncio.Event, *, max_parallel: int | None = None
    ) -> None:
        self._abort = abort_event
        self._calls: list[ToolCallInfo] = []
        self._started: dict[int, asyncio.Task] = {}
        self._results: dict[int, ToolExecutionResult] = {}
        self._barrier_pending = False
        self._sibling_errored = False
        self._sibling_error_desc = ""
        if max_parallel is None:
            from app.config import get_settings

            max_parallel = get_settings().max_parallel_tool_calls
        self._slots = asyncio.Semaphore(max(1, max_parallel))

    def submit(self, info: ToolCallInfo) -> None:
        """Record a tool call in model order, starting it early when that is safe.

        A concurrency-safe call may start during streaming only while no
        exclusive call is still outstanding ahead of it. Once one is queued it
        becomes a barrier, and everything after waits for :meth:`collect` to
        reach it in order.
        """
        self._calls.append(info)

        if not info.tool.is_concurrency_safe:
            self._barrier_pending = True
            logger.debug(
                "Queued exclusive tool %s (call_id=%s); it is a barrier for later calls",
                info.tool_name, info.call_id[:8],
            )
            return

        if self._barrier_pending:
            logger.debug(
                "Deferred %s (call_id=%s) behind an earlier exclusive tool",
                info.tool_name, info.call_id[:8],
            )
            return

        self._started[info.index] = asyncio.create_task(
            self._run(info), name=f"tool-{info.tool_name}-{info.call_id[:8]}"
        )
        logger.info(
            "Started concurrent tool %s (call_id=%s) during streaming",
            info.tool_name, info.call_id[:8],
        )

    async def _run(self, info: ToolCallInfo) -> ToolExecutionResult:
        """Execute one call, holding a concurrency slot for its duration."""
        async with self._slots:
            return await _execute_single(info)

    async def collect(self) -> list[ToolExecutionResult]:
        """Run everything still outstanding in model order and return all results."""
        position = 0
        while position < len(self._calls):
            if self._calls[position].tool.is_concurrency_safe:
                group: list[ToolCallInfo] = []
                while (
                    position < len(self._calls)
                    and self._calls[position].tool.is_concurrency_safe
                ):
                    group.append(self._calls[position])
                    position += 1
                await self._run_group(group)
            else:
                await self._run_exclusive(self._calls[position])
                position += 1

        return [
            self._results[info.index]
            for info in self._calls
            if info.index in self._results
        ]

    async def _run_group(self, group: list[ToolCallInfo]) -> None:
        """Run a run of adjacent concurrency-safe calls together."""
        if self._stopped:
            # Calls already started keep running inside ``await tool(...)`` —
            # the abort check in _execute_single only guards the moment before
            # dispatch. Cancel and reap them rather than reporting "Aborted"
            # while they carry on writing files in the background.
            #
            # Cancel every one first, then reap: a cancellation landing on us
            # mid-reap would otherwise leave the untouched remainder running.
            # Recording the outcomes goes in a `finally` for the same reason.
            live = [t for t in (self._started.get(i.index) for i in group) if t]
            for task in live:
                task.cancel()
            try:
                if live:
                    await asyncio.gather(*live, return_exceptions=True)
            finally:
                for info in group:
                    self._record_cancelled(info)
            return

        tasks: dict[int, asyncio.Task] = {}
        for info in group:
            task = self._started.get(info.index)
            if task is None:
                task = asyncio.create_task(
                    self._run(info), name=f"tool-{info.tool_name}-{info.call_id[:8]}"
                )
                # Register it: ``_started`` is the one place that knows which
                # calls have a live task, and cancel_all/harvest_finished both
                # read it. A task created only here would be invisible to both,
                # so aborting a turn could not stop anything queued behind a
                # barrier.
                self._started[info.index] = task
            tasks[info.index] = task

        try:
            for info in group:
                await self._settle(info, tasks[info.index])
        finally:
            # Whatever ended this group — an abort mid-way, or the caller being
            # cancelled — no task in it may outlive it unobserved.
            pending = [t for t in tasks.values() if not t.done()]
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    async def _run_exclusive(self, info: ToolCallInfo) -> None:
        """Run one barrier call; everything before it has already settled."""
        if self._stopped:
            self._record_cancelled(info)
            return

        result = await _execute_single(info)
        self._results[info.index] = result
        self._note_sibling_abort(info, result)

    async def _settle(self, info: ToolCallInfo, task: asyncio.Task) -> None:
        """Await one started call and record whatever it produced."""
        if self._stopped and not task.done():
            task.cancel()
        try:
            result = await task
        except asyncio.CancelledError:
            self._record_cancelled(info)
            # Distinguish "this tool was cancelled" from "the caller awaiting us
            # was cancelled". Swallowing the latter makes collect() return
            # normally, and asyncio never re-delivers it — so the processor's
            # cancellation cleanup (persist partial output, terminate running
            # ToolParts) is skipped and the turn looks like it finished.
            #
            # `task.cancelled()` is the reliable discriminator. `Task.cancelling()`
            # is not: it is a monotone counter reset only by `uncancel()`, which
            # nothing in this codebase calls, while the processor has several
            # `except CancelledError: continue` shield loops that bump it. A
            # caller carrying a stale count would see every later tool
            # cancellation re-raised.
            if not task.cancelled():
                raise
            return
        except Exception as exc:  # a crash inside the wrapper, not the tool
            self._results[info.index] = ToolExecutionResult(
                index=info.index, tool_name=info.tool_name,
                call_id=info.call_id, tool_args=info.tool_args,
                error=exc,
            )
            return

        self._results[info.index] = result
        self._note_sibling_abort(info, result)

    def _note_sibling_abort(
        self, info: ToolCallInfo, result: ToolExecutionResult
    ) -> None:
        """Latch the cascade flag when a dependency-chain tool fails."""
        # ``ToolDefinition.__call__`` catches everything a tool raises and
        # returns it as ``ToolResult.error``, so the executor almost never sees
        # ``ToolExecutionResult.error`` set for an ordinary failure. Checking
        # only that field is why this cascade has never fired. A timeout counts
        # too: a build that never finished did not succeed.
        failed = (
            result.error is not None
            or result.timed_out
            or (result.result is not None and result.result.error is not None)
        )
        if (
            not failed
            or info.tool_name not in SIBLING_ABORT_TOOLS
            or self._sibling_errored
        ):
            return

        self._sibling_errored = True
        summary = str(info.tool_args.get("command", ""))[:40]
        self._sibling_error_desc = f"{info.tool_name}({summary})" if summary else info.tool_name
        logger.info(
            "%s (call_id=%s) errored — cancelling the calls queued after it",
            info.tool_name, info.call_id[:8],
        )
        self.cancel_all()

    @property
    def _stopped(self) -> bool:
        return self._abort.is_set() or self._sibling_errored

    def _record_cancelled(self, info: ToolCallInfo) -> None:
        message = (
            f"Cancelled: earlier tool call {self._sibling_error_desc} errored"
            if self._sibling_errored
            else "Aborted"
        )
        self._results[info.index] = ToolExecutionResult(
            index=info.index, tool_name=info.tool_name,
            call_id=info.call_id, tool_args=info.tool_args,
            error=asyncio.CancelledError(message),
            aborted_by_sibling=self._sibling_errored,
        )

    def harvest_finished(self) -> list[ToolExecutionResult]:
        """Results from calls that already ran, without starting any more.

        For teardown: a turn abandoned mid-stream still has tools that
        completed during it. Recording those as "cancelled" tells the user an
        email was not sent when it was. Nothing not already running is started.
        """
        harvested: list[ToolExecutionResult] = []
        for info in self._calls:
            existing = self._results.get(info.index)
            if existing is not None:
                harvested.append(existing)
                continue
            task = self._started.get(info.index)
            if task is None or not task.done() or task.cancelled():
                continue
            if task.exception() is not None:
                continue
            result = task.result()
            self._results[info.index] = result
            harvested.append(result)
        return harvested

    def cancel_all(self) -> None:
        """Cancel every started call that has not finished."""
        for index, task in self._started.items():
            if not task.done():
                task.cancel()
                logger.debug("Cancelled in-flight tool at index %d", index)

    @property
    def has_submissions(self) -> bool:
        return bool(self._calls)
