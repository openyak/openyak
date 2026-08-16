"""The pre-execution verdict must survive to finalization intact.

``_handle_tool_call_chunk`` computes a ``ToolAction``, stores it in
``_exec_metadata``, and ``_build_tool_persist_output`` reads ``.action`` off it
much later. An interactive permission prompt runs in between and used to rebind
the same local name to its own ``{allowed, remember, pattern}`` dict.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.agent.agent import BUILTIN_AGENTS
from app.agent.permission import GLOBAL_DEFAULTS, merge_rulesets
from app.schemas.agent import PermissionRule, Ruleset
from app.session.manager import create_message, create_session
from app.session.middleware import MiddlewareContext, ToolAction
from app.session.middlewares.factory import build_middleware_chain
from app.session.processor import SessionProcessor
from app.streaming.manager import GenerationJob
from app.tool.base import ToolDefinition, ToolResult
from app.tool.registry import ToolRegistry


class _Echo(ToolDefinition):
    def __init__(self, tool_id: str = "read") -> None:
        self._id = tool_id

    @property
    def id(self) -> str:
        return self._id

    @property
    def description(self) -> str:
        return self._id

    @property
    def is_concurrency_safe(self) -> bool:
        return True

    def parameters_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {"path": {"type": "string"}}}

    async def execute(self, args: dict[str, Any], ctx: Any) -> ToolResult:
        return ToolResult(output="contents")


async def _processor(session_factory, session_id: str, *, with_chain: bool):
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)
            assistant = await create_message(
                db, session_id=session_id, data={"role": "assistant"}
            )

    registry = ToolRegistry()
    registry.register(_Echo())
    job = GenerationJob(f"{session_id}-stream", session_id)
    job.interactive = True

    agent = BUILTIN_AGENTS["build"]
    prompt = SimpleNamespace(
        job=job,
        session_factory=session_factory,
        agent=agent,
        tool_registry=registry,
        # `read` resolves to ask, so the interactive prompt runs.
        merged_permissions=merge_rulesets(
            GLOBAL_DEFAULTS,
            Ruleset(rules=[PermissionRule(action="ask", permission="read")]),
        ),
        inheritable_permissions=Ruleset(),
        workspace=None,
        discovered_tools=None,
        model_id="m",
        provider=SimpleNamespace(id="p"),
        request=SimpleNamespace(reasoning=None, execution_mode="standard", format=None),
        current_todos=[],
        middleware_chain=build_middleware_chain(),
        step=0,
        provider_registry=SimpleNamespace(resolve_model=lambda *a, **k: None),
        agent_registry=SimpleNamespace(get=lambda name: None),
        index_manager=None,
        session_id=session_id,
        total_cost=0.0,
    )
    ctx = (
        MiddlewareContext(session_id=session_id, step=0, job=job)
        if with_chain
        else None
    )
    processor = SessionProcessor(prompt, [], assistant.id, middleware_ctx=ctx)
    processor._init_step_state()
    processor._advertised_tool_ids = {"read"}
    return processor


@pytest.mark.parametrize("with_chain", [True, False], ids=["with chain", "chain-less"])
async def test_an_approved_ask_leaves_a_toolaction_in_the_metadata(
    session_factory, monkeypatch, with_chain: bool
) -> None:
    """The user approving a prompt must not overwrite the policy verdict.

    The chain-less branch is covered too: it is the one the same change kept
    alive so loop protection is never silently absent, and it is where a dict
    here becomes an AttributeError during finalization.
    """
    processor = await _processor(
        session_factory, f"ask-{with_chain}", with_chain=with_chain
    )

    async def approve(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"allowed": True, "remember": False, "pattern": None}

    monkeypatch.setattr("app.session.processor._ask_permission", approve)

    await processor._handle_tool_call_chunk(
        SimpleNamespace(
            data={"id": "call-1", "name": "read", "arguments": {"path": "a.txt"}}
        )
    )

    assert processor._exec_metadata, "the call should have been dispatched"
    stored = processor._exec_metadata[0]["policy_decision"]
    assert isinstance(stored, ToolAction), f"got {stored!r}"
    assert stored.action in {"allow", "warn"}


async def test_the_approved_call_finalizes_without_crashing(
    session_factory, monkeypatch
) -> None:
    """End to end on the chain-less branch, where the dict used to be read."""
    processor = await _processor(session_factory, "ask-finalize", with_chain=False)

    async def approve(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"allowed": True, "remember": False, "pattern": None}

    monkeypatch.setattr("app.session.processor._ask_permission", approve)

    await processor._handle_tool_call_chunk(
        SimpleNamespace(
            data={"id": "call-1", "name": "read", "arguments": {"path": "a.txt"}}
        )
    )
    results = await processor._streaming_executor.collect()
    assert len(results) == 1

    meta = processor._exec_metadata[results[0].index]
    output = await processor._build_tool_persist_output(
        meta["tool"], meta["tool_args"], results[0].result, meta["policy_decision"]
    )
    assert "contents" in output


async def test_a_loop_warning_lands_on_the_call_that_earned_it(session_factory) -> None:
    """One shared slot would append it to whichever call finalizes first."""
    from app.session.loop_detection import loop_detector

    chain = build_middleware_chain()
    ctx = MiddlewareContext(
        session_id="warn-routing", step=0, job=GenerationJob("s", "warn-routing")
    )
    loop_detector.reset(ctx.session_id)

    repeated = {"path": "same.txt"}

    warned_on_repeat = False
    for attempt in range(12):
        if (await chain.run_before_tool_exec("read", repeated, ctx)).action == "block":
            break
        # A distinct sibling in the same step: never repeated, so it earns no
        # warning of its own and must not carry the repeated call's.
        other = {"pattern": f"needle-{attempt}"}
        await chain.run_before_tool_exec("grep", other, ctx)

        stolen = await chain.run_after_tool_exec("grep", other, "grep output", ctx)
        assert stolen == "grep output", "the warning belongs to the repeated call"

        earned = await chain.run_after_tool_exec("read", repeated, "file body", ctx)
        if earned != "file body":
            warned_on_repeat = True
            break

    assert warned_on_repeat, "the repeated call must eventually carry the warning"
