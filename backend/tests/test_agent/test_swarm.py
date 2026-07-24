from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.agent import AgentRegistry
from app.agent.swarm import SwarmCoordinator, SwarmRunContext, SwarmTaskSpec
from app.models.base import Base
from app.provider.base import BaseProvider
from app.provider.registry import ProviderRegistry
from app.schemas.agent import AgentInfo, PermissionRule, Ruleset
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ProviderStatus,
    StreamChunk,
)
from app.session.manager import (
    create_message,
    create_session,
    delete_session_cascade,
    get_messages,
)
from app.streaming.events import PERMISSION_REQUEST, SWARM_STATE, TEXT_DELTA, SSEEvent
from app.streaming.manager import GenerationJob, StreamManager
from app.tool.base import ToolDefinition, ToolResult
from app.tool.builtin.write import WriteTool
from app.tool.context import ToolContext
from app.tool.registry import ToolRegistry


pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def swarm_session_factory(tmp_path):
    """File-backed SQLite permits the overlapping transactions Swarm uses."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'swarm.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    await engine.dispose()


class _ConcurrentProvider(BaseProvider):
    """Deterministic Provider adapter that records overlapping child runs."""

    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0

    @property
    def id(self) -> str:
        return "swarm-test"

    async def list_models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                id="swarm-model",
                name="Swarm test model",
                provider_id=self.id,
                capabilities=ModelCapabilities(
                    function_calling=True,
                    max_context=32_000,
                    max_output=1_024,
                ),
            )
        ]

    async def stream_chat(
        self,
        model: str,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        system: str | list[dict] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict | None = None,
        response_format: dict | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del model, tools, system, temperature, max_tokens, extra_body, response_format
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            # A sequential implementation can never observe max_active == 2.
            await asyncio.sleep(0.03)
            prompt = str(messages[-1].get("content", ""))
            yield StreamChunk(type="text-delta", data={"text": f"result for {prompt}"})
            yield StreamChunk(type="finish", data={"reason": "stop"})
        finally:
            self.active -= 1

    async def health_check(self) -> ProviderStatus:
        return ProviderStatus(status="connected", model_count=1)


class _PartialFailureProvider(_ConcurrentProvider):
    async def stream_chat(
        self,
        model: str,
        messages: list[dict],
        **kwargs,
    ) -> AsyncIterator[StreamChunk]:
        prompt = str(messages[-1].get("content", ""))
        if "broken" in prompt:
            raise RuntimeError("synthetic child failure")
        async for chunk in super().stream_chat(
            model,
            messages,
            **kwargs,
        ):
            yield chunk


class _UnadvertisedWriteProvider(_ConcurrentProvider):
    def __init__(self, target_path: str) -> None:
        super().__init__()
        self.target_path = target_path
        self.calls = 0

    async def stream_chat(
        self,
        model: str,
        messages: list[dict],
        **kwargs,
    ) -> AsyncIterator[StreamChunk]:
        del model, messages, kwargs
        self.calls += 1
        if self.calls == 1:
            yield StreamChunk(
                type="tool-call",
                data={
                    "id": "malicious-write",
                    "name": "write",
                    "arguments": {
                        "file_path": self.target_path,
                        "content": "must not be written",
                    },
                },
            )
            yield StreamChunk(type="finish", data={"reason": "tool_use"})
            return
        yield StreamChunk(type="text-delta", data={"text": "safe result"})
        yield StreamChunk(type="finish", data={"reason": "stop"})


class _SelectiveTimeoutProvider(_ConcurrentProvider):
    async def stream_chat(
        self,
        model: str,
        messages: list[dict],
        **kwargs,
    ) -> AsyncIterator[StreamChunk]:
        del model, kwargs
        prompt = str(messages[-1].get("content", ""))
        if "slow" in prompt:
            await asyncio.sleep(1.0)
        yield StreamChunk(type="text-delta", data={"text": f"result for {prompt}"})
        yield StreamChunk(type="finish", data={"reason": "stop"})


class _BlockingProvider(_ConcurrentProvider):
    async def stream_chat(
        self,
        model: str,
        messages: list[dict],
        **kwargs,
    ) -> AsyncIterator[StreamChunk]:
        del model, messages, kwargs
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(10)
            yield StreamChunk(type="finish", data={"reason": "stop"})
        finally:
            self.active -= 1


class _UnknownWorkspaceTool(ToolDefinition):
    """A custom/connector-like Tool with unknown workspace side effects."""

    @property
    def id(self) -> str:
        return "custom_workspace_action"

    @property
    def description(self) -> str:
        return "Potentially mutate a workspace through a custom integration"

    def parameters_schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(
        self,
        args: dict[str, Any],
        ctx: ToolContext,
    ) -> ToolResult:
        del args, ctx
        return ToolResult(output="ok")


async def _wait_for_swarm_member_status(
    job: GenerationJob,
    status: str,
    *,
    after_revision: int = 0,
    timeout: float = 1.0,
) -> int:
    async def wait() -> int:
        while True:
            revisions = [
                int(event.data.get("revision", 0))
                for event in job.events
                if event.event == SWARM_STATE
                and int(event.data.get("revision", 0)) > after_revision
                and any(
                    member.get("status") == status
                    for member in event.data.get("members", [])
                )
            ]
            if revisions:
                return max(revisions)
            await asyncio.sleep(0)

    return await asyncio.wait_for(wait(), timeout=timeout)


async def test_swarm_runs_child_agents_concurrently_and_persists_one_state_part(
    swarm_session_factory,
    tmp_path,
) -> None:
    session_factory = swarm_session_factory
    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    parent_session_id = "parent-session"
    async with session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id=parent_session_id,
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id=parent_session_id,
                data={"role": "assistant", "agent": "ultra"},
            )

    parent_job = GenerationJob("parent-stream", parent_session_id)
    coordinator = SwarmCoordinator(
        session_factory=session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    )

    outcome = await coordinator.run(
        [
            SwarmTaskSpec(title="Inspect backend", prompt="backend"),
            SwarmTaskSpec(title="Inspect frontend", prompt="frontend"),
        ],
        SwarmRunContext(
            parent_job=parent_job,
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert provider.max_active == 2
    assert outcome.status == "completed"
    assert [member.status for member in outcome.members] == ["completed", "completed"]
    assert all(member.session_id for member in outcome.members)

    state_events = [event for event in parent_job.events if event.event == SWARM_STATE]
    assert state_events[0].data["status"] == "running"
    assert state_events[-1].data["status"] == "completed"
    revisions = [event.data["revision"] for event in state_events]
    assert revisions == sorted(set(revisions))

    async with session_factory() as db:
        messages = await get_messages(db, parent_session_id)

    swarm_parts = [
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    ]
    assert len(swarm_parts) == 1
    assert swarm_parts[0]["status"] == "completed"
    assert [member["title"] for member in swarm_parts[0]["members"]] == [
        "Inspect backend",
        "Inspect frontend",
    ]


async def test_swarm_publishes_waiting_input_and_resumes_live_member_status(
    swarm_session_factory,
    tmp_path,
    monkeypatch,
) -> None:
    providers = ProviderRegistry()
    provider = _ConcurrentProvider()
    providers.register(provider)
    await providers.refresh_models()

    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="interactive-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="interactive-parent",
                data={"role": "assistant", "agent": "ultra"},
            )

    parent_job = GenerationJob("interactive-stream", "interactive-parent")
    parent_job.interactive = True
    coordinator = SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    )
    permission_published = asyncio.Event()
    resume_child = asyncio.Event()
    finish_child = asyncio.Event()

    async def fake_run_member(
        spec,
        member,
        context,
        *,
        child_job,
    ) -> None:
        del spec, context
        child_job.publish(
            SSEEvent(
                PERMISSION_REQUEST,
                {"call_id": "permission-1", "tool": "write"},
            )
        )
        permission_published.set()
        await resume_child.wait()
        child_job.publish(SSEEvent(TEXT_DELTA, {"text": "resumed"}))
        await finish_child.wait()
        member.status = "completed"
        member.output = "done"

    monkeypatch.setattr(coordinator, "_run_member", fake_run_member)
    run_task = asyncio.create_task(
        coordinator.run(
            [SwarmTaskSpec(title="Interactive worker", prompt="edit")],
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
            ),
        )
    )

    await asyncio.wait_for(permission_published.wait(), timeout=1)
    waiting_revision = await _wait_for_swarm_member_status(
        parent_job,
        "waiting_input",
    )
    resume_child.set()
    running_revision = await _wait_for_swarm_member_status(
        parent_job,
        "running",
        after_revision=waiting_revision,
    )
    assert running_revision > waiting_revision
    finish_child.set()

    outcome = await asyncio.wait_for(run_task, timeout=1)
    assert outcome.status == "completed"


async def test_swarm_serializes_agents_that_can_mutate_the_workspace(
    swarm_session_factory,
    tmp_path,
) -> None:
    session_factory = swarm_session_factory
    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="mutation-parent", directory=str(tmp_path))
            parent_message = await create_message(
                db,
                session_id="mutation-parent",
                data={"role": "assistant", "agent": "build"},
            )

    tools = ToolRegistry()
    tools.register(WriteTool())
    coordinator = SwarmCoordinator(
        session_factory=session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=tools,
    )
    outcome = await coordinator.run(
        [
            SwarmTaskSpec(title="Writer one", prompt="one", agent="general"),
            SwarmTaskSpec(title="Writer two", prompt="two", agent="general"),
        ],
        SwarmRunContext(
            parent_job=GenerationJob("mutation-stream", "mutation-parent"),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert outcome.status == "completed"
    assert provider.max_active == 1


async def test_swarm_conservatively_serializes_unknown_custom_tools(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    agents = AgentRegistry()
    agents.register(AgentInfo(
        name="custom-worker",
        description="Worker backed by a custom Tool",
        mode="subagent",
        tools=["custom_workspace_action"],
        permissions=Ruleset(rules=[
            PermissionRule(
                action="allow",
                permission="custom_workspace_action",
            ),
        ]),
    ))
    tools = ToolRegistry()
    tools.register(_UnknownWorkspaceTool())

    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="custom-tool-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="custom-tool-parent",
                data={"role": "assistant", "agent": "build"},
            )

    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=agents,
        tool_registry=tools,
    ).run(
        [
            SwarmTaskSpec(
                title="Custom worker one",
                prompt="one",
                agent="custom-worker",
            ),
            SwarmTaskSpec(
                title="Custom worker two",
                prompt="two",
                agent="custom-worker",
            ),
        ],
        SwarmRunContext(
            parent_job=GenerationJob(
                "custom-tool-stream",
                "custom-tool-parent",
            ),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert outcome.status == "completed"
    assert provider.max_active == 1


async def test_swarm_child_capacity_wait_uses_group_lifetime_not_short_default(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="capacity-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="capacity-parent",
                data={"role": "assistant", "agent": "build"},
            )

    class _RecordingStreamManager(StreamManager):
        def __init__(self) -> None:
            super().__init__()
            self.child_timeouts: list[float | None] = []

        def generation_slot(
            self,
            timeout: float | None = 30.0,
            *,
            owner: GenerationJob | None = None,
            parent: GenerationJob | None = None,
        ):
            if parent is not None:
                self.child_timeouts.append(timeout)
            return super().generation_slot(
                timeout=timeout,
                owner=owner,
                parent=parent,
            )

    stream_manager = _RecordingStreamManager()
    parent_job = GenerationJob("capacity-stream", "capacity-parent")
    # Simulate the root API holding a transferable generation permit while
    # the Swarm Tool coordinates its children.
    async with stream_manager.generation_slot(owner=parent_job):
        outcome = await SwarmCoordinator(
            session_factory=swarm_session_factory,
            provider_registry=providers,
            agent_registry=AgentRegistry(),
            tool_registry=ToolRegistry(),
            stream_manager=stream_manager,
        ).run(
            [
                SwarmTaskSpec(title="First", prompt="one"),
                SwarmTaskSpec(title="Second", prompt="two"),
            ],
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
                timeout_seconds=1,
            ),
        )

    assert outcome.status == "completed"
    assert stream_manager.child_timeouts == [None, None]


async def test_swarm_isolates_child_failure_and_joins_remaining_results(
    swarm_session_factory,
    tmp_path,
) -> None:
    session_factory = swarm_session_factory
    provider = _PartialFailureProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="partial-parent", directory=str(tmp_path))
            parent_message = await create_message(
                db,
                session_id="partial-parent",
                data={"role": "assistant", "agent": "build"},
            )

    coordinator = SwarmCoordinator(
        session_factory=session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    )
    outcome = await coordinator.run(
        [
            SwarmTaskSpec(title="Healthy worker", prompt="healthy"),
            SwarmTaskSpec(title="Broken worker", prompt="broken"),
        ],
        SwarmRunContext(
            parent_job=GenerationJob("partial-stream", "partial-parent"),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert outcome.status == "partial"
    assert [member.status for member in outcome.members] == [
        "completed",
        "failed",
    ]
    assert "result for healthy" in outcome.output
    assert "synthetic child failure" in outcome.members[1].error
    assert "synthetic child failure" in outcome.output


async def test_swarm_isolates_member_state_write_failure_and_reaches_terminal(
    swarm_session_factory,
    tmp_path,
    monkeypatch,
) -> None:
    import app.agent.swarm as swarm_module

    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="state-failure-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="state-failure-parent",
                data={"role": "assistant", "agent": "build"},
            )

    real_update = swarm_module.update_part_data
    failed_once = False

    async def flaky_update(db, part_id, data):
        nonlocal failed_once
        if (
            not failed_once
            and data.get("status") == "running"
            and any(
                member.get("status") == "running"
                for member in data.get("members", [])
            )
        ):
            failed_once = True
            raise RuntimeError("synthetic Swarm state write failure")
        return await real_update(db, part_id, data)

    monkeypatch.setattr(swarm_module, "update_part_data", flaky_update)
    parent_job = GenerationJob(
        "state-failure-stream",
        "state-failure-parent",
    )
    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    ).run(
        [
            SwarmTaskSpec(title="Flaky state worker", prompt="one"),
            SwarmTaskSpec(title="Healthy state worker", prompt="two"),
        ],
        SwarmRunContext(
            parent_job=parent_job,
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert failed_once is True
    assert outcome.status == "partial"
    assert {member.status for member in outcome.members} == {
        "completed",
        "failed",
    }
    assert any(
        "synthetic Swarm state write failure" in (member.error or "")
        for member in outcome.members
    )
    async with swarm_session_factory() as db:
        messages = await get_messages(db, "state-failure-parent")
    persisted = next(
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    )
    assert persisted["status"] == "partial"


async def test_swarm_retries_transient_terminal_state_write(
    swarm_session_factory,
    tmp_path,
    monkeypatch,
) -> None:
    import app.agent.swarm as swarm_module

    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="terminal-retry-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="terminal-retry-parent",
                data={"role": "assistant", "agent": "build"},
            )

    real_update = swarm_module.update_part_data
    failed_once = False

    async def flaky_terminal_update(db, part_id, data):
        nonlocal failed_once
        if not failed_once and data.get("status") != "running":
            failed_once = True
            raise RuntimeError("transient terminal write")
        return await real_update(db, part_id, data)

    monkeypatch.setattr(
        swarm_module,
        "update_part_data",
        flaky_terminal_update,
    )
    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    ).run(
        [
            SwarmTaskSpec(title="Retry one", prompt="one"),
            SwarmTaskSpec(title="Retry two", prompt="two"),
        ],
        SwarmRunContext(
            parent_job=GenerationJob(
                "terminal-retry-stream",
                "terminal-retry-parent",
            ),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
        ),
    )

    assert failed_once is True
    assert outcome.status == "completed"
    async with swarm_session_factory() as db:
        messages = await get_messages(db, "terminal-retry-parent")
    persisted = next(
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    )
    assert persisted["status"] == "completed"


async def test_swarm_terminal_write_preserves_late_cancellation(
    swarm_session_factory,
    tmp_path,
    monkeypatch,
) -> None:
    import app.agent.swarm as swarm_module

    provider = _ConcurrentProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="terminal-cancel-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="terminal-cancel-parent",
                data={"role": "assistant", "agent": "build"},
            )

    real_update = swarm_module.update_part_data
    terminal_write_started = asyncio.Event()
    release_terminal_write = asyncio.Event()

    async def blocked_terminal_update(db, part_id, data):
        if data.get("status") != "running":
            terminal_write_started.set()
            await release_terminal_write.wait()
        return await real_update(db, part_id, data)

    monkeypatch.setattr(
        swarm_module,
        "update_part_data",
        blocked_terminal_update,
    )
    coordinator_run = asyncio.create_task(
        SwarmCoordinator(
            session_factory=swarm_session_factory,
            provider_registry=providers,
            agent_registry=AgentRegistry(),
            tool_registry=ToolRegistry(),
        ).run(
            [
                SwarmTaskSpec(title="Finish one", prompt="one"),
                SwarmTaskSpec(title="Finish two", prompt="two"),
            ],
            SwarmRunContext(
                parent_job=GenerationJob(
                    "terminal-cancel-stream",
                    "terminal-cancel-parent",
                ),
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
            ),
        )
    )
    await asyncio.wait_for(terminal_write_started.wait(), timeout=1)
    coordinator_run.cancel()
    await asyncio.sleep(0)
    coordinator_run.cancel()
    release_terminal_write.set()

    with pytest.raises(asyncio.CancelledError):
        await coordinator_run

    async with swarm_session_factory() as db:
        messages = await get_messages(db, "terminal-cancel-parent")
    persisted = next(
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    )
    assert persisted["status"] == "cancelled"


async def test_research_agent_rejects_unadvertised_mutation_tool_call(
    swarm_session_factory,
    tmp_path,
) -> None:
    target = tmp_path / "unadvertised-write.txt"
    provider = _UnadvertisedWriteProvider(str(target))
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="allowing-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="allowing-parent",
                data={"role": "assistant", "agent": "build"},
            )

    tools = ToolRegistry()
    tools.register(WriteTool())
    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=tools,
    ).run(
        [SwarmTaskSpec(title="Read-only worker", prompt="inspect")],
        SwarmRunContext(
            parent_job=GenerationJob("allowing-stream", "allowing-parent"),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
            # Simulates an Auto-mode parent. The child Agent's own Tool
            # allowlist must remain a hard boundary.
            permission_rules=(
                {"action": "allow", "permission": "*", "pattern": "*"},
            ),
        ),
    )

    assert outcome.status == "completed"
    assert not target.exists()


async def test_child_agent_resource_denial_is_a_hard_ceiling(
    swarm_session_factory,
    tmp_path,
) -> None:
    target = tmp_path / "agent-denied-write.txt"
    provider = _UnadvertisedWriteProvider(str(target))
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()

    agents = AgentRegistry()
    agents.register(AgentInfo(
        name="guarded-writer",
        description="Writer with a resource-level hard denial",
        mode="subagent",
        tools=["write"],
        permissions=Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(
                action="deny",
                permission="write",
                pattern=str(target),
            ),
        ]),
    ))
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="guarded-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="guarded-parent",
                data={"role": "assistant", "agent": "build"},
            )

    tools = ToolRegistry()
    tools.register(WriteTool())
    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=agents,
        tool_registry=tools,
    ).run(
        [
            SwarmTaskSpec(
                title="Guarded writer",
                prompt="attempt",
                agent="guarded-writer",
            )
        ],
        SwarmRunContext(
            parent_job=GenerationJob("guarded-stream", "guarded-parent"),
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
            permission_rules=(
                {"action": "allow", "permission": "*", "pattern": "*"},
            ),
        ),
    )

    assert outcome.status == "completed"
    assert not target.exists()


async def test_one_child_timeout_does_not_abort_parent_or_sibling(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _SelectiveTimeoutProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="timeout-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="timeout-parent",
                data={"role": "assistant", "agent": "build"},
            )

    parent_job = GenerationJob("timeout-stream", "timeout-parent")
    outcome = await SwarmCoordinator(
        session_factory=swarm_session_factory,
        provider_registry=providers,
        agent_registry=AgentRegistry(),
        tool_registry=ToolRegistry(),
    ).run(
        [
            SwarmTaskSpec(title="Slow worker", prompt="slow"),
            SwarmTaskSpec(title="Fast worker", prompt="fast"),
        ],
        SwarmRunContext(
            parent_job=parent_job,
            parent_message_id=parent_message.id,
            workspace=str(tmp_path),
            model_id="swarm-model",
            provider_id=provider.id,
            depth=0,
            timeout_seconds=0.5,
        ),
    )

    assert outcome.status == "partial"
    assert [member.status for member in outcome.members] == [
        "failed",
        "completed",
    ]
    assert not parent_job.abort_event.is_set()


async def test_cancelled_coordinator_persists_terminal_swarm_snapshot(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _SelectiveTimeoutProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="cancel-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="cancel-parent",
                data={"role": "assistant", "agent": "build"},
            )

    parent_job = GenerationJob("cancel-stream", "cancel-parent")
    task = asyncio.create_task(
        SwarmCoordinator(
            session_factory=swarm_session_factory,
            provider_registry=providers,
            agent_registry=AgentRegistry(),
            tool_registry=ToolRegistry(),
        ).run(
            [
                SwarmTaskSpec(title="Slow one", prompt="slow"),
                SwarmTaskSpec(title="Slow two", prompt="slow"),
            ],
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
                timeout_seconds=5,
            ),
        )
    )
    for _ in range(100):
        running_events = [
            event
            for event in parent_job.events
            if event.event == SWARM_STATE
            and any(
                member["status"] == "running"
                for member in event.data["members"]
            )
        ]
        if running_events:
            break
        await asyncio.sleep(0.01)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    async with swarm_session_factory() as db:
        messages = await get_messages(db, "cancel-parent")
    swarm_part = next(
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    )
    assert swarm_part["status"] == "cancelled"
    assert all(
        member["status"] == "cancelled"
        for member in swarm_part["members"]
    )


async def test_parent_abort_signal_promptly_cancels_blocked_swarm_children(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _BlockingProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="abort-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="abort-parent",
                data={"role": "assistant", "agent": "build"},
            )

    parent_job = GenerationJob("abort-stream", "abort-parent")
    coordinator_task = asyncio.create_task(
        SwarmCoordinator(
            session_factory=swarm_session_factory,
            provider_registry=providers,
            agent_registry=AgentRegistry(),
            tool_registry=ToolRegistry(),
        ).run(
            [
                SwarmTaskSpec(title="Blocked one", prompt="one"),
                SwarmTaskSpec(title="Blocked two", prompt="two"),
            ],
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
                timeout_seconds=20,
            ),
        )
    )
    for _ in range(100):
        if provider.active == 2:
            break
        await asyncio.sleep(0.01)
    assert provider.active == 2

    parent_job.abort()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(coordinator_task, timeout=1)
    assert provider.active == 0
    async with swarm_session_factory() as db:
        messages = await get_messages(db, "abort-parent")
    swarm_part = next(
        part.data
        for message in messages
        for part in message.parts
        if part.data.get("type") == "swarm"
    )
    assert swarm_part["status"] == "cancelled"
    assert all(
        member["status"] == "cancelled"
        for member in swarm_part["members"]
    )


async def test_deleting_running_child_aborts_registered_job_without_recreation(
    swarm_session_factory,
    tmp_path,
) -> None:
    provider = _SelectiveTimeoutProvider()
    providers = ProviderRegistry()
    providers.register(provider)
    await providers.refresh_models()
    async with swarm_session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="delete-child-parent",
                directory=str(tmp_path),
            )
            parent_message = await create_message(
                db,
                session_id="delete-child-parent",
                data={"role": "assistant", "agent": "build"},
            )

    stream_manager = StreamManager()
    parent_job = GenerationJob(
        "delete-child-stream",
        "delete-child-parent",
    )
    coordinator_task = asyncio.create_task(
        SwarmCoordinator(
            session_factory=swarm_session_factory,
            provider_registry=providers,
            agent_registry=AgentRegistry(),
            tool_registry=ToolRegistry(),
            stream_manager=stream_manager,
        ).run(
            [SwarmTaskSpec(title="Disposable worker", prompt="slow")],
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=parent_message.id,
                workspace=str(tmp_path),
                model_id="swarm-model",
                provider_id=provider.id,
                depth=0,
                timeout_seconds=5,
            ),
        )
    )

    child_session_id = ""
    for _ in range(100):
        state_events = [
            event
            for event in parent_job.events
            if event.event == SWARM_STATE
            and event.data["members"][0]["status"] == "running"
        ]
        if state_events:
            child_session_id = state_events[-1].data["members"][0][
                "session_id"
            ]
            if any(
                job["session_id"] == child_session_id
                for job in stream_manager.active_jobs()
            ):
                break
        await asyncio.sleep(0.01)

    assert child_session_id
    async with swarm_session_factory() as db:
        async with db.begin():
            await delete_session_cascade(
                db,
                child_session_id,
                stream_manager,
            )

    outcome = await asyncio.wait_for(coordinator_task, timeout=2)

    assert outcome.status == "cancelled"
    assert outcome.members[0].status == "cancelled"
    assert all(
        job["session_id"] != child_session_id
        for job in stream_manager.active_jobs()
    )
    async with swarm_session_factory() as db:
        assert await get_messages(db, child_session_id) == []
