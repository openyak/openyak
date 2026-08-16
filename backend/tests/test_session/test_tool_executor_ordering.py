"""Tools must execute in the order the model asked for them.

Results are reported in model order regardless of when they ran, so an
execution-order bug produces a transcript that looks correct and an answer that
is wrong. These tests assert on the *execution* log, never the returned order.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.session.tool_executor import (
    StreamingToolExecutor,
    ToolCallInfo,
)
from app.tool.base import ToolDefinition, ToolResult


class _RecordingTool(ToolDefinition):
    """A tool that logs when it starts and finishes, and can fail on demand."""

    def __init__(
        self,
        tool_id: str,
        log: list[str],
        *,
        concurrency_safe: bool,
        delay: float = 0.0,
        fails: bool = False,
        in_flight: dict[str, int] | None = None,
    ) -> None:
        self._id = tool_id
        self._log = log
        self._safe = concurrency_safe
        self._delay = delay
        self._fails = fails
        self._in_flight = in_flight if in_flight is not None else {"now": 0, "peak": 0}

    @property
    def id(self) -> str:
        return self._id

    @property
    def description(self) -> str:
        return self._id

    @property
    def is_concurrency_safe(self) -> bool:
        return self._safe

    def parameters_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any], ctx: Any) -> ToolResult:
        tag = args.get("tag", self._id)
        self._in_flight["now"] += 1
        self._in_flight["peak"] = max(self._in_flight["peak"], self._in_flight["now"])
        self._log.append(f"start:{tag}")
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
            if self._fails:
                raise RuntimeError(f"{tag} failed")
            return ToolResult(output=tag)
        finally:
            self._in_flight["now"] -= 1
            self._log.append(f"end:{tag}")

    async def __call__(self, args: dict[str, Any], ctx: Any) -> ToolResult:
        return await self.execute(args, ctx)


def _call(index: int, tool: ToolDefinition, tag: str) -> ToolCallInfo:
    return ToolCallInfo(
        index=index,
        tool=tool,
        tool_name=tool.id,
        tool_args={"tag": tag},
        call_id=f"call-{index:02d}",
        ctx=SimpleNamespace(is_aborted=False),
        timeout=5.0,
    )


async def test_an_exclusive_call_is_a_barrier_for_later_reads() -> None:
    """``[write(f), read(f)]`` must not answer from the pre-write file.

    The exclusive tool must actually suspend. Awaiting a coroutine that never
    yields does not hand control back to the loop, so an eagerly-started read
    could not interleave even without the barrier — and the test would pass
    against the very bug it names. Every real exclusive tool (write, edit,
    bash, apply_patch) does I/O and suspends.
    """
    log: list[str] = []
    write = _RecordingTool("write", log, concurrency_safe=False, delay=0.02)
    read = _RecordingTool("read", log, concurrency_safe=True)

    executor = StreamingToolExecutor(asyncio.Event())
    executor.submit(_call(0, write, "write"))
    executor.submit(_call(1, read, "read"))

    results = await executor.collect()

    assert log == ["start:write", "end:write", "start:read", "end:read"]
    assert [r.tool_name for r in results] == ["write", "read"]


async def test_an_exclusive_call_waits_for_reads_the_model_placed_first() -> None:
    """``[read(f), write(f)]`` must not write while the read is in flight."""
    log: list[str] = []
    read = _RecordingTool("read", log, concurrency_safe=True, delay=0.02)
    write = _RecordingTool("write", log, concurrency_safe=False)

    executor = StreamingToolExecutor(asyncio.Event())
    executor.submit(_call(0, read, "read"))
    executor.submit(_call(1, write, "write"))

    await executor.collect()

    assert log.index("end:read") < log.index("start:write")


async def test_adjacent_reads_still_run_in_parallel() -> None:
    """The barrier must not cost the overlap this executor exists for."""
    log: list[str] = []
    read = _RecordingTool("read", log, concurrency_safe=True, delay=0.05)

    executor = StreamingToolExecutor(asyncio.Event())
    for i in range(3):
        executor.submit(_call(i, read, f"read{i}"))

    started = asyncio.get_running_loop().time()
    await executor.collect()
    elapsed = asyncio.get_running_loop().time() - started

    assert elapsed < 0.12, "three 50ms reads run in parallel should not serialise"
    assert log[:3] == ["start:read0", "start:read1", "start:read2"]


async def test_parallel_fan_out_is_bounded() -> None:
    """One turn of web_fetch calls must not all hit the network at once."""
    log: list[str] = []
    in_flight = {"now": 0, "peak": 0}
    fetch = _RecordingTool(
        "web_fetch", log, concurrency_safe=True, delay=0.01, in_flight=in_flight
    )

    executor = StreamingToolExecutor(asyncio.Event(), max_parallel=3)
    for i in range(12):
        executor.submit(_call(i, fetch, f"fetch{i}"))

    results = await executor.collect()

    assert in_flight["peak"] <= 3
    assert len(results) == 12
    assert all(r.result is not None for r in results)


async def test_a_failed_bash_cancels_the_calls_queued_after_it() -> None:
    """The documented cascade must actually fire — bash is exclusive, and the
    cancellation used to live on a concurrent-only path it never reached."""
    log: list[str] = []
    bash = _RecordingTool("bash", log, concurrency_safe=False, fails=True)
    read = _RecordingTool("read", log, concurrency_safe=True)

    executor = StreamingToolExecutor(asyncio.Event())
    executor.submit(_call(0, bash, "bash"))
    executor.submit(_call(1, read, "after"))

    results = await executor.collect()

    assert "start:after" not in log
    assert results[1].aborted_by_sibling is True
    assert isinstance(results[1].error, asyncio.CancelledError)


async def test_a_failed_bash_keeps_results_the_model_asked_for_first() -> None:
    """Earlier calls already ran under correct state; their results stand."""
    log: list[str] = []
    read = _RecordingTool("read", log, concurrency_safe=True)
    bash = _RecordingTool("bash", log, concurrency_safe=False, fails=True)

    executor = StreamingToolExecutor(asyncio.Event())
    executor.submit(_call(0, read, "before"))
    executor.submit(_call(1, bash, "bash"))

    results = await executor.collect()

    assert results[0].result is not None
    assert results[0].result.output == "before"
    assert results[0].aborted_by_sibling is False
    assert results[1].error is not None


async def test_results_come_back_in_model_order() -> None:
    """Reporting order is independent of completion order."""
    log: list[str] = []
    slow = _RecordingTool("read", log, concurrency_safe=True, delay=0.04)
    fast = _RecordingTool("grep", log, concurrency_safe=True, delay=0.0)

    executor = StreamingToolExecutor(asyncio.Event())
    executor.submit(_call(0, slow, "slow"))
    executor.submit(_call(1, fast, "fast"))

    results = await executor.collect()

    assert [r.tool_args["tag"] for r in results] == ["slow", "fast"]
    assert log.index("end:fast") < log.index("end:slow")


async def test_external_abort_stops_work_that_has_not_started() -> None:
    abort = asyncio.Event()
    log: list[str] = []
    read = _RecordingTool("read", log, concurrency_safe=True)

    executor = StreamingToolExecutor(abort)
    executor.submit(_call(0, read, "one"))
    abort.set()
    executor.submit(_call(1, read, "two"))

    results = await executor.collect()

    assert len(results) == 2
    assert isinstance(results[1].error, asyncio.CancelledError)


@pytest.mark.parametrize("max_parallel", [0, -5])
async def test_a_nonsensical_limit_still_runs_one_at_a_time(max_parallel: int) -> None:
    log: list[str] = []
    in_flight = {"now": 0, "peak": 0}
    read = _RecordingTool(
        "read", log, concurrency_safe=True, delay=0.01, in_flight=in_flight
    )

    executor = StreamingToolExecutor(asyncio.Event(), max_parallel=max_parallel)
    for i in range(3):
        executor.submit(_call(i, read, f"read{i}"))
    await executor.collect()

    assert in_flight["peak"] == 1
