"""A retry must never re-run a tool that already ran.

Routing provider failures through the retry classifier made a path reachable
that could not happen before: a stream that fails *after* tool-call chunks were
dispatched. The executor and `_exec_metadata` outlive
`_reset_stream_accumulators`, so replaying the stream submits the same calls a
second time — and OpenYak's tools send email and write deliverables.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, AsyncIterator

from app.provider.base import ProviderStreamError
from app.schemas.provider import StreamChunk
from app.session.manager import create_message, create_session
from app.session.processor import SessionProcessor
from app.streaming.manager import GenerationJob
from app.tool.base import ToolDefinition, ToolResult


class _SideEffectTool(ToolDefinition):
    """Stands in for send_email: records every execution, cannot be undone."""

    def __init__(self, log: list[str]) -> None:
        self._log = log

    @property
    def id(self) -> str:
        return "send_email"

    @property
    def description(self) -> str:
        return "send an email"

    @property
    def is_concurrency_safe(self) -> bool:
        return True

    def parameters_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any], ctx: Any) -> ToolResult:
        self._log.append("SENT")
        return ToolResult(output="sent")

    async def __call__(self, args: dict[str, Any], ctx: Any) -> ToolResult:
        return await self.execute(args, ctx)


async def test_a_dispatched_tool_is_not_re_run_when_the_stream_then_fails(
    session_factory, monkeypatch
) -> None:
    """A drop after the tool-call chunk must end the step, not replay it.

    `openai_compat` emits accumulated tool calls at `finish_reason` and keeps
    reading for the trailing usage frame, so a connection reset there arrives
    with the tool already dispatched — and "connection" is retryable.
    """
    session_id = "retry-side-effect"
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)
            assistant = await create_message(
                db, session_id=session_id, data={"role": "assistant"}
            )

    sent: list[str] = []
    job = GenerationJob(f"{session_id}-stream", session_id)
    prompt = SimpleNamespace(
        job=job,
        session_factory=session_factory,
        provider=SimpleNamespace(id="generic"),
        model_id="test-model",
        request=SimpleNamespace(format=None),
        agent=SimpleNamespace(name="general", tools=[]),
        tool_registry=SimpleNamespace(to_openai_specs=lambda *a, **k: []),
        merged_permissions=None,
        discovered_tools=None,
        system_prompt=None,
    )
    processor = SessionProcessor(prompt, [], assistant.id)
    processor._init_step_state()

    async def build_args() -> tuple[Any, int, set[str] | None]:
        return None, 1024, None

    async def not_blocked() -> None:
        return None

    attempts = 0

    async def dispatch(chunk: Any) -> None:
        """Stand in for the real handler: submit straight to the executor."""
        from app.session.tool_executor import ToolCallInfo

        processor._streaming_executor.submit(
            ToolCallInfo(
                index=processor._exec_index,
                tool=_SideEffectTool(sent),
                tool_name="send_email",
                tool_args={},
                call_id=f"call-{processor._exec_index}",
                ctx=SimpleNamespace(is_aborted=False),
                timeout=5.0,
            )
        )
        processor._exec_index += 1

    async def flaky(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        nonlocal attempts
        attempts += 1
        yield StreamChunk(
            type="tool-call", data={"id": "c1", "name": "send_email", "arguments": {}}
        )
        yield StreamChunk(type="finish", data={"reason": "tool_calls"})
        raise ProviderStreamError("peer closed connection without sending a body")

    monkeypatch.setattr(processor, "_build_stream_args", build_args)
    monkeypatch.setattr(processor, "_check_vision_blocked", not_blocked)
    monkeypatch.setattr(processor, "_handle_tool_call_chunk", dispatch)
    monkeypatch.setattr("app.session.processor.stream_llm", flaky)

    async def no_sleep(delay: float, abort_event=None) -> bool:
        return False

    monkeypatch.setattr("app.session.processor.sleep_with_abort", no_sleep)

    await processor._stream_llm_with_retry()
    results = await processor._streaming_executor.collect()

    assert attempts == 1, "a retry here would dispatch the email a second time"
    assert sent.count("SENT") <= 1, f"the email was sent {len(sent)} times"
    assert len(results) == 1
    assert processor._stream_error is not None


async def test_a_failure_before_any_tool_call_still_retries(
    session_factory, monkeypatch
) -> None:
    """The common case — a 429 on connect — must keep its retry."""
    session_id = "retry-no-side-effect"
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)
            assistant = await create_message(
                db, session_id=session_id, data={"role": "assistant"}
            )

    job = GenerationJob(f"{session_id}-stream", session_id)
    prompt = SimpleNamespace(
        job=job,
        session_factory=session_factory,
        provider=SimpleNamespace(id="generic"),
        model_id="test-model",
        request=SimpleNamespace(format=None),
        agent=SimpleNamespace(name="general", tools=[]),
        tool_registry=SimpleNamespace(to_openai_specs=lambda *a, **k: []),
        merged_permissions=None,
        discovered_tools=None,
        system_prompt=None,
    )
    processor = SessionProcessor(prompt, [], assistant.id)
    processor._init_step_state()

    attempts = 0

    async def flaky(*args: Any, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ProviderStreamError("Error code: 429 - rate limited")
        yield StreamChunk(type="text-delta", data={"text": "recovered"})

    async def build_args() -> tuple[Any, int, set[str] | None]:
        return None, 1024, None

    async def not_blocked() -> None:
        return None

    async def no_sleep(delay: float, abort_event=None) -> bool:
        return False

    monkeypatch.setattr(processor, "_build_stream_args", build_args)
    monkeypatch.setattr(processor, "_check_vision_blocked", not_blocked)
    monkeypatch.setattr("app.session.processor.stream_llm", flaky)
    monkeypatch.setattr("app.session.processor.sleep_with_abort", no_sleep)

    await processor._stream_llm_with_retry()

    assert attempts == 2
    assert processor._accumulated_text == "recovered"
