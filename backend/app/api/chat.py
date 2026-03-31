"""Chat API endpoints — prompt, stream, abort, respond."""

from __future__ import annotations

import asyncio
import functools
import logging

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from sqlalchemy import delete as sa_delete

from app.dependencies import (
    AgentRegistryDep,
    IndexManagerDep,
    ProviderRegistryDep,
    SessionFactoryDep,
    StreamManagerDep,
    ToolRegistryDep,
)
from app.models.todo import Todo
from app.schemas.chat import AbortRequest, EditAndResendRequest, PromptRequest, PromptResponse, RespondRequest
from app.session.manager import delete_messages_after, update_message_file_parts, update_message_text
from app.session.processor import run_generation
from app.streaming.events import AGENT_ERROR, PERMISSION_RESOLVED, QUESTION_RESOLVED, SSEEvent
from app.streaming.manager import GenerationJob, StreamManager
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

router = APIRouter()

# Heartbeat interval (seconds) — prevents proxy/CDN timeout
_HEARTBEAT_INTERVAL = 15.0


def _on_task_done(task: asyncio.Task[None], *, job: GenerationJob) -> None:
    """Callback for generation tasks — logs and publishes unhandled exceptions.

    Without this, an unhandled exception in run_generation would be silently
    swallowed and the frontend would never receive a DONE or AGENT_ERROR event,
    leaving the UI stuck in the "generating" state forever.
    """
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("Unhandled exception in generation task %s: %s", task.get_name(), exc, exc_info=exc)
        try:
            job.publish(SSEEvent(AGENT_ERROR, {"error_message": "An internal error occurred. Please try again."}))
        except Exception:
            logger.exception("Failed to publish AGENT_ERROR for task %s", task.get_name())


async def _run_with_semaphore(sm: StreamManager, job: GenerationJob, coro) -> None:
    """Run generation under the concurrency semaphore."""
    try:
        await asyncio.wait_for(sm._semaphore.acquire(), timeout=30)
    except asyncio.TimeoutError:
        job.publish(SSEEvent(AGENT_ERROR, {"error_message": "Server is busy. Please try again shortly."}))
        job.complete()
        return
    try:
        await coro
    finally:
        sm._semaphore.release()


@router.post("/chat/prompt", response_model=PromptResponse)
async def start_prompt(
    body: PromptRequest,
    sm: StreamManagerDep,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
    tool_registry: ToolRegistryDep,
    index_manager: IndexManagerDep,
) -> PromptResponse:
    """Start a new generation. Returns stream_id for SSE subscription."""
    session_id = body.session_id or generate_ulid()
    stream_id = generate_ulid()

    job = sm.create_job(stream_id=stream_id, session_id=session_id)

    # Launch the full agent loop in a background task with concurrency limiting
    coro = run_generation(
        job,
        body,
        session_factory=session_factory,
        provider_registry=provider_registry,
        agent_registry=agent_registry,
        tool_registry=tool_registry,
        index_manager=index_manager,
    )
    task = asyncio.create_task(
        _run_with_semaphore(sm, job, coro),
        name=f"gen-{stream_id}",
    )
    task.add_done_callback(functools.partial(_on_task_done, job=job))
    job.task = task  # prevent GC from silently cancelling the task

    return PromptResponse(stream_id=stream_id, session_id=session_id)


@router.post("/chat/edit", response_model=PromptResponse)
async def edit_and_resend(
    body: EditAndResendRequest,
    sm: StreamManagerDep,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
    tool_registry: ToolRegistryDep,
    index_manager: IndexManagerDep,
) -> PromptResponse:
    """Edit a user message, delete all subsequent messages, and re-generate."""
    stream_id = generate_ulid()

    # Atomic DB operation: update message text + delete subsequent messages
    async with session_factory() as db:
        async with db.begin():
            await update_message_text(db, body.message_id, body.text)
            await update_message_file_parts(
                db, body.message_id, body.session_id, body.attachments or []
            )
            await delete_messages_after(db, body.session_id, body.message_id)
            # Clear stale todos so re-fetches return empty until new generation populates them
            await db.execute(sa_delete(Todo).where(Todo.session_id == body.session_id))

    job = sm.create_job(stream_id=stream_id, session_id=body.session_id)

    # Build a PromptRequest for run_generation (reuses existing flow)
    edit_request = PromptRequest(
        session_id=body.session_id,
        text=body.text,
        model=body.model,
        agent=body.agent,
        attachments=body.attachments,
        permission_presets=body.permission_presets,
        reasoning=body.reasoning,
        workspace=body.workspace,
    )

    coro = run_generation(
        job,
        edit_request,
        session_factory=session_factory,
        provider_registry=provider_registry,
        agent_registry=agent_registry,
        tool_registry=tool_registry,
        index_manager=index_manager,
        skip_user_message=True,
    )
    task = asyncio.create_task(
        _run_with_semaphore(sm, job, coro),
        name=f"gen-edit-{stream_id}",
    )
    task.add_done_callback(functools.partial(_on_task_done, job=job))
    job.task = task

    return PromptResponse(stream_id=stream_id, session_id=body.session_id)


@router.get("/chat/stream/{stream_id}")
async def stream_events(sm: StreamManagerDep, stream_id: str, last_event_id: int = 0):
    """SSE endpoint. Supports reconnect via ?last_event_id=N.

    Includes heartbeat every 15s to prevent proxy/CDN timeouts (matching OpenCode).
    Sets job.interactive=True to enable permission ask and question blocking.
    """
    job = sm.get_job(stream_id)

    if job is None:
        # Return 200 (not 404) so that EventSource reads the body.
        # EventSource ignores response bodies on non-2xx status codes,
        # causing the frontend to never receive the agent_error event.
        return StreamingResponse(
            _error_stream("Job not found"),
            media_type="text/event-stream",
        )

    # Mark job as interactive — enables permission ask and question tool blocking
    job.interactive = True

    queue = job.subscribe(last_event_id=last_event_id)

    async def event_generator():
        done_sent = False
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_INTERVAL)
                    if event is None:
                        break
                    yield event.encode()
                    if event.event in ("done", "agent-error"):
                        done_sent = True
                except asyncio.TimeoutError:
                    # Send heartbeat as a named SSE event so the frontend
                    # EventSource triggers listeners and resets its timer.
                    yield "event: heartbeat\ndata: {}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if done_sent:
                # Yield an SSE comment to force an extra write/flush cycle.
                # Prevents the TCP connection from closing before the DONE
                # bytes are fully transmitted to the client.
                yield ": flush\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/abort")
async def abort_generation(sm: StreamManagerDep, body: AbortRequest) -> dict:
    """Abort an active generation."""
    job = sm.get_job(body.stream_id)
    if job is None:
        return {"status": "not_found"}
    job.abort()
    return {"status": "aborted"}


@router.get("/chat/active")
async def list_active(sm: StreamManagerDep) -> list[dict[str, str]]:
    """List active generation jobs."""
    return sm.active_jobs()


@router.post("/chat/respond")
async def respond_to_prompt(request: Request, sm: StreamManagerDep, body: RespondRequest) -> dict:
    """User responds to question tool or permission request."""
    job = sm.get_job(body.stream_id)
    if job is None:
        return {"status": "not_found"}
    job.submit_response(body.call_id, body.response)

    # Broadcast a resolved event so other connected clients (e.g., the other
    # end of a PC/mobile session) can dismiss their prompt UI.
    source = (request.state.source if hasattr(request, "state") and hasattr(request.state, "source") else "local")
    if isinstance(body.response, bool):
        job.publish(SSEEvent(PERMISSION_RESOLVED, {"call_id": body.call_id, "allowed": body.response, "source": source}))
    else:
        job.publish(SSEEvent(QUESTION_RESOLVED, {"call_id": body.call_id, "source": source}))

    return {"status": "submitted"}


async def _error_stream(message: str):
    """Yield a single error event."""
    event = SSEEvent(AGENT_ERROR, {"error_message": message})
    event.id = 1
    yield event.encode()
