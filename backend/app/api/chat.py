"""Chat API endpoints — prompt, stream, abort, respond."""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Any

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from app.dependencies import (
    AgentRegistryDep,
    IndexManagerDep,
    ProviderRegistryDep,
    SessionFactoryDep,
    StreamManagerDep,
    ToolRegistryDep,
)
from app.models.todo import Todo
from app.models.message import Message
from app.schemas.chat import AbortRequest, CompactRequest, EditAndResendRequest, PromptRequest, PromptResponse, RespondRequest
from app.session.compaction import run_compaction
from app.session.manager import get_session
from app.session.manager import delete_messages_after, update_message_file_parts, update_message_text
from app.session.processor import run_generation
from app.streaming.events import AGENT_ERROR, COMPACTION_ERROR, DONE, PERMISSION_RESOLVED, QUESTION_RESOLVED, SSEEvent
from app.streaming.manager import GenerationJob, StreamManager
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

router = APIRouter()

_MANUAL_COMPACTION_MIN_USAGE_RATIO = 0.5

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


async def _get_session_context_usage_ratio(
    session_factory,
    session_id: str,
    provider_registry,
    model_id: str | None,
) -> float | None:
    resolved = provider_registry.resolve_model(model_id) if model_id else None
    if resolved is None and model_id is None:
        return None
    if resolved is None:
        return None

    _provider, model_info = resolved
    effective_context = model_info.metadata.get("effective_context_window") if model_info.metadata else None
    max_context = (
        min(effective_context, model_info.capabilities.max_context)
        if isinstance(effective_context, (int, float)) and effective_context > 0
        else model_info.capabilities.max_context
    )
    if not max_context or max_context <= 0:
        return None

    async with session_factory() as db:
        async with db.begin():
            result = await db.execute(
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.time_created.desc())
            )
            messages = list(result.scalars().all())

    for msg in messages:
        data = msg.data or {}
        if data.get("role") != "assistant":
            continue
        tokens = data.get("tokens") or {}
        if not isinstance(tokens, dict):
            continue
        input_tokens = int(tokens.get("input", 0) or 0)
        cache_read = int(tokens.get("cache_read", 0) or 0)
        total_tokens = input_tokens + cache_read
        if total_tokens > 0:
            return total_tokens / max_context
    return 0.0


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
    # Browser chat jobs are interactive as soon as they are created. The SSE
    # stream may connect a moment later, but ask-first permissions must never
    # race ahead as non-interactive work.
    job.interactive = True

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


@router.post("/chat/compact", response_model=PromptResponse)
async def start_compaction(
    body: CompactRequest,
    sm: StreamManagerDep,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
) -> PromptResponse:
    """Start a manual compaction stream. Reuses the normal SSE/abort lifecycle."""
    async with session_factory() as db:
        async with db.begin():
            session = await get_session(db, body.session_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Session not found")

    usage_ratio = await _get_session_context_usage_ratio(
        session_factory,
        body.session_id,
        provider_registry,
        body.model_id,
    )
    if usage_ratio is not None and usage_ratio < _MANUAL_COMPACTION_MIN_USAGE_RATIO:
        raise HTTPException(
            status_code=409,
            detail="Manual compaction is available only after context usage reaches 50%",
        )

    if any(job.session_id == body.session_id and not job.completed for job in sm._jobs.values()):
        raise HTTPException(status_code=409, detail="Session is currently busy")

    stream_id = generate_ulid()
    job = sm.create_job(stream_id=stream_id, session_id=body.session_id)

    async def _run_compaction_job() -> None:
        try:
            async with session_factory() as db:
                async with db.begin():
                    session = await get_session(db, body.session_id)
                    if session is not None:
                        session.time_compacting = datetime.now(timezone.utc)

            result = await run_compaction(
                body.session_id,
                job=job,
                session_factory=session_factory,
                provider_registry=provider_registry,
                agent_registry=agent_registry,
                model_id=body.model_id,
                visible_summary=True,
            )

            if not job.abort_event.is_set():
                if not result.summary and result.pruned_parts == 0:
                    job.publish(SSEEvent(COMPACTION_ERROR, {"error_message": "Nothing to compact yet"}))
                elif not result.summary:
                    job.publish(SSEEvent(COMPACTION_ERROR, {"error_message": "Compaction stopped before an AI summary was produced"}))
        except Exception:
            logger.exception("Compaction error for stream %s", job.stream_id)
            job.publish(SSEEvent(COMPACTION_ERROR, {"error_message": "Context compaction failed. Please try again."}))
        finally:
            async with session_factory() as db:
                async with db.begin():
                    session = await get_session(db, body.session_id)
                    if session is not None:
                        session.time_compacting = None
            job.publish(
                SSEEvent(
                    DONE,
                    {
                        "session_id": body.session_id,
                        "finish_reason": "aborted" if job.abort_event.is_set() else "stop",
                    },
                )
            )
            job.complete()

    task = asyncio.create_task(
        _run_with_semaphore(sm, job, _run_compaction_job()),
        name=f"compact-{stream_id}",
    )
    task.add_done_callback(functools.partial(_on_task_done, job=job))
    job.task = task

    return PromptResponse(stream_id=stream_id, session_id=body.session_id)


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
    job.interactive = True

    # Build a PromptRequest for run_generation (reuses existing flow)
    edit_request = PromptRequest(
        session_id=body.session_id,
        text=body.text,
        model=body.model,
        agent=body.agent,
        attachments=body.attachments,
        permission_presets=body.permission_presets,
        permission_rules=body.permission_rules,
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


@router.api_route("/chat/stream/{stream_id}", methods=["GET", "POST"])
async def stream_events(
    request: Request,
    sm: StreamManagerDep,
    stream_id: str,
    last_event_id: int = 0,
):
    """SSE endpoint. Supports reconnect via ?last_event_id=N.

    Includes heartbeat every 15s to prevent proxy/CDN timeouts (matching OpenCode).
    Sets job.interactive=True to enable permission ask and question blocking.
    """
    # Native EventSource reconnects send Last-Event-ID as an HTTP header rather
    # than as a query param. The local desktop app uses native EventSource for
    # SSE, so if we only honor ?last_event_id=... then auto-reconnect falls back
    # to replaying from event 0, which can stall or desync the frontend on long
    # generations. Prefer the explicit query param when provided, otherwise
    # accept the standard header.
    if last_event_id == 0:
        header_value = request.headers.get("last-event-id")
        if header_value:
            try:
                last_event_id = int(header_value)
            except ValueError:
                last_event_id = 0

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

    # Padding to push SSE data past Cloudflare tunnel's response buffer.
    # Without this, small SSE chunks are held by the tunnel and never
    # delivered to the client until enough data accumulates (~4KB).
    _SSE_PADDING = ": " + "x" * 4096 + "\n\n"

    async def event_generator():
        # Send padding first to flush the tunnel buffer
        yield _SSE_PADDING

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
async def list_active(sm: StreamManagerDep) -> list[dict[str, Any]]:
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
    allowed = body.response
    if isinstance(body.response, dict) and "allowed" in body.response:
        allowed = body.response.get("allowed")
    if isinstance(allowed, bool):
        job.publish(SSEEvent(PERMISSION_RESOLVED, {"call_id": body.call_id, "allowed": allowed, "source": source}))
    else:
        job.publish(SSEEvent(QUESTION_RESOLVED, {"call_id": body.call_id, "source": source}))

    return {"status": "submitted"}


async def _error_stream(message: str):
    """Yield a single error event."""
    event = SSEEvent(AGENT_ERROR, {"error_message": message})
    event.id = 1
    yield event.encode()
