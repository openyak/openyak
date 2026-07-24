"""Task tool — SubAgent invocation.

Spawns a child session with its own agent loop, enabling:
  - Parallel exploration (explore subagent)
  - Code search delegation
  - Multi-step subtask execution (general subagent)

Improvements over initial implementation:
  - Sets parent_id on child session for proper hierarchy
  - Recursion depth guard (max 3 levels) prevents infinite nesting
  - Timeout prevents child sessions from running forever
  - Abort signal propagated from parent to child
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.swarm import read_agent_result
from app.config import get_settings
from app.session.manager import (
    create_part,
    create_session,
    get_session,
    update_part_data,
)
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    PERMISSION_REQUEST,
    PERMISSION_RESOLVED,
    PLAN_REVIEW,
    QUESTION,
    QUESTION_RESOLVED,
    REASONING_DELTA,
    STEP_FINISH,
    STEP_START,
    SUBTASK_STATE,
    TEXT_DELTA,
    TOOL_ERROR,
    TOOL_RESULT,
    TOOL_START,
    SSEEvent,
)
from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

# Maximum nesting depth for subtasks to prevent infinite recursion
MAX_SUBTASK_DEPTH = 3

# Default timeout for subtask execution (seconds)
SUBTASK_TIMEOUT = 600.0

_INTERACTION_REQUEST_EVENTS = frozenset(
    {PERMISSION_REQUEST, QUESTION, PLAN_REVIEW}
)
_INTERACTION_RESUME_EVENTS = frozenset(
    {
        PERMISSION_RESOLVED,
        QUESTION_RESOLVED,
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


async def _resolve_child_session(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    parent_session_id: str,
    task_id: str | None,
    workspace: str | None,
    title: str,
) -> tuple[str, bool]:
    """Resume a child in the parent's current scope or create a new child."""
    async with session_factory() as db:
        async with db.begin():
            parent = await get_session(db, parent_session_id)
            if task_id:
                existing = await get_session(db, task_id)
                if (
                    existing is not None
                    and existing.parent_id == parent_session_id
                ):
                    existing.directory = (
                        workspace
                        or (parent.directory if parent else None)
                        or existing.directory
                        or "."
                    )
                    existing.project_id = (
                        parent.project_id
                        if parent is not None
                        else existing.project_id
                    )
                    existing.title = title or existing.title
                    await db.flush()
                    return existing.id, True

            child_session_id = generate_ulid()
            await create_session(
                db,
                id=child_session_id,
                project_id=parent.project_id if parent else None,
                parent_id=parent_session_id,
                directory=(
                    workspace
                    or (parent.directory if parent else None)
                    or "."
                ),
                title=title,
            )
            return child_session_id, False


async def _update_subtask_part_with_retry(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    part_id: str,
    data: dict[str, Any],
) -> None:
    """Persist a SubtaskPart terminal snapshot despite transient DB errors."""
    async def write_with_retries() -> None:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                async with session_factory() as db:
                    async with db.begin():
                        await update_part_data(db, part_id, data)
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


class TaskTool(ToolDefinition):

    @property
    def id(self) -> str:
        return "task"

    @property
    def description(self) -> str:
        return (
            "Launch a specialized subagent to handle a complex subtask. "
            "Available agent types: 'explore' (fast codebase search), "
            "'general' (full access minus todo). "
            "The subagent runs its own agent loop and returns the result. "
            "Pass task_id from a previous result to resume an existing subtask session."
        )

    @property
    def execution_timeout(self) -> float:
        return float(get_settings().subtask_timeout + 30)

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Short description of the subtask (3-5 words)",
                },
                "prompt": {
                    "type": "string",
                    "description": "Detailed instructions for the subagent",
                },
                "agent": {
                    "type": "string",
                    "description": "Subagent type: 'explore' or 'general'",
                    "default": "explore",
                    "enum": ["explore", "general"],
                },
                "task_id": {
                    "type": "string",
                    "description": "Optional. Resume a previous subtask by passing the task_id from a prior result.",
                },
            },
            "required": ["description", "prompt"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        description = args["description"]
        prompt = args["prompt"]
        agent_name = args.get("agent", "explore")
        task_id = args.get("task_id")

        # Import here to avoid circular imports
        from app.schemas.chat import PromptRequest
        from app.session.processor import run_generation
        from app.streaming.manager import GenerationJob, await_with_abort
        settings = get_settings()

        # --- Recursion depth guard ---
        parent_depth = ctx.depth or getattr(ctx, "_depth", 0)
        if parent_depth >= settings.subtask_max_depth:
            return ToolResult(
                error=(
                    f"Maximum subtask nesting depth "
                    f"({settings.subtask_max_depth}) exceeded. "
                    "Complete the current task directly instead of delegating further."
                ),
            )

        # Access app-level registries through the _app_state injected by processor
        app_state = ctx.app_state or getattr(ctx, "_app_state", None)
        if not app_state:
            return ToolResult(error="SubAgent not available: missing app state")

        session_factory = app_state["session_factory"]
        child_stream_id = generate_ulid()
        child_session_id, resuming = await _resolve_child_session(
            session_factory=session_factory,
            parent_session_id=ctx.session_id,
            task_id=task_id,
            workspace=ctx.workspace,
            title=description,
        )
        if resuming:
            logger.info("Resuming subtask session %s", child_session_id)
        elif task_id:
            logger.warning(
                "task_id %s not found or parent mismatch; created %s",
                task_id,
                child_session_id,
            )

        # Create a child job to capture the output
        child_job = GenerationJob(
            stream_id=child_stream_id,
            session_id=child_session_id,
        )
        # Propagate depth for nested recursion guard
        child_job._depth = parent_depth + 1
        parent_job = ctx.job or getattr(ctx, "_job", None)
        if parent_job is not None:
            child_job.link_parent(
                parent_job,
                event_context={
                    "task_id": child_session_id,
                    "child_session_id": child_session_id,
                },
            )
        else:
            child_job.link_abort_event(ctx.abort_event)

        # Build the child request
        child_request = PromptRequest(
            session_id=child_session_id,
            text=prompt,
            model=ctx.model_id or getattr(ctx, "_model_id", None),
            provider_id=ctx.provider_id,
            agent=agent_name,
            permission_rules=list(ctx.permission_rules) or None,
            reasoning=ctx.reasoning,
            workspace=ctx.workspace,
            execution_mode="standard",
        )

        started_at = datetime.now(timezone.utc).isoformat()
        subtask_data = {
            "type": "subtask",
            "task_id": child_session_id,
            "session_id": child_session_id,
            "parent_id": ctx.session_id,
            "title": description,
            "description": f"{agent_name} Agent",
            "agent": agent_name,
            "status": "running",
            "depth": parent_depth + 1,
            "revision": 1,
            "resumed": resuming,
            "error": None,
            "cost": 0.0,
            "tokens": {},
            "started_at": started_at,
            "finished_at": None,
        }
        async with session_factory() as db:
            async with db.begin():
                subtask_part = await create_part(
                    db,
                    message_id=ctx.message_id,
                    session_id=ctx.session_id,
                    data=subtask_data,
                )
        if ctx._publish_fn:
            ctx._publish_fn(SUBTASK_STATE, dict(subtask_data))

        subtask_revision = 1
        subtask_status = "running"
        subtask_state_lock = asyncio.Lock()

        async def persist_subtask_status(
            status: str,
            *,
            force: bool = False,
            **updates: Any,
        ) -> dict[str, Any]:
            """Commit one monotonic lifecycle snapshot before publishing it."""
            nonlocal subtask_revision, subtask_status
            async with subtask_state_lock:
                if status == subtask_status and not force:
                    return {
                        **subtask_data,
                        "status": subtask_status,
                        "revision": subtask_revision,
                    }
                next_revision = subtask_revision + 1
                snapshot = {
                    **subtask_data,
                    "status": status,
                    "revision": next_revision,
                    **updates,
                }
                await _update_subtask_part_with_retry(
                    session_factory=session_factory,
                    part_id=subtask_part.id,
                    data=snapshot,
                )
                subtask_revision = next_revision
                subtask_status = status
                if ctx._publish_fn:
                    ctx._publish_fn(SUBTASK_STATE, dict(snapshot))
                return snapshot

        lifecycle_events: asyncio.Queue[str | None] = asyncio.Queue()

        def observe_child_event(event: SSEEvent) -> None:
            if (
                event.event in _INTERACTION_REQUEST_EVENTS
                or event.event in _INTERACTION_RESUME_EVENTS
            ):
                lifecycle_events.put_nowait(event.event)

        remove_lifecycle_listener = child_job.add_event_listener(
            observe_child_event
        )

        async def monitor_interaction_state() -> None:
            while True:
                event_type = await lifecycle_events.get()
                if event_type is None:
                    return
                try:
                    if event_type in _INTERACTION_REQUEST_EVENTS:
                        await persist_subtask_status("waiting_input")
                    elif event_type in _INTERACTION_RESUME_EVENTS:
                        await persist_subtask_status("running")
                except Exception:
                    logger.exception(
                        "Failed to persist SubAgent interaction state for %s",
                        child_session_id,
                    )

        interaction_monitor = asyncio.create_task(
            monitor_interaction_state(),
            name=f"subtask-interaction-{child_session_id}",
        )

        task_error: str | None = None
        cancelled = False
        propagate_cancellation = False
        stream_manager = app_state.get("stream_manager")
        if stream_manager is not None:
            stream_manager.register_job(child_job)

        def run_child() -> Any:
            return run_generation(
                child_job,
                child_request,
                session_factory=session_factory,
                provider_registry=app_state["provider_registry"],
                agent_registry=app_state["agent_registry"],
                tool_registry=app_state["tool_registry"],
                index_manager=ctx.index_manager,
            )

        try:
            # Run with timeout + abort propagation
            if stream_manager is None:
                await await_with_abort(
                    run_child(),
                    abort_event=child_job.abort_event,
                    timeout=float(settings.subtask_timeout),
                )
            else:
                async with stream_manager.generation_slot(
                    timeout=None,
                    owner=child_job,
                    parent=parent_job,
                ):
                    await await_with_abort(
                        run_child(),
                        abort_event=child_job.abort_event,
                        timeout=float(settings.subtask_timeout),
                    )
        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            propagate_cancellation = bool(
                ctx.abort_event.is_set()
                or (
                    current_task is not None
                    and current_task.cancelling()
                )
            )
            child_job.abort()
            task_error = "SubAgent cancelled"
            cancelled = True
        except asyncio.TimeoutError:
            child_job.abort()
            logger.warning(
                "Subtask timed out after %.0fs: %s",
                settings.subtask_timeout,
                description,
            )
            task_error = (
                f"SubAgent timed out after {settings.subtask_timeout:g}s"
            )
        except Exception as e:
            logger.exception("SubAgent error")
            task_error = f"SubAgent failed: {e}"
        finally:
            remove_lifecycle_listener()
            lifecycle_events.put_nowait(None)
            while not interaction_monitor.done():
                try:
                    await asyncio.shield(interaction_monitor)
                except asyncio.CancelledError:
                    current_task = asyncio.current_task()
                    propagate_cancellation = bool(
                        ctx.abort_event.is_set()
                        or (
                            current_task is not None
                            and current_task.cancelling()
                        )
                    )
                    child_job.abort()
                    task_error = "SubAgent cancelled"
                    cancelled = True
                    continue
                except Exception:
                    break
            try:
                await interaction_monitor
            except Exception:
                logger.exception(
                    "SubAgent interaction monitor failed for %s",
                    child_session_id,
                )
            if stream_manager is not None:
                if not child_job.completed:
                    child_job.complete()
                stream_manager.remove_job(child_job.stream_id)

        finalization_cancel_requested = asyncio.Event()

        async def finalize_subtask() -> tuple[
            str,
            float,
            dict[str, Any],
            str | None,
            str,
            dict[str, Any],
        ]:
            final_task_error = task_error
            try:
                output, cost, tokens = await read_agent_result(
                    session_factory,
                    child_session_id,
                )
            except Exception as exc:
                logger.exception("Failed to read SubAgent result")
                output, cost, tokens = "", 0.0, {}
                if final_task_error is None:
                    final_task_error = f"Failed to read SubAgent result: {exc}"

            child_errors = [
                str(
                    event.data.get("error_message")
                    or event.data.get("message")
                    or "SubAgent failed"
                )
                for event in child_job.events
                if event.event in {AGENT_ERROR, "error"}
            ]
            if child_errors and final_task_error is None:
                final_task_error = "; ".join(child_errors)
            aborted = (
                cancelled
                or finalization_cancel_requested.is_set()
                or child_job.abort_event.is_set()
                or ctx.abort_event.is_set()
            )
            if aborted and final_task_error is None:
                final_task_error = "SubAgent cancelled"
            if aborted:
                final_status = "cancelled"
            elif final_task_error:
                final_status = "failed"
            else:
                final_status = "completed"

            terminal_data = await persist_subtask_status(
                final_status,
                force=True,
                error=final_task_error,
                cost=cost,
                tokens=tokens,
                finished_at=datetime.now(timezone.utc).isoformat(),
            )
            return (
                output,
                cost,
                tokens,
                final_task_error,
                final_status,
                terminal_data,
            )

        finalization = asyncio.create_task(finalize_subtask())
        cancelled_during_finalization = False
        while not finalization.done():
            try:
                await asyncio.shield(finalization)
            except asyncio.CancelledError:
                cancelled_during_finalization = True
                finalization_cancel_requested.set()
                child_job.abort()
                continue
            except Exception:
                break

        finalization_error: Exception | None = None
        finalization_result: tuple[
            str,
            float,
            dict[str, Any],
            str | None,
            str,
            dict[str, Any],
        ] | None = None
        try:
            finalization_result = await finalization
        except Exception as exc:
            finalization_error = exc

        if cancelled_during_finalization:
            if (
                finalization_result is not None
                and finalization_result[4] == "cancelled"
            ):
                raise asyncio.CancelledError from finalization_error
            reconciliation = asyncio.create_task(
                persist_subtask_status(
                    "cancelled",
                    force=True,
                    error="SubAgent cancelled",
                    finished_at=datetime.now(timezone.utc).isoformat(),
                )
            )
            while not reconciliation.done():
                try:
                    await asyncio.shield(reconciliation)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            reconciliation_error: Exception | None = None
            try:
                await reconciliation
            except Exception as exc:
                reconciliation_error = exc
            raise asyncio.CancelledError from (
                reconciliation_error or finalization_error
            )

        if finalization_error is not None:
            try:
                await persist_subtask_status(
                    "failed",
                    force=True,
                    error=(
                        "SubAgent finalization failed: "
                        f"{finalization_error}"
                    ),
                    finished_at=datetime.now(timezone.utc).isoformat(),
                )
            except Exception:
                logger.exception(
                    "Failed to reconcile SubtaskPart %s after finalization error",
                    subtask_part.id,
                )
            if cancelled and propagate_cancellation:
                raise asyncio.CancelledError from finalization_error
            raise finalization_error

        assert finalization_result is not None
        output, cost, tokens, task_error, status, _final_data = (
            finalization_result
        )

        if cancelled and propagate_cancellation:
            raise asyncio.CancelledError

        if task_error:
            return ToolResult(
                error=task_error,
                title=f"SubAgent ({agent_name}): {description}",
                metadata={
                    "task_id": child_session_id,
                    "session_id": child_session_id,
                    "status": status,
                },
            )

        return ToolResult(
            output=output,
            title=f"SubAgent ({agent_name}): {description}",
            metadata={
                "task_id": child_session_id,
                "session_id": child_session_id,
                "parent_id": ctx.session_id,
                "agent": agent_name,
                "depth": parent_depth + 1,
                "resumed": resuming,
                "events": len(child_job.events),
                "cost": cost,
                "tokens": tokens,
                "status": status,
            },
        )
