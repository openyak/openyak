"""Fork/join orchestration for a coordinated group of child Agents.

The coordinator is the single seam for child Session creation, bounded
concurrency, parent-context inheritance, lifecycle persistence, and result
collection.  The ``swarm`` Tool is a thin adapter over this module.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.agent.permission import GLOBAL_DEFAULTS, evaluate, merge_rulesets
from app.provider.registry import ProviderRegistry
from app.schemas.agent import Ruleset
from app.schemas.chat import PromptRequest
from app.session.manager import (
    create_part,
    create_session,
    get_messages,
    get_session,
    update_part_data,
)
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    PERMISSION_REQUEST,
    PLAN_REVIEW,
    QUESTION,
    REASONING_DELTA,
    STEP_FINISH,
    STEP_START,
    SWARM_STATE,
    TEXT_DELTA,
    TOOL_ERROR,
    TOOL_RESULT,
    TOOL_START,
    SSEEvent,
)
from app.streaming.manager import (
    GenerationJob,
    StreamManager,
    await_with_abort,
)
from app.tool.registry import ToolRegistry
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

AgentRunStatus = Literal[
    "pending",
    "running",
    "waiting_input",
    "completed",
    "failed",
    "cancelled",
]
SwarmStatus = Literal["running", "completed", "partial", "failed", "cancelled"]
_INTERACTION_REQUEST_EVENTS = frozenset(
    {PERMISSION_REQUEST, QUESTION, PLAN_REVIEW}
)
_INTERACTION_RESUME_EVENTS = frozenset(
    {
        TEXT_DELTA,
        REASONING_DELTA,
        TOOL_START,
        TOOL_RESULT,
        TOOL_ERROR,
        STEP_START,
        STEP_FINISH,
        DONE,
        AGENT_ERROR,
    }
)

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def read_agent_result(
    session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
) -> tuple[str, float, dict[str, int]]:
    """Read a complete child result from persisted Parts."""
    async with session_factory() as db:
        messages = await get_messages(db, session_id)

    text_parts: list[str] = []
    fallback_tool_outputs: list[str] = []
    cost = 0.0
    tokens: dict[str, int] = {}
    for message in messages:
        data = message.data or {}
        if data.get("role") != "assistant":
            continue
        cost += float(data.get("cost") or 0.0)
        message_tokens = data.get("tokens_accumulated") or data.get("tokens") or {}
        if isinstance(message_tokens, dict):
            for key, value in message_tokens.items():
                if isinstance(value, (int, float)):
                    tokens[key] = tokens.get(key, 0) + int(value)
        for part in message.parts:
            part_data = part.data or {}
            if part_data.get("type") == "text" and part_data.get("text"):
                text_parts.append(str(part_data["text"]))
            elif part_data.get("type") == "tool":
                state = part_data.get("state") or {}
                output = state.get("output")
                if output:
                    fallback_tool_outputs.append(
                        f"[{part_data.get('tool', 'tool')}] {output}"
                    )

    output = "\n".join(text_parts).strip()
    if not output and fallback_tool_outputs:
        output = "\n\n".join(fallback_tool_outputs[-5:])
    return output or "(child Agent produced no visible result)", cost, tokens


@dataclass(frozen=True)
class SwarmTaskSpec:
    """One child Agent assignment."""

    title: str
    prompt: str
    agent: str = "research"


@dataclass
class AgentRunState:
    """Durable, reader-facing state for one child Agent."""

    agent_run_id: str
    session_id: str
    ordinal: int
    title: str
    agent: str
    provider_id: str | None
    model_id: str | None
    depth: int
    status: AgentRunStatus = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    cost: float = 0.0
    tokens: dict[str, int] = field(default_factory=dict)
    output: str = ""

    def snapshot(self) -> dict[str, Any]:
        return {
            "agent_run_id": self.agent_run_id,
            "session_id": self.session_id,
            "ordinal": self.ordinal,
            "title": self.title,
            "agent": self.agent,
            "provider_id": self.provider_id,
            "model_id": self.model_id,
            "depth": self.depth,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "cost": self.cost,
            "tokens": self.tokens,
        }


@dataclass(frozen=True)
class SwarmRunContext:
    """Parent scope inherited by every child Agent."""

    parent_job: GenerationJob
    parent_message_id: str
    workspace: str | None
    model_id: str | None
    provider_id: str | None
    depth: int
    project_id: str | None = None
    permission_rules: tuple[dict[str, Any], ...] = ()
    reasoning: bool | None = None
    max_concurrency: int = 4
    timeout_seconds: float = 600.0


@dataclass(frozen=True)
class SwarmOutcome:
    """Completed fork/join result returned to the coordinating Agent."""

    swarm_id: str
    status: SwarmStatus
    members: tuple[AgentRunState, ...]
    revision: int

    @property
    def output(self) -> str:
        lines = [
            f"Swarm {self.status}: "
            f"{sum(member.status == 'completed' for member in self.members)}/"
            f"{len(self.members)} child Agents completed."
        ]
        for member in self.members:
            lines.append(
                f"\n## {member.title}\n"
                f"Agent: {member.agent} | Status: {member.status} | "
                f"Session: {member.session_id}"
            )
            if member.error:
                lines.append(f"Error: {member.error}")
            if member.output.strip():
                lines.append(member.output.strip())
            elif not member.error:
                lines.append("(no result)")
        return "\n".join(lines)

    def metadata(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "swarm_id": self.swarm_id,
            "status": self.status,
            "revision": self.revision,
            "members": [member.snapshot() for member in self.members],
            "completed": sum(member.status == "completed" for member in self.members),
            "failed": sum(member.status == "failed" for member in self.members),
            "cancelled": sum(member.status == "cancelled" for member in self.members),
            "total_cost": sum(member.cost for member in self.members),
        }


class SwarmCoordinator:
    """Run a bounded fork/join group behind one small Interface."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        provider_registry: ProviderRegistry,
        agent_registry: AgentRegistry,
        tool_registry: ToolRegistry,
        index_manager: Any | None = None,
        stream_manager: StreamManager | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._provider_registry = provider_registry
        self._agent_registry = agent_registry
        self._tool_registry = tool_registry
        self._index_manager = index_manager
        self._stream_manager = stream_manager

    async def run(
        self,
        specs: list[SwarmTaskSpec],
        context: SwarmRunContext,
    ) -> SwarmOutcome:
        """Run child Agents and join their results in input order."""
        if not specs:
            raise ValueError("A Swarm requires at least one child Agent")

        swarm_id = generate_ulid()
        parent_session_id = context.parent_job.session_id
        depth = context.depth + 1
        revision = 1
        started_at = _utc_now()

        members = [
            AgentRunState(
                agent_run_id=generate_ulid(),
                session_id=generate_ulid(),
                ordinal=index,
                title=spec.title,
                agent=spec.agent,
                provider_id=context.provider_id,
                model_id=context.model_id,
                depth=depth,
            )
            for index, spec in enumerate(specs)
        ]

        async with self._session_factory() as db:
            async with db.begin():
                parent = await get_session(db, parent_session_id)
                project_id = context.project_id or (parent.project_id if parent else None)
                workspace = (
                    context.workspace
                    or (parent.directory if parent and parent.directory else None)
                    or "."
                )
                for member in members:
                    await create_session(
                        db,
                        id=member.session_id,
                        project_id=project_id,
                        parent_id=parent_session_id,
                        directory=workspace,
                        title=member.title,
                    )
                swarm_part = await create_part(
                    db,
                    message_id=context.parent_message_id,
                    session_id=parent_session_id,
                    data=self._snapshot(
                        swarm_id=swarm_id,
                        parent_session_id=parent_session_id,
                        revision=revision,
                        status="running",
                        started_at=started_at,
                        finished_at=None,
                        members=members,
                    ),
                )

        context.parent_job.publish(
            SSEEvent(SWARM_STATE, dict(swarm_part.data))
        )

        state_lock = asyncio.Lock()
        mutation_lock = asyncio.Lock()
        coordinator_abort = asyncio.Event()
        child_jobs: dict[str, GenerationJob] = {}
        for member in members:
            child_job = GenerationJob(
                stream_id=generate_ulid(),
                session_id=member.session_id,
            )
            child_job._depth = member.depth
            child_job.link_parent(
                context.parent_job,
                event_context={
                    "swarm_id": swarm_id,
                    "agent_run_id": member.agent_run_id,
                    "child_session_id": member.session_id,
                },
            )
            child_job.link_abort_event(coordinator_abort)
            child_jobs[member.agent_run_id] = child_job
            if self._stream_manager is not None:
                self._stream_manager.register_job(child_job)

        concurrency = asyncio.Semaphore(
            max(1, min(context.max_concurrency, len(members)))
        )

        async def persist_and_publish(status: SwarmStatus = "running") -> None:
            nonlocal revision
            async with state_lock:
                revision += 1
                snapshot = self._snapshot(
                    swarm_id=swarm_id,
                    parent_session_id=parent_session_id,
                    revision=revision,
                    status=status,
                    started_at=started_at,
                    finished_at=_utc_now() if status != "running" else None,
                    members=members,
                )
                async with self._session_factory() as db:
                    async with db.begin():
                        await update_part_data(db, swarm_part.id, snapshot)
                # Commit before publish: a DESYNC/refetch always observes this revision.
                context.parent_job.publish(SSEEvent(SWARM_STATE, snapshot))

        async def run_member(spec: SwarmTaskSpec, member: AgentRunState) -> None:
            child_job = child_jobs[member.agent_run_id]
            lifecycle_events: asyncio.Queue[str | None] = asyncio.Queue()

            def observe_child_event(event: SSEEvent) -> None:
                if (
                    event.event in _INTERACTION_REQUEST_EVENTS
                    and member.status == "running"
                ):
                    lifecycle_events.put_nowait(event.event)
                elif (
                    event.event in _INTERACTION_RESUME_EVENTS
                    and member.status == "waiting_input"
                ):
                    lifecycle_events.put_nowait(event.event)

            remove_listener = child_job.add_event_listener(observe_child_event)

            async def monitor_interaction_state() -> None:
                while True:
                    event_type = await lifecycle_events.get()
                    if event_type is None:
                        return
                    if (
                        event_type in _INTERACTION_REQUEST_EVENTS
                        and member.status == "running"
                    ):
                        member.status = "waiting_input"
                        await persist_and_publish()
                    elif (
                        event_type in _INTERACTION_RESUME_EVENTS
                        and member.status == "waiting_input"
                    ):
                        member.status = "running"
                        await persist_and_publish()

            interaction_monitor = asyncio.create_task(
                monitor_interaction_state(),
                name=f"swarm-interaction-{swarm_id}-{member.ordinal}",
            )
            try:
                try:
                    async with concurrency:
                        if child_job.abort_event.is_set():
                            member.status = "cancelled"
                            member.finished_at = _utc_now()
                            await persist_and_publish()
                            return

                        member.status = "running"
                        member.started_at = _utc_now()
                        await persist_and_publish()

                        can_mutate = self._agent_can_mutate(
                            spec.agent,
                            context.permission_rules,
                        )
                        if can_mutate and self._stream_manager is not None:
                            run_guard = (
                                self._stream_manager.workspace_mutation_slot(
                                    workspace
                                )
                            )
                        elif can_mutate:
                            run_guard = mutation_lock
                        else:
                            run_guard = _NullAsyncLock()
                        async with run_guard:
                            await self._run_member(
                                spec,
                                member,
                                context,
                                child_job=child_job,
                            )

                        await persist_and_publish()
                except asyncio.CancelledError:
                    child_job.abort()
                    member.status = "cancelled"
                    member.finished_at = _utc_now()
                    # Coordinator settlement owns the terminal snapshot.  Let
                    # each child finish persisting its visible partial output
                    # before that single write instead of racing several
                    # SQLite transactions during a parent cancellation.
                    if (
                        not coordinator_abort.is_set()
                        and not context.parent_job.abort_event.is_set()
                    ):
                        try:
                            await asyncio.shield(persist_and_publish())
                        except Exception:
                            logger.warning(
                                "Failed to persist cancelled child Agent %s",
                                member.agent_run_id,
                                exc_info=True,
                            )
                except Exception as exc:
                    logger.exception(
                        "Swarm member lifecycle failed: %s",
                        member.title,
                    )
                    member.status = "failed"
                    member.error = str(exc)
                    member.finished_at = _utc_now()
                    try:
                        await persist_and_publish()
                    except Exception:
                        logger.warning(
                            "Failed to persist failed child Agent %s",
                            member.agent_run_id,
                            exc_info=True,
                        )
            finally:
                remove_listener()
                lifecycle_events.put_nowait(None)
                await interaction_monitor

        member_tasks = [
            asyncio.create_task(
                run_member(spec, member),
                name=f"swarm-{swarm_id}-{member.ordinal}",
            )
            for spec, member in zip(specs, members)
        ]
        for member, member_task in zip(members, member_tasks):
            child_jobs[member.agent_run_id].task = member_task
        join_future = asyncio.gather(*member_tasks)
        parent_abort_waiter = asyncio.create_task(
            context.parent_job.abort_event.wait()
        )

        async def settle_members() -> None:
            coordinator_abort.set()
            for child_job in child_jobs.values():
                child_job.abort()
            try:
                await asyncio.wait_for(
                    asyncio.shield(join_future),
                    timeout=min(0.5, context.timeout_seconds),
                )
            except BaseException:
                for task in member_tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(
                    *member_tasks,
                    return_exceptions=True,
                )
            # Retrieve the original gather terminal state. Awaiting a second
            # gather alone leaves this Future's CancelledError unobserved.
            await asyncio.gather(join_future, return_exceptions=True)

        async def finish_settlement() -> None:
            settlement = asyncio.create_task(settle_members())
            while not settlement.done():
                try:
                    await asyncio.shield(settlement)
                except asyncio.CancelledError:
                    # Cleanup must survive repeated caller cancellation.
                    continue
            await settlement

        async def persist_terminal(status: SwarmStatus) -> None:
            async def write_with_retries() -> None:
                last_error: Exception | None = None
                for attempt in range(3):
                    try:
                        await persist_and_publish(status)
                        return
                    except Exception as exc:
                        last_error = exc
                        if attempt < 2:
                            await asyncio.sleep(0.05 * (attempt + 1))
                assert last_error is not None
                raise last_error

            terminal_write = asyncio.create_task(write_with_retries())
            was_cancelled = False
            while not terminal_write.done():
                try:
                    await asyncio.shield(terminal_write)
                except asyncio.CancelledError:
                    # The retry state machine owns its DB transaction and
                    # delay. Repeated caller cancellation cannot interrupt it.
                    was_cancelled = True
                    continue
                except Exception:
                    break

            terminal_error: Exception | None = None
            try:
                await terminal_write
            except Exception as exc:
                terminal_error = exc
            if was_cancelled:
                raise asyncio.CancelledError from terminal_error
            if terminal_error is not None:
                raise terminal_error

        try:
            try:
                done, _ = await asyncio.wait(
                    {join_future, parent_abort_waiter},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if parent_abort_waiter in done:
                    raise asyncio.CancelledError("Parent generation aborted")
                await join_future

                final_status = self._aggregate_status(
                    members,
                    context.parent_job,
                )
                await persist_terminal(final_status)
                return SwarmOutcome(
                    swarm_id=swarm_id,
                    status=final_status,
                    members=tuple(members),
                    revision=revision,
                )
            except asyncio.CancelledError:
                await finish_settlement()
                cancelled_at = _utc_now()
                for member in members:
                    if member.status not in {
                        "completed",
                        "failed",
                        "cancelled",
                    }:
                        member.status = "cancelled"
                        member.finished_at = cancelled_at
                try:
                    await persist_terminal("cancelled")
                except Exception:
                    logger.exception(
                        "Failed to persist cancelled Swarm %s",
                        swarm_id,
                    )
                raise
            except Exception:
                await finish_settlement()
                failed_at = _utc_now()
                for member in members:
                    if member.status not in {
                        "completed",
                        "failed",
                        "cancelled",
                    }:
                        member.status = "failed"
                        member.error = "Swarm coordinator failed"
                        member.finished_at = failed_at
                try:
                    await persist_terminal("failed")
                except Exception:
                    logger.exception(
                        "Failed to persist failed Swarm %s",
                        swarm_id,
                    )
                raise
        finally:
            for child_job in child_jobs.values():
                if not child_job.completed:
                    child_job.complete()
                if self._stream_manager is not None:
                    self._stream_manager.remove_job(
                        child_job.stream_id
                    )
            if not parent_abort_waiter.done():
                parent_abort_waiter.cancel()
            await asyncio.gather(
                parent_abort_waiter,
                return_exceptions=True,
            )

    async def _run_member(
        self,
        spec: SwarmTaskSpec,
        member: AgentRunState,
        context: SwarmRunContext,
        *,
        child_job: GenerationJob,
    ) -> None:
        from app.session.processor import run_generation

        request = PromptRequest(
            session_id=member.session_id,
            text=spec.prompt,
            model=context.model_id,
            provider_id=context.provider_id,
            agent=spec.agent,
            permission_rules=list(context.permission_rules) or None,
            reasoning=context.reasoning,
            workspace=context.workspace,
            execution_mode="standard",
        )

        try:
            if child_job.abort_event.is_set():
                member.status = "cancelled"
                return
            if self._stream_manager is None:
                await await_with_abort(
                    run_generation(
                        child_job,
                        request,
                        session_factory=self._session_factory,
                        provider_registry=self._provider_registry,
                        agent_registry=self._agent_registry,
                        tool_registry=self._tool_registry,
                        index_manager=self._index_manager,
                    ),
                    abort_event=child_job.abort_event,
                    timeout=context.timeout_seconds,
                )
            else:
                async with self._stream_manager.generation_slot(
                    timeout=None,
                    owner=child_job,
                    parent=context.parent_job,
                ):
                    await await_with_abort(
                        run_generation(
                            child_job,
                            request,
                            session_factory=self._session_factory,
                            provider_registry=self._provider_registry,
                            agent_registry=self._agent_registry,
                            tool_registry=self._tool_registry,
                            index_manager=self._index_manager,
                        ),
                        abort_event=child_job.abort_event,
                        timeout=context.timeout_seconds,
                    )

            output, cost, tokens = await read_agent_result(
                self._session_factory,
                member.session_id,
            )
            member.output = output
            member.cost = cost
            member.tokens = tokens
            error = self._child_error(child_job)
            if child_job.abort_event.is_set():
                member.status = "cancelled"
            elif error:
                member.status = "failed"
                member.error = error
            else:
                member.status = "completed"
        except asyncio.TimeoutError:
            child_job.abort()
            member.status = "failed"
            member.error = f"Child Agent timed out after {context.timeout_seconds:g}s"
        except asyncio.CancelledError:
            child_job.abort()
            member.status = "cancelled"
            return
        except Exception as exc:
            logger.exception("Swarm child Agent failed: %s", member.title)
            member.status = "failed"
            member.error = str(exc)
        finally:
            member.finished_at = _utc_now()

    def _agent_can_mutate(
        self,
        agent_name: str,
        permission_rules: tuple[dict[str, Any], ...],
    ) -> bool:
        agent = self._agent_registry.get(agent_name)
        if agent is None:
            return True
        ceiling = Ruleset.model_validate({"rules": list(permission_rules)})
        effective = merge_rulesets(GLOBAL_DEFAULTS, agent.permissions, ceiling)
        tools = self._tool_registry.resolve_for_agent(
            agent,
            extra_ruleset=ceiling,
        )
        # Unknown/custom Tools are exclusive by default. Only a Tool that
        # explicitly declares itself concurrency-safe (the established
        # read-only contract) may participate in parallel Workspace access.
        return any(
            not tool.is_concurrency_safe
            and evaluate(tool.id, "*", effective) != "deny"
            for tool in tools
        )

    @staticmethod
    def _child_error(job: GenerationJob) -> str | None:
        errors = [
            str(
                event.data.get("error_message")
                or event.data.get("message")
                or "Child Agent failed"
            )
            for event in job.events
            if event.event in {AGENT_ERROR, "error"}
        ]
        return "; ".join(errors) or None

    @staticmethod
    def _aggregate_status(
        members: list[AgentRunState],
        parent_job: GenerationJob,
    ) -> SwarmStatus:
        if parent_job.abort_event.is_set():
            return "cancelled"
        completed = sum(member.status == "completed" for member in members)
        failed = sum(member.status == "failed" for member in members)
        cancelled = sum(member.status == "cancelled" for member in members)
        if completed == len(members):
            return "completed"
        if completed:
            return "partial"
        if failed:
            return "failed"
        if cancelled:
            return "cancelled"
        return "failed"

    @staticmethod
    def _snapshot(
        *,
        swarm_id: str,
        parent_session_id: str,
        revision: int,
        status: SwarmStatus,
        started_at: str,
        finished_at: str | None,
        members: list[AgentRunState],
    ) -> dict[str, Any]:
        return {
            "type": "swarm",
            "schema_version": 1,
            "swarm_id": swarm_id,
            "parent_session_id": parent_session_id,
            "revision": revision,
            "status": status,
            "strategy": "parallel",
            "failure_policy": "continue",
            "started_at": started_at,
            "finished_at": finished_at,
            "members": [member.snapshot() for member in members],
        }


class _NullAsyncLock:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: object) -> None:
        return None
