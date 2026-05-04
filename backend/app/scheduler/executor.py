"""Scheduled task executor — creates a headless agent session for a task.

Supports two execution modes:
  - Single-shot: standard automation (run prompt once)
  - Loop: iterative execution with fresh context per iteration
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.dependencies import get_index_manager
from app.models.scheduled_task import ScheduledTask
from app.models.task_run import TaskRun
from app.schemas.chat import PromptRequest
from app.session.processor import run_generation
from app.streaming.manager import GenerationJob
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

# Default stop marker for loop mode
DEFAULT_STOP_MARKER = "[LOOP_DONE]"

# Built-in loop presets — prompt templates for common iterative workflows
LOOP_PRESETS: dict[str, str] = {
    "email-batch": (
        "Check the next unprocessed email in the inbox. "
        "Draft a reply, archive, or create a follow-up todo as appropriate. "
        "If all emails are processed, output [LOOP_DONE]."
    ),
    "doc-review": (
        "Read the next section of the document. Check logic, grammar, "
        "and formatting. Suggest edits or fix directly. "
        "If all sections are reviewed, output [LOOP_DONE]."
    ),
    "data-cleanup": (
        "Check the next batch of records. Fix inconsistent formatting, "
        "remove duplicates, fill missing fields. "
        "If all data is cleaned, output [LOOP_DONE]."
    ),
    "todo-list": (
        "Check the todo list, pick the next pending task, complete it, "
        "and mark it done. "
        "If all tasks are completed, output [LOOP_DONE]."
    ),
}


async def execute_scheduled_task(
    task_id: str,
    *,
    session_factory: async_sessionmaker[AsyncSession],
    app_state: Any,
    triggered_by: str = "schedule",
) -> str | None:
    """Execute a scheduled task by creating a headless agent session.

    Returns the session_id on success, or None if the task was not found/disabled.
    If the task has loop_max_iterations set, runs in loop mode.
    """
    # 1. Load task
    async with session_factory() as db:
        async with db.begin():
            task = (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id == task_id)
                )
            ).scalar_one_or_none()
            if task is None:
                logger.warning("Scheduled task %s not found", task_id)
                return None
            if not task.enabled and triggered_by != "manual":
                logger.debug("Scheduled task %s is disabled, skipping", task_id)
                return None
            # Snapshot task fields while inside the session
            task_snapshot = {
                "name": task.name,
                "prompt": task.prompt,
                "agent": task.agent,
                "model": task.model,
                "workspace": task.workspace,
                "timeout": task.timeout_seconds or 1800,
                "loop_max_iterations": task.loop_max_iterations,
                "loop_preset": task.loop_preset,
                "loop_stop_marker": task.loop_stop_marker or DEFAULT_STOP_MARKER,
            }

    # 1b. If no model specified, pick the best available
    if not task_snapshot["model"]:
        task_snapshot["model"] = _resolve_default_model(app_state)

    # Route to loop or single-shot execution
    if task_snapshot["loop_max_iterations"]:
        return await _execute_loop(
            task_id, task_snapshot,
            session_factory=session_factory,
            app_state=app_state,
            triggered_by=triggered_by,
        )
    else:
        return await _execute_single(
            task_id, task_snapshot,
            session_factory=session_factory,
            app_state=app_state,
            triggered_by=triggered_by,
        )


async def _execute_single(
    task_id: str,
    task_snapshot: dict[str, Any],
    *,
    session_factory: async_sessionmaker[AsyncSession],
    app_state: Any,
    triggered_by: str,
) -> str | None:
    """Run a single-shot automation (original behavior)."""
    session_id = generate_ulid()
    run_id = generate_ulid()
    now = datetime.now(timezone.utc)

    # Create TaskRun record
    async with session_factory() as db:
        async with db.begin():
            db.add(TaskRun(
                id=run_id,
                task_id=task_id,
                session_id=session_id,
                status="running",
                started_at=now,
                triggered_by=triggered_by,
            ))
            task_obj = (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id == task_id)
                )
            ).scalar_one_or_none()
            if task_obj:
                task_obj.last_run_status = "running"
                task_obj.last_session_id = session_id

    # Run generation
    status, error_msg = await _run_session(
        session_id, task_snapshot, session_factory=session_factory, app_state=app_state,
    )

    # Update records
    finished_at = datetime.now(timezone.utc)
    async with session_factory() as db:
        async with db.begin():
            run_obj = (
                await db.execute(select(TaskRun).where(TaskRun.id == run_id))
            ).scalar_one_or_none()
            if run_obj:
                run_obj.status = status
                run_obj.error_message = error_msg
                run_obj.finished_at = finished_at

            task_obj = (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id == task_id)
                )
            ).scalar_one_or_none()
            if task_obj:
                task_obj.last_run_at = finished_at
                task_obj.last_run_status = status
                task_obj.run_count = (task_obj.run_count or 0) + 1

    # Set session title
    _set_session_title(
        session_factory, session_id,
        f"[Scheduled] {task_snapshot['name']} — {now.strftime('%m/%d %H:%M')}",
    )

    logger.info(
        "Scheduled task %s (%s) finished: %s [triggered_by=%s]",
        task_id, task_snapshot["name"], status, triggered_by,
    )
    return session_id


async def _execute_loop(
    task_id: str,
    task_snapshot: dict[str, Any],
    *,
    session_factory: async_sessionmaker[AsyncSession],
    app_state: Any,
    triggered_by: str,
) -> str | None:
    """Run a loop automation — N iterations with fresh context per iteration."""
    max_iterations = task_snapshot["loop_max_iterations"]
    stop_marker = task_snapshot["loop_stop_marker"]

    # Resolve prompt: use preset if set, otherwise use task prompt directly
    preset = task_snapshot.get("loop_preset")
    base_prompt = LOOP_PRESETS.get(preset, task_snapshot["prompt"]) if preset else task_snapshot["prompt"]

    progress_entries: list[str] = []
    first_session_id: str | None = None
    completed_iterations = 0

    for i in range(max_iterations):
        iteration_num = i + 1
        session_id = generate_ulid()
        run_id = generate_ulid()
        now = datetime.now(timezone.utc)

        if first_session_id is None:
            first_session_id = session_id

        # Build prompt with accumulated progress
        iter_prompt = base_prompt
        if progress_entries:
            progress_text = "\n".join(
                f"- Iteration {j+1}: {entry}"
                for j, entry in enumerate(progress_entries)
            )
            iter_prompt = (
                f"{base_prompt}\n\n"
                f"## Progress from previous iterations\n{progress_text}\n\n"
                "Continue from where the previous iteration left off. "
                "Do NOT repeat already completed work."
            )

        # Create TaskRun for this iteration
        async with session_factory() as db:
            async with db.begin():
                db.add(TaskRun(
                    id=run_id,
                    task_id=task_id,
                    session_id=session_id,
                    status="running",
                    started_at=now,
                    triggered_by=f"loop:{iteration_num}/{max_iterations}",
                ))
                task_obj = (
                    await db.execute(
                        select(ScheduledTask).where(ScheduledTask.id == task_id)
                    )
                ).scalar_one_or_none()
                if task_obj:
                    task_obj.last_run_status = f"running:{iteration_num}/{max_iterations}"
                    task_obj.last_session_id = session_id

        # Run iteration
        iter_snapshot = {**task_snapshot, "prompt": iter_prompt}
        status, error_msg = await _run_session(
            session_id, iter_snapshot, session_factory=session_factory, app_state=app_state,
        )

        # Extract output for progress tracking
        output = _extract_session_output(app_state, session_id)
        summary = output[:500] if len(output) > 500 else output
        progress_entries.append(summary if summary else f"[{status}]")

        # Update TaskRun
        finished_at = datetime.now(timezone.utc)
        async with session_factory() as db:
            async with db.begin():
                run_obj = (
                    await db.execute(select(TaskRun).where(TaskRun.id == run_id))
                ).scalar_one_or_none()
                if run_obj:
                    run_obj.status = status
                    run_obj.error_message = error_msg
                    run_obj.finished_at = finished_at

        # Set session title
        _set_session_title(
            session_factory, session_id,
            f"[Loop {iteration_num}/{max_iterations}] {task_snapshot['name']}",
        )

        completed_iterations += 1

        # Check stop conditions
        if status == "error":
            logger.warning("Loop iteration %d failed, stopping", iteration_num)
            break
        if stop_marker and stop_marker in output:
            logger.info("Loop stop marker found at iteration %d", iteration_num)
            break

    # Update final task stats
    final_status = "success" if completed_iterations > 0 else "error"
    async with session_factory() as db:
        async with db.begin():
            task_obj = (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id == task_id)
                )
            ).scalar_one_or_none()
            if task_obj:
                task_obj.last_run_at = datetime.now(timezone.utc)
                task_obj.last_run_status = final_status
                task_obj.run_count = (task_obj.run_count or 0) + completed_iterations

    logger.info(
        "Loop task %s (%s) finished: %d/%d iterations [triggered_by=%s]",
        task_id, task_snapshot["name"], completed_iterations, max_iterations, triggered_by,
    )
    return first_session_id


async def _run_session(
    session_id: str,
    task_snapshot: dict[str, Any],
    *,
    session_factory: async_sessionmaker[AsyncSession],
    app_state: Any,
) -> tuple[str, str | None]:
    """Run a single generation session. Returns (status, error_message)."""
    stream_id = generate_ulid()
    job = GenerationJob(stream_id=stream_id, session_id=session_id)

    request = PromptRequest(
        session_id=session_id,
        text=task_snapshot["prompt"],
        model=task_snapshot["model"],
        agent=task_snapshot["agent"],
        workspace=task_snapshot.get("workspace"),
    )

    try:
        await asyncio.wait_for(
            run_generation(
                job,
                request,
                session_factory=session_factory,
                provider_registry=app_state.provider_registry,
                agent_registry=app_state.agent_registry,
                tool_registry=app_state.tool_registry,
                index_manager=get_index_manager(),
            ),
            timeout=task_snapshot.get("timeout", 1800),
        )
        return "success", None
    except asyncio.TimeoutError:
        timeout = task_snapshot.get("timeout", 1800)
        logger.warning("Session %s timed out after %ds", session_id, timeout)
        return "timeout", f"Execution exceeded {timeout}s timeout"
    except Exception as e:
        logger.error("Session %s failed: %s", session_id, e)
        return "error", str(e)


def _extract_session_output(app_state: Any, session_id: str) -> str:
    """Extract text output from a completed session's job events."""
    stream_mgr = getattr(app_state, "stream_manager", None)
    if not stream_mgr:
        return ""

    # Find the job by session_id in completed jobs
    for job_info in stream_mgr._completed:
        job = stream_mgr._jobs.get(job_info) if isinstance(job_info, str) else None
        if job and job.session_id == session_id:
            parts = []
            for event in job.events:
                if event.event == "text-delta":
                    parts.append(event.data.get("text", ""))
            return "".join(parts)
    return ""


def _set_session_title(
    session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
    title: str,
) -> None:
    """Set session title (fire-and-forget, swallows errors)."""
    import asyncio

    async def _inner():
        try:
            from app.session.manager import update_session_title
            async with session_factory() as db:
                async with db.begin():
                    await update_session_title(db, session_id, title)
        except Exception as e:
            logger.debug("Could not set session title: %s", e)

    asyncio.ensure_future(_inner())


def _resolve_default_model(app_state: Any) -> str | None:
    """Pick the best default model for scheduled tasks.

    Priority: subscription models > paid OpenRouter models > free models.
    """
    registry = getattr(app_state, "provider_registry", None)
    if registry is None:
        return None

    all_models = registry.all_models()
    if not all_models:
        return None

    subscription = [m for m in all_models if m.provider_id == "openai-subscription"]
    if subscription:
        return subscription[0].id

    paid = [m for m in all_models if m.pricing.prompt > 0 or m.pricing.completion > 0]
    if paid:
        return paid[0].id

    return all_models[0].id
