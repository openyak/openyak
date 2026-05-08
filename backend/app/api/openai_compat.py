"""OpenAI-compatible API endpoints for external integrations.

Exposes /v1/chat/completions and /v1/models so OpenYak can be used as a
drop-in OpenAI-compatible backend. Internally delegates to the same
run_generation() pipeline used by the native chat API.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import time
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.dependencies import (
    AgentRegistryDep,
    IndexManagerDep,
    ProviderRegistryDep,
    SessionFactoryDep,
    StreamManagerDep,
    ToolRegistryDep,
)
from app.schemas.chat import PromptRequest
from app.session.manager import create_session, get_session
from app.session.processor import run_generation
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    PERMISSION_REQUEST,
    QUESTION,
    TEXT_DELTA,
    TOOL_START,
    TOOL_RESULT,
    SSEEvent,
)
from app.streaming.manager import GenerationJob, StreamManager
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

router = APIRouter()

# Heartbeat interval — keeps the SSE connection alive through proxies.
_HEARTBEAT_INTERVAL = 15.0

# Agent name prefix used in model IDs: "openyak-build" -> agent "build"
_MODEL_PREFIX = "openyak-"

# Available agents exposed as model IDs.
_AGENT_MODELS = {
    "openyak-build": {"agent": "build", "description": "Full-featured assistant with all tools"},
    "openyak-plan": {"agent": "plan", "description": "Read-only analysis and planning"},
    "openyak-explore": {"agent": "explore", "description": "Fast search and exploration"},
    "openyak-general": {"agent": "general", "description": "General-purpose assistant"},
}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str = "user"
    content: Any = ""
    name: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str = "openyak-build"
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = False
    user: str | None = None  # Channel user key for session mapping
    temperature: float | None = None
    max_tokens: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_agent(model: str) -> str:
    """Map model ID to agent name. Falls back to 'build'."""
    if model in _AGENT_MODELS:
        return _AGENT_MODELS[model]["agent"]
    if model.startswith(_MODEL_PREFIX):
        return model[len(_MODEL_PREFIX):]
    return "build"


def _resolve_default_model(registry: ProviderRegistryDep) -> str | None:
    """Pick the best model for external API calls.

    Priority: Anthropic > paid OpenRouter > free.
    """
    all_models = registry.all_models()
    if not all_models:
        return None

    # 1. Anthropic
    anth = [m for m in all_models if m.provider_id == "anthropic"]
    if anth:
        return anth[0].id

    # 2. Paid models
    paid = [m for m in all_models if m.pricing and (m.pricing.prompt > 0 or m.pricing.completion > 0)]
    if paid:
        return paid[0].id

    return all_models[0].id


def _extract_prompt(messages: list[ChatMessage]) -> tuple[str, str | None]:
    """Extract prompt text and optional system context from OpenAI messages.

    Returns (user_text, system_text).
    OpenClaw system messages (gateway status, metadata) are discarded to
    avoid wasting tokens and confusing the agent.
    """
    user_text = ""

    for msg in messages:
        content = msg.content if isinstance(msg.content, str) else _content_to_text(msg.content)
        if msg.role == "user":
            user_text = content  # Last user message wins

    # Strip OpenClaw metadata from user text (OpenClaw sometimes embeds
    # system metadata directly in the user message content)
    user_text = _strip_openclaw_metadata(user_text)

    return user_text, None


def _strip_openclaw_metadata(text: str) -> str:
    """Remove OpenClaw system metadata embedded in user message text.

    OpenClaw sometimes sends messages like:
      System: [2026-03-26 17:00:46 EDT] WhatsApp gateway connected as +1234567890.
      Conversation info (untrusted metadata):
      ```json
      { "message_id": "...", "sender_id": "...", "sender": "Alice" }
      ```
      Sender (untrusted metadata):
      ```json
      { "label": "Alice (+1234567890)", ... }
      ```
      actual user message here

    We strip everything before the actual user message.
    """
    import re as _re

    if not text:
        return text

    # Remove "System: [timestamp] ..." lines
    text = _re.sub(r"System:\s*\[.*?\].*?(?:\n|$)", "", text)

    # Remove metadata blocks: "Label (untrusted metadata):\n```json\n{...}\n```\n"
    text = _re.sub(
        r"(?:Conversation|Sender|Message|Channel)\s+(?:info\s+)?\(untrusted metadata\):\s*```(?:json)?\s*\{[^}]*\}\s*```\s*",
        "",
        text,
        flags=_re.DOTALL | _re.IGNORECASE,
    )

    # Also handle without code fences: "Label (untrusted metadata):\n{...}\n"
    text = _re.sub(
        r"(?:Conversation|Sender|Message|Channel)\s+(?:info\s+)?\(untrusted metadata\):\s*\{[^}]*\}\s*",
        "",
        text,
        flags=_re.DOTALL | _re.IGNORECASE,
    )

    return text.strip()


def _extract_sender_info(messages: list[ChatMessage]) -> dict[str, str | None]:
    """Extract sender name and other metadata from OpenClaw's system messages.

    OpenClaw includes system messages like:
      Conversation info (untrusted metadata):
      { "sender": "Alice", "sender_id": "+1234567890" }
      Sender (untrusted metadata):
      { "label": "Alice (+1234567890)", "name": "Alice" }

    Returns dict with keys: name, label, id.
    """
    import re as _re

    info: dict[str, str | None] = {"name": None, "label": None, "id": None}

    for msg in messages:
        content = msg.content if isinstance(msg.content, str) else ""

        # Find JSON blocks in both system and user messages
        # (OpenClaw sometimes embeds metadata in user messages)
        for match in _re.finditer(r"\{[^{}]+\}", content):
            try:
                data = json.loads(match.group())
                if not info["name"]:
                    info["name"] = data.get("sender") or data.get("name")
                if not info["label"]:
                    info["label"] = data.get("label")
                if not info["id"]:
                    info["id"] = data.get("sender_id") or data.get("id")
            except (json.JSONDecodeError, TypeError):
                continue

    return info


def _content_to_text(content: Any) -> str:
    """Convert OpenAI multimodal content array to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    parts.append(part.get("text", ""))
                elif part.get("type") == "input_text":
                    parts.append(part.get("text", ""))
        return "\n".join(parts)
    return str(content) if content else ""


def _on_task_done(task: asyncio.Task[None], *, job: GenerationJob) -> None:
    """Log unhandled exceptions from generation tasks."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("OpenAI-compat generation failed %s: %s", task.get_name(), exc, exc_info=exc)
        try:
            job.publish(SSEEvent(AGENT_ERROR, {"error_message": "Internal error."}))
        except Exception:
            pass


async def _run_with_semaphore(sm: StreamManager, job: GenerationJob, coro) -> None:
    try:
        await asyncio.wait_for(sm._semaphore.acquire(), timeout=30)
    except asyncio.TimeoutError:
        job.publish(SSEEvent(AGENT_ERROR, {"error_message": "Server busy."}))
        job.complete()
        return
    try:
        await coro
    finally:
        sm._semaphore.release()


async def _get_or_create_session(
    session_factory: SessionFactoryDep,
    channel_user_key: str,
    sender_name: str | None = None,
) -> str:
    """Find existing session for a channel user or create a new one.

    Uses a simple lookup: search sessions whose slug matches the channel key.
    The slug field is repurposed as a stable channel identifier.
    """
    async with session_factory() as db:
        from sqlalchemy import select
        from app.models.session import Session

        stmt = (
            select(Session)
            .where(Session.slug == channel_user_key, Session.parent_id.is_(None))
            .order_by(Session.time_created.desc())
            .limit(1)
        )
        result = await db.execute(stmt)
        session = result.scalar_one_or_none()

        if session:
            # Auto-update ugly titles if we now have a sender name
            if sender_name and (
                session.title.startswith("Channel: ")
                or session.title.startswith("System: ")
            ):
                session.title = sender_name
                await db.commit()
            return session.id

        # Build a nice title from sender info
        title = sender_name or _pretty_channel_key(channel_user_key)

        new_session = await create_session(db, title=title)
        new_session.slug = channel_user_key
        await db.commit()
        return new_session.id


def _pretty_channel_key(key: str) -> str:
    """Make a channel key human-readable.

    'whatsapp:+14164197360' → '+14164197360'
    'discord:user_123' → 'user_123'
    """
    if ":" in key:
        return key.split(":", 1)[1]
    return key


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/models")
async def list_models():
    """List available models (agents)."""
    models = []
    for model_id, info in _AGENT_MODELS.items():
        models.append({
            "id": model_id,
            "object": "model",
            "created": 1700000000,
            "owned_by": "openyak",
            "description": info["description"],
        })
    return {"object": "list", "data": models}


@router.post("/v1/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    sm: StreamManagerDep,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
    tool_registry: ToolRegistryDep,
    index_manager: IndexManagerDep,
):
    """OpenAI-compatible chat completions endpoint.

    Delegates to OpenYak's full agent loop (run_generation) and translates
    SSE events into the OpenAI streaming format.
    """
    # Extract sender info from OpenClaw's system messages (for session title)
    sender_info = _extract_sender_info(body.messages)
    sender_name = sender_info["name"] or sender_info["label"]

    # Resolve session
    if body.user:
        session_id = await _get_or_create_session(session_factory, body.user, sender_name=sender_name)
    else:
        session_id = generate_ulid()

    stream_id = generate_ulid()
    agent = _resolve_agent(body.model)
    user_text, _system_text = _extract_prompt(body.messages)

    if not user_text:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "No user message found in messages array.", "type": "invalid_request_error"}},
        )

    # Create generation job
    job = sm.create_job(stream_id=stream_id, session_id=session_id)
    # Non-interactive: permissions auto-approve in headless mode
    job.interactive = False

    # Use the user's best model (subscription > anthropic > paid > free)
    model_id = _resolve_default_model(provider_registry)
    logger.info("OpenAI-compat: agent=%s, model=%s", agent, model_id)

    prompt_request = PromptRequest(
        session_id=session_id,
        text=user_text,
        agent=agent,
        model=model_id,
    )

    coro = run_generation(
        job,
        prompt_request,
        session_factory=session_factory,
        provider_registry=provider_registry,
        agent_registry=agent_registry,
        tool_registry=tool_registry,
        index_manager=index_manager,
    )
    task = asyncio.create_task(
        _run_with_semaphore(sm, job, coro),
        name=f"gen-oai-{stream_id}",
    )
    task.add_done_callback(functools.partial(_on_task_done, job=job))
    job.task = task

    if body.stream:
        return StreamingResponse(
            _stream_openai_chunks(job, body.model, stream_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        return await _collect_response(job, body.model, stream_id)


async def _stream_openai_chunks(
    job: GenerationJob,
    model: str,
    run_id: str,
):
    """Translate OpenYak SSE events into OpenAI streaming chunks."""
    queue = job.subscribe()
    created = int(time.time())

    # Initial role chunk
    yield _sse({"id": run_id, "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})

    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
                continue

            if event is None:
                break

            if event.event == TEXT_DELTA:
                text = event.data.get("text", "")
                if text:
                    yield _sse({"id": run_id, "object": "chat.completion.chunk", "created": created, "model": model,
                                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]})

            elif event.event == DONE:
                yield _sse({"id": run_id, "object": "chat.completion.chunk", "created": created, "model": model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
                yield "data: [DONE]\n\n"
                break

            elif event.event == AGENT_ERROR:
                error_msg = event.data.get("error_message", "Unknown error")
                # Send error as content then stop
                yield _sse({"id": run_id, "object": "chat.completion.chunk", "created": created, "model": model,
                            "choices": [{"index": 0, "delta": {"content": f"\n[Error: {error_msg}]"}, "finish_reason": None}]})
                yield _sse({"id": run_id, "object": "chat.completion.chunk", "created": created, "model": model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
                yield "data: [DONE]\n\n"
                break

            # tool-call, tool-result, permission-request, etc. are silent — internal to OpenYak

    except asyncio.CancelledError:
        pass


async def _collect_response(
    job: GenerationJob,
    model: str,
    run_id: str,
) -> JSONResponse:
    """Collect all text-delta events and return a single chat completion response."""
    queue = job.subscribe()
    text_parts: list[str] = []
    error_msg: str | None = None

    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=300)
        except asyncio.TimeoutError:
            error_msg = "Generation timed out."
            break

        if event is None:
            break

        if event.event == TEXT_DELTA:
            text_parts.append(event.data.get("text", ""))
        elif event.event == DONE:
            break
        elif event.event == AGENT_ERROR:
            error_msg = event.data.get("error_message", "Unknown error")
            break

    content = "".join(text_parts)
    if error_msg and not content:
        content = f"[Error: {error_msg}]"

    return JSONResponse({
        "id": run_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


def _sse(data: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(data)}\n\n"
