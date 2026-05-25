"""Explicit multi-agent task batch orchestration."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.provider.registry import ProviderRegistry
from app.schemas.chat import PromptRequest, TaskBatchRequest, TaskBatchTask
from app.session.manager import create_message, create_part, create_session, get_session
from app.session.processor import run_generation
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    SSEEvent,
    TASK_BATCH_FINISH,
    TASK_BATCH_START,
    TASK_BATCH_UPDATE,
    TEXT_DELTA,
)
from app.streaming.manager import GenerationJob
from app.tool.registry import ToolRegistry
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

TaskStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


@dataclass
class BatchTaskState:
    task_id: str
    session_id: str
    title: str
    prompt: str
    agent: str
    model: str | None
    provider_id: str | None
    status: TaskStatus = "pending"
    error: str | None = None
    output: str = ""


def _task_state_from_spec(
    spec: TaskBatchTask,
    *,
    parent_session_id: str,
    index: int,
) -> BatchTaskState:
    task_id = generate_ulid()
    return BatchTaskState(
        task_id=task_id,
        session_id=generate_ulid(),
        title=spec.title,
        prompt=spec.prompt,
        agent=spec.agent,
        model=spec.model,
        provider_id=spec.provider_id,
    )


def _snapshot(batch_id: str, mode: str, states: list[BatchTaskState]) -> dict[str, Any]:
    return {
        "batch_id": batch_id,
        "mode": mode,
        "tasks": [
            {
                "task_id": state.task_id,
                "session_id": state.session_id,
                "title": state.title,
                "agent": state.agent,
                "model": state.model,
                "provider_id": state.provider_id,
                "status": state.status,
                "error": state.error,
            }
            for state in states
        ],
    }


def _format_user_text(body: TaskBatchRequest) -> str:
    lines = [f"Run a {body.mode} multi-agent task batch:"]
    for index, task in enumerate(body.tasks, start=1):
        model = f", model: {task.model}" if task.model else ""
        lines.append(f"{index}. {task.title} (agent: {task.agent}{model})")
        lines.append(task.prompt)
    return "\n\n".join(lines)


def _extract_child_output(child_job: GenerationJob) -> tuple[str, str | None]:
    output_parts: list[str] = []
    error_parts: list[str] = []
    tool_results: list[str] = []

    for event in child_job.events:
        if event.event == "text-delta":
            output_parts.append(str(event.data.get("text", "")))
        elif event.event == "tool-result":
            tool_name = str(event.data.get("tool", ""))
            tool_output = str(event.data.get("output", ""))
            if tool_name and tool_output:
                if len(tool_output) > 2000:
                    tool_output = tool_output[:2000] + "... [truncated]"
                tool_results.append(f"[{tool_name}] {tool_output}")
        elif event.event in {"agent-error", "error"}:
            error_parts.append(str(event.data.get("error_message") or event.data.get("message") or "error"))

    output = "".join(output_parts)
    if tool_results:
        output += "\n\n--- Key tool results ---\n"
        output += "\n\n".join(tool_results[-5:])

    error = "; ".join(part for part in error_parts if part) or None
    if not output.strip():
        output = "(subagent produced no text output)"
    return output, error


def _format_aggregate(states: list[BatchTaskState]) -> str:
    completed = [state for state in states if state.status == "completed"]
    failed = [state for state in states if state.status == "failed"]
    cancelled = [state for state in states if state.status == "cancelled"]

    lines = ["Multi-agent task batch finished."]
    if completed:
        lines.append("\nCompleted tasks:")
        for state in completed:
            lines.append(f"- {state.title}: {state.output.strip()}")
    if failed:
        lines.append("\nFailed tasks:")
        for state in failed:
            lines.append(f"- {state.title}: {state.error or 'Unknown error'}")
    if cancelled:
        lines.append("\nCancelled tasks:")
        for state in cancelled:
            lines.append(f"- {state.title}")
    return "\n".join(lines)


async def _ensure_parent_session_and_user_message(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
    body: TaskBatchRequest,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            session = await get_session(db, session_id)
            if session is None:
                await create_session(
                    db,
                    id=session_id,
                    directory=body.workspace or ".",
                )

            user_msg = await create_message(
                db,
                session_id=session_id,
                data={"role": "user", "agent": "orchestrator"},
            )
            await create_part(
                db,
                message_id=user_msg.id,
                session_id=session_id,
                data={"type": "text", "text": _format_user_text(body)},
            )


async def _create_child_sessions(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    parent_session_id: str,
    states: list[BatchTaskState],
    workspace: str | None,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            parent = await get_session(db, parent_session_id)
            directory = workspace or (parent.directory if parent else None) or "."
            for state in states:
                await create_session(
                    db,
                    id=state.session_id,
                    parent_id=parent_session_id,
                    directory=directory,
                    title=state.title,
                )


async def _persist_assistant_result(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
    text: str,
    states: list[BatchTaskState],
) -> None:
    async with session_factory() as db:
        async with db.begin():
            assistant_msg = await create_message(
                db,
                session_id=session_id,
                data={
                    "role": "assistant",
                    "agent": "orchestrator",
                    "model_id": None,
                    "provider_id": None,
                    "cost": 0.0,
                    "tokens": {},
                    "finish": "stop",
                },
            )
            for state in states:
                await create_part(
                    db,
                    message_id=assistant_msg.id,
                    session_id=session_id,
                    data={
                        "type": "subtask",
                        "session_id": state.session_id,
                        "title": state.title,
                        "description": f"{state.agent}{f' / {state.model}' if state.model else ''}",
                    },
                )
            await create_part(
                db,
                message_id=assistant_msg.id,
                session_id=session_id,
                data={"type": "text", "text": text},
            )
            await create_part(
                db,
                message_id=assistant_msg.id,
                session_id=session_id,
                data={"type": "step-finish", "reason": "stop", "tokens": {}, "cost": 0.0},
            )


async def run_task_batch(
    job: GenerationJob,
    body: TaskBatchRequest,
    *,
    session_factory: async_sessionmaker[AsyncSession],
    provider_registry: ProviderRegistry,
    agent_registry: AgentRegistry,
    tool_registry: ToolRegistry,
    index_manager: Any | None = None,
) -> None:
    """Run a user-authored batch of child-agent tasks."""
    batch_id = generate_ulid()
    states = [
        _task_state_from_spec(spec, parent_session_id=job.session_id, index=index)
        for index, spec in enumerate(body.tasks)
    ]

    try:
        await _ensure_parent_session_and_user_message(
            session_factory=session_factory,
            session_id=job.session_id,
            body=body,
        )
        await _create_child_sessions(
            session_factory=session_factory,
            parent_session_id=job.session_id,
            states=states,
            workspace=body.workspace,
        )

        job.publish(SSEEvent(TASK_BATCH_START, _snapshot(batch_id, body.mode, states)))

        async def run_one(state: BatchTaskState) -> None:
            if job.abort_event.is_set():
                state.status = "cancelled"
                job.publish(SSEEvent(TASK_BATCH_UPDATE, _snapshot(batch_id, body.mode, states)))
                return

            state.status = "running"
            job.publish(SSEEvent(TASK_BATCH_UPDATE, _snapshot(batch_id, body.mode, states)))

            child_job = GenerationJob(stream_id=generate_ulid(), session_id=state.session_id)
            child_job.abort_event = job.abort_event
            child_job._depth = getattr(job, "_depth", 0) + 1

            child_request = PromptRequest(
                session_id=state.session_id,
                text=state.prompt,
                model=state.model,
                provider_id=state.provider_id,
                agent=state.agent,
                workspace=body.workspace,
            )

            try:
                await run_generation(
                    child_job,
                    child_request,
                    session_factory=session_factory,
                    provider_registry=provider_registry,
                    agent_registry=agent_registry,
                    tool_registry=tool_registry,
                    index_manager=index_manager,
                )
                output, child_error = _extract_child_output(child_job)
                state.output = output
                if job.abort_event.is_set():
                    state.status = "cancelled"
                elif child_error:
                    state.status = "failed"
                    state.error = child_error
                else:
                    state.status = "completed"
            except Exception as exc:
                logger.exception("Task batch child task failed: %s", state.title)
                state.status = "failed"
                state.error = str(exc)
            finally:
                job.publish(SSEEvent(TASK_BATCH_UPDATE, _snapshot(batch_id, body.mode, states)))

        if body.mode == "sequential":
            for state in states:
                await run_one(state)
                if state.status == "failed":
                    for pending in states:
                        if pending.status == "pending":
                            pending.status = "cancelled"
                    job.publish(SSEEvent(TASK_BATCH_UPDATE, _snapshot(batch_id, body.mode, states)))
                    break
                if job.abort_event.is_set():
                    for pending in states:
                        if pending.status == "pending":
                            pending.status = "cancelled"
                    job.publish(SSEEvent(TASK_BATCH_UPDATE, _snapshot(batch_id, body.mode, states)))
                    break
        else:
            await asyncio.gather(*(run_one(state) for state in states))

        aggregate = _format_aggregate(states)
        await _persist_assistant_result(
            session_factory=session_factory,
            session_id=job.session_id,
            text=aggregate,
            states=states,
        )

        job.publish(SSEEvent(TEXT_DELTA, {"session_id": job.session_id, "text": aggregate}))
        job.publish(SSEEvent(TASK_BATCH_FINISH, _snapshot(batch_id, body.mode, states)))
        job.publish(
            SSEEvent(
                DONE,
                {
                    "session_id": job.session_id,
                    "finish_reason": "aborted" if job.abort_event.is_set() else "stop",
                },
            )
        )
    except Exception:
        logger.exception("Task batch failed for stream %s", job.stream_id)
        job.publish(SSEEvent(AGENT_ERROR, {"error_message": "Task batch failed. Please try again."}))
    finally:
        job.complete()
