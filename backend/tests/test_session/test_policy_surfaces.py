"""The pre-tool policy hook must actually run, and be order-independent.

``run_before_tool_exec`` was declared, implemented by LoopDetectionMiddleware,
and called by nobody — so the loop detector's warn stage never fired, and any
policy middleware a contributor added would have been silently inert.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.session.middleware import (
    Middleware,
    MiddlewareChain,
    MiddlewareContext,
    ToolAction,
)
from app.session.middlewares.loop_detection import LoopDetectionMiddleware
from app.streaming.manager import GenerationJob


class _Recorder(Middleware):
    def __init__(self, verdict: str, log: list[str], name: str) -> None:
        self._verdict = verdict
        self._log = log
        self._name = name

    async def before_tool_exec(
        self, tool_name: str, tool_args: dict[str, Any], ctx: MiddlewareContext
    ) -> ToolAction:
        self._log.append(self._name)
        return ToolAction(action=self._verdict, message=f"{self._name} says {self._verdict}")


def _ctx() -> MiddlewareContext:
    return MiddlewareContext(
        session_id="policy-session", step=0, job=GenerationJob("s", "policy-session")
    )


async def test_the_strictest_verdict_wins_regardless_of_order() -> None:
    for order in (["allow", "block", "warn"], ["block", "warn", "allow"]):
        chain = MiddlewareChain()
        log: list[str] = []
        for index, verdict in enumerate(order):
            chain.add(_Recorder(verdict, log, f"{verdict}{index}"))

        decision = await chain.run_before_tool_exec("bash", {}, _ctx())

        assert decision.action == "block"
        assert len(log) == len(order), "every middleware must run, even after a block"


async def test_a_blocking_middleware_does_not_starve_a_later_observer() -> None:
    """Loop detection counts calls; a block above it must not stop the counter."""
    chain = MiddlewareChain()
    log: list[str] = []
    chain.add(_Recorder("block", log, "gate"))
    chain.add(_Recorder("allow", log, "counter"))

    await chain.run_before_tool_exec("bash", {}, _ctx())

    assert log == ["gate", "counter"]


async def test_loop_detection_warn_stage_reaches_the_tool_output() -> None:
    """The warn message is stashed in before_tool_exec and appended after —
    with the hook uncalled, neither half ever ran."""
    from app.session.loop_detection import loop_detector

    chain = MiddlewareChain()
    chain.add(LoopDetectionMiddleware())
    ctx = _ctx()
    loop_detector.reset(ctx.session_id)

    warned = False
    for _ in range(10):
        decision = await chain.run_before_tool_exec("read", {"path": "same.txt"}, ctx)
        if decision.action == "block":
            break
        output = await chain.run_after_tool_exec(
            "read", {"path": "same.txt"}, "file contents", ctx
        )
        if output != "file contents":
            warned = True
            break

    assert warned, "repeating one identical call must eventually warn the model"


def test_ask_defaults_closed_when_nobody_can_be_asked() -> None:
    """A permission primitive with no way to prompt must not self-approve."""
    import asyncio

    from app.tool.context import ToolContext

    ctx = ToolContext(
        session_id="s",
        message_id="m",
        agent=None,
        call_id="c",
        abort_event=asyncio.Event(),
    )
    assert asyncio.run(ctx.ask("bash")) is False


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        ({"input": 1_000_000, "output": 0}, 3.0),
        ({"input": 0, "output": 1_000_000}, 15.0),
        # Cached input used to cost nothing at all.
        ({"input": 0, "output": 0, "cache_read": 1_000_000}, 0.3),
        # Cache writes stay inside `input` on the OpenAI-shaped path, so
        # pricing them separately here would bill them twice.
        ({"input": 0, "output": 0, "cache_write": 1_000_000}, 0.0),
    ],
)
def test_cached_tokens_are_priced(usage: dict[str, int], expected: float) -> None:
    from app.schemas.provider import ModelInfo, ModelPricing
    from app.session.utils import calculate_step_cost

    model = ModelInfo(
        id="m",
        name="m",
        provider_id="p",
        pricing=ModelPricing(
            prompt=3.0, completion=15.0, cache_read=0.3, cache_write=3.75
        ),
    )
    assert calculate_step_cost(usage, model) == pytest.approx(expected)


def test_an_unpublished_cache_rate_is_not_guessed() -> None:
    """Substituting the prompt price over-states by ~10x — worse than zero.

    Anthropic reads cache at roughly 0.1x prompt. A provider whose catalog does
    not publish the rate gets no cache term, exactly as before; the fix is to
    publish the rate, which models.dev already parses.
    """
    from app.schemas.provider import ModelInfo, ModelPricing
    from app.session.utils import calculate_step_cost

    model = ModelInfo(
        id="m", name="m", provider_id="p", pricing=ModelPricing(prompt=3.0, completion=15.0)
    )
    cost = calculate_step_cost({"input": 0, "output": 0, "cache_read": 1_000_000}, model)
    assert cost == pytest.approx(0.0)
