"""Session processor — single LLM step execution.

SessionProcessor handles one LLM step:
  1. Stream from LLM with retry
  2. Accumulate text / reasoning / tool calls
  3. Execute tools (with permissions, doom-loop guard, timeout)
  4. Persist text parts + tool parts + step-finish part
  5. Return "continue" | "stop" | "compact"

The outer loop, setup, and post-loop work live in SessionPrompt (session/prompt.py).

Mirrors OpenCode's session/processor.ts.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.agent.permission import (
    GLOBAL_DEFAULTS,
    RejectedError,
    evaluate,
    merge_rulesets,
)
from app.provider.registry import ProviderRegistry
from app.schemas.chat import PromptRequest
from app.session.llm import stream_llm
from app.models.message import Message
from app.session.manager import (
    create_message,
    create_part,
    get_message_history_for_llm,
    get_messages,
    get_session,
    update_part_data,
    update_session_title,
)
from app.session.retry import (
    MAX_RETRIES,
    is_auth_error,
    is_retryable,
    retry_delay,
    sleep_with_abort,
)
from app.session.system_prompt import build_system_prompt
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    MODEL_LOADING,
    PERMISSION_REQUEST,
    REASONING_DELTA,
    RETRY,
    STEP_FINISH,
    TEXT_DELTA,
    TOOL_ERROR,
    TOOL_RESULT,
    TOOL_START,
    SSEEvent,
)
from app.streaming.manager import GenerationJob
from app.tool.context import ToolContext
from app.tool.registry import ToolRegistry
from app.config import get_settings
from app.utils.id import generate_ulid

if TYPE_CHECKING:
    from app.session.prompt import SessionPrompt

logger = logging.getLogger(__name__)

# Doom loop: block after N identical consecutive tool calls
DOOM_LOOP_THRESHOLD = 3

# Tools that operate on file paths — used for two-dimensional permission check
_FILE_TOOLS = frozenset({"read", "write", "edit"})

# Tools that modify state — trigger todo reminders after execution
_MODIFYING_TOOLS = frozenset({"edit", "write", "bash", "code_execute"})

# Hard context guards for very large single-turn tool results
_MAX_TOOL_OUTPUT_CHARS = 20_000
_MAX_ASSISTANT_CONTENT_CHARS = 40_000
_MAX_REQUEST_CONTEXT_CHARS = 160_000
_HARD_MAX_OUTPUT_TOKENS = 8192
_MIN_OUTPUT_TOKENS = 256
_TOOL_TIMEOUT_SECONDS = 300

# Hard safety cap: exported for use in SessionPrompt
_HARD_MAX_STEPS = 50


# --- Daily web_search quota tracking (single-user desktop app) ---
_search_quota_date: str = ""
_search_quota_count: int = 0
_search_credits_mode: bool = False  # Sticky: True once proxy confirms Credits billing
_search_quota_lock = asyncio.Lock()


async def _get_search_quota() -> tuple[int, bool]:
    """Return (count_today, is_credits_mode), resetting if UTC day changed."""
    global _search_quota_date, _search_quota_count
    async with _search_quota_lock:
        today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        if _search_quota_date != today:
            _search_quota_date = today
            _search_quota_count = 0
        return _search_quota_count, _search_credits_mode


async def _increment_search_count(*, charged: bool = False) -> None:
    global _search_quota_date, _search_quota_count, _search_credits_mode
    async with _search_quota_lock:
        today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        if _search_quota_date != today:
            _search_quota_date = today
            _search_quota_count = 0
        _search_quota_count += 1
        if charged:
            _search_credits_mode = True


async def _track_session_file(
    session_factory: Any,
    session_id: str,
    file_path: str,
    tool_id: str,
) -> None:
    """Persist a file record for the workspace panel (deduplicated by path)."""
    import os
    from sqlalchemy import select
    from app.models.session_file import SessionFile
    from app.utils.id import generate_ulid

    file_name = os.path.basename(file_path)
    try:
        async with session_factory() as db:
            async with db.begin():
                # Deduplicate: skip if this exact path is already tracked
                existing = await db.execute(
                    select(SessionFile.id).where(
                        SessionFile.session_id == session_id,
                        SessionFile.file_path == file_path,
                    ).limit(1)
                )
                if existing.scalar_one_or_none() is not None:
                    return
                db.add(SessionFile(
                    id=generate_ulid(),
                    session_id=session_id,
                    file_path=file_path,
                    file_name=file_name,
                    tool_id=tool_id,
                    file_type="generated",
                ))
    except Exception:
        logger.debug("Failed to track session file: %s", file_path, exc_info=True)


def _is_jwt_expired(token: str, margin_seconds: int = 60) -> bool:
    """Check if a JWT access token is expired (or nearly so)."""
    import base64
    import time

    try:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp", 0)
        return time.time() >= (exp - margin_seconds)
    except Exception:
        return False


def _trim_for_context(text: str, limit: int, kind: str) -> str:
    if len(text) <= limit:
        return text
    head_len = int(limit * 0.75)
    tail_len = max(0, limit - head_len)
    head = text[:head_len]
    tail = text[-tail_len:] if tail_len > 0 else ""
    return (
        f"{head}\n\n"
        f"[{kind} truncated for context: original {len(text)} chars, kept {limit}]\n\n"
        f"{tail}"
    )


def _sanitize_llm_messages_for_request(
    messages: list[dict[str, Any]],
    *,
    session_id: str,
    model_max_context: int | None = None,
) -> list[dict[str, Any]]:
    """Clamp oversized LLM request context to prevent single-turn explosions.

    When *model_max_context* is provided, the character budget scales with the
    model's actual context window (``tokens * 3.5`` as a rough chars-per-token
    estimate for mixed English/CJK content). Falls back to the hard-coded
    160 000 char limit if unknown.
    """
    # Dynamic char budget based on model context window
    if model_max_context:
        max_request_chars = min(int(model_max_context * 3.5), 500_000)
    else:
        max_request_chars = _MAX_REQUEST_CONTEXT_CHARS  # 160k fallback

    sanitized: list[dict[str, Any]] = []

    for msg in messages:
        m = dict(msg)
        role = str(m.get("role", ""))
        content = m.get("content")
        if isinstance(content, str):
            if role == "tool":
                m["content"] = _trim_for_context(
                    content, _MAX_TOOL_OUTPUT_CHARS, "tool output"
                )
            elif role == "assistant":
                m["content"] = _trim_for_context(
                    content, _MAX_ASSISTANT_CONTENT_CHARS, "assistant content"
                )
        sanitized.append(m)

    total_chars = 0
    for m in sanitized:
        c = m.get("content")
        if isinstance(c, str):
            total_chars += len(c)

    if total_chars <= max_request_chars:
        return sanitized

    trimmed: list[dict[str, Any]] = []
    running = 0
    for m in reversed(sanitized):
        c = m.get("content")
        c_len = len(c) if isinstance(c, str) else 0
        if running + c_len > max_request_chars and trimmed:
            continue
        trimmed.append(m)
        running += c_len
    trimmed.reverse()

    logger.warning(
        "Context hard-clamped for session %s: chars=%d -> %d, messages=%d -> %d (budget=%d)",
        session_id,
        total_chars,
        running,
        len(sanitized),
        len(trimmed),
        max_request_chars,
    )
    return trimmed


def _strip_image_content(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove image_url entries from messages when the model doesn't support vision.

    Converts multimodal content arrays back to plain text strings.
    """
    result = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            text_parts = [
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            m = dict(msg)
            m["content"] = "\n".join(text_parts) if text_parts else "(image)"
            result.append(m)
        else:
            result.append(msg)
    return result


def _estimate_llm_message_tokens(messages: list[dict[str, Any]]) -> int:
    total_chars = 0
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            total_chars += len(c)
        elif isinstance(c, list):
            for item in c:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        total_chars += len(str(item.get("text", "")))
                    elif item.get("type") == "image_url":
                        total_chars += 512
    return max(1, total_chars // 4)


def _compute_safe_max_tokens(
    messages: list[dict[str, Any]],
    *,
    model_max_context: int,
    model_max_output: int | None,
) -> int:
    estimated_input = _estimate_llm_message_tokens(messages)
    reserved = max(2048, int(model_max_context * 0.08))
    remaining = model_max_context - estimated_input - reserved

    hard_cap = model_max_output or _HARD_MAX_OUTPUT_TOKENS
    hard_cap = max(_MIN_OUTPUT_TOKENS, min(hard_cap, _HARD_MAX_OUTPUT_TOKENS))

    if remaining <= _MIN_OUTPUT_TOKENS:
        return _MIN_OUTPUT_TOKENS
    return max(_MIN_OUTPUT_TOKENS, min(hard_cap, remaining))


def _repair_tool_call_payload(
    tool_name: str, tool_args: Any
) -> tuple[str, dict[str, Any]]:
    """Repair malformed tool-call payloads emitted by some models."""
    name = tool_name or ""
    args: Any = tool_args if tool_args is not None else {}

    if isinstance(args, list) and args and isinstance(args[0], dict):
        first = args[0]
        fn = first.get("function") if isinstance(first.get("function"), dict) else None
        if fn:
            if not name and isinstance(fn.get("name"), str):
                name = fn["name"]
            params = fn.get("parameters")
            if isinstance(params, dict):
                args = params

    if isinstance(args, dict) and isinstance(args.get("function"), dict):
        fn = args["function"]
        if not name and isinstance(fn.get("name"), str):
            name = fn["name"]
        params = fn.get("parameters")
        if isinstance(params, dict):
            args = params

    if isinstance(args, dict) and isinstance(args.get("parameters"), dict):
        args = args["parameters"]

    if not isinstance(args, dict):
        args = {"_raw": args}

    return name, args


def _calculate_step_cost(
    usage_data: dict[str, Any],
    model_info: Any,
    *,
    markup_percent: float = 0.0,
) -> float:
    """Calculate per-step USD cost from canonical token usage."""
    if not usage_data or not model_info or not model_info.pricing:
        return 0.0

    prompt_price = model_info.pricing.prompt or 0
    completion_price = model_info.pricing.completion or 0
    if prompt_price <= 0 and completion_price <= 0:
        return 0.0

    input_tokens = usage_data.get("input", 0)
    output_tokens = usage_data.get("output", 0)
    reasoning_tokens = usage_data.get("reasoning", 0)

    raw_cost = (
        input_tokens * prompt_price / 1_000_000
        + (output_tokens + reasoning_tokens) * completion_price / 1_000_000
    )

    if markup_percent > 0:
        raw_cost *= 1 + markup_percent / 100

    return raw_cost


# ---------------------------------------------------------------------------
# run_generation — thin shim (preserves existing call sites in api/chat.py and task.py)
# ---------------------------------------------------------------------------


async def run_generation(
    job: GenerationJob,
    request: PromptRequest,
    *,
    session_factory: async_sessionmaker[AsyncSession],
    provider_registry: ProviderRegistry,
    agent_registry: AgentRegistry,
    tool_registry: ToolRegistry,
    index_manager: Any | None = None,
    skip_user_message: bool = False,
) -> None:
    """Run the full agent generation loop.

    Delegates to SessionPrompt which owns setup + the while-loop,
    and creates a SessionProcessor per step for LLM streaming + tool execution.
    """
    from app.session.prompt import SessionPrompt

    try:
        prompt = SessionPrompt(
            job,
            request,
            session_factory=session_factory,
            provider_registry=provider_registry,
            agent_registry=agent_registry,
            tool_registry=tool_registry,
            index_manager=index_manager,
            skip_user_message=skip_user_message,
        )
        await prompt.run()
    except IntegrityError:
        # Session was deleted while generation was in-flight — notify frontend
        # so it can exit the generating state, then stop.
        logger.info(
            "Session %s deleted during generation, stopping stream %s",
            job.session_id,
            job.stream_id,
        )
        job.publish(SSEEvent(DONE, {
            "session_id": job.session_id,
            "finish_reason": "aborted",
        }))
    except Exception:
        logger.exception("Generation error for stream %s", job.stream_id)
        job.publish(SSEEvent(AGENT_ERROR, {"error_message": "An internal error occurred. Please try again."}))
    finally:
        job.complete()


# ---------------------------------------------------------------------------
# SessionProcessor — handles a single LLM step
# ---------------------------------------------------------------------------


class SessionProcessor:
    """Handles one LLM step: stream → parse → execute tools.

    Created fresh per loop iteration by SessionPrompt._loop().
    Reads mutable state from session_prompt and writes back on agent switch.

    Mirrors OpenCode's SessionProcessor / processor.ts.
    """

    def __init__(
        self,
        session_prompt: SessionPrompt,
        llm_messages: list[dict[str, Any]],
        assistant_msg_id: str,
    ) -> None:
        self._sp = session_prompt
        self._llm_messages = llm_messages
        self._assistant_msg_id = assistant_msg_id

        # Step-local results exposed for SessionPrompt to accumulate
        self.usage_data: dict[str, Any] = {}
        self.finish_reason: str = "stop"
        self.step_cost: float = 0.0

    async def process(self) -> Literal["continue", "stop", "compact"]:
        """Execute one LLM step and return the loop continuation signal.

        Returns:
          "continue" — tool calls were made; loop again so LLM sees results
          "stop"     — no tool calls; model finished this turn
          "compact"  — context overflow detected; run compaction then continue
        """
        sp = self._sp
        job = sp.job
        session_factory = sp.session_factory

        # --- Persist step-start part (mirrors OpenCode's StepStartPart) ---
        async with session_factory() as db:
            async with db.begin():
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=job.session_id,
                    data={"type": "step-start", "step": sp.step},
                )

        has_tool_calls = False
        accumulated_text = ""
        accumulated_reasoning = ""
        tool_calls_in_step: list[dict[str, Any]] = []
        native_search_ids: set[str] = set()
        _ws_part_ids: dict[str, str] = {}  # web_search call_id → part_id
        stream_error: Exception | None = None

        # --- Stream from LLM with retry ---
        for attempt in range(MAX_RETRIES + 1):
            if job.abort_event.is_set():
                break

            try:
                reasoning_extra = None
                if sp.request.reasoning is False:
                    reasoning_extra = {"reasoning": {"enabled": False}}

                safe_max_tokens = _compute_safe_max_tokens(
                    self._llm_messages,
                    model_max_context=(
                        sp.model_info.capabilities.max_context if sp.model_info else 8192
                    ),
                    model_max_output=(
                        sp.model_info.capabilities.max_output if sp.model_info else None
                    ),
                )

                logger.info(
                    "Starting LLM stream for model=%s, messages=%d, max_tokens=%d",
                    sp.model_id,
                    len(self._llm_messages),
                    safe_max_tokens,
                )

                _exclude_tools: set[str] | None = None
                _sq_count, _sq_credits = await _get_search_quota()
                if not _sq_credits and _sq_count >= get_settings().daily_search_limit:
                    _exclude_tools = {"web_search"}

                # Use native web search for OpenAI subscription provider
                if sp.provider.id == "openai-subscription":
                    _exclude_tools = _exclude_tools or set()
                    _exclude_tools.add("web_search")

                # Notify frontend that the model may need loading (Ollama cold start)
                if sp.provider.id == "ollama":
                    job.publish(SSEEvent(MODEL_LOADING, {"model": sp.model_id, "status": "loading"}))

                # Strip image_url from messages if model doesn't support vision.
                # User-attached images may have image_url content.
                _llm_msgs = self._llm_messages
                if sp.model_info and not sp.model_info.capabilities.vision:
                    _llm_msgs = _strip_image_content(_llm_msgs)

                async for chunk in stream_llm(
                    sp.provider,
                    sp.model_id,
                    _llm_msgs,
                    system_prompt=sp.system_prompt,
                    agent=sp.agent,
                    tool_registry=sp.tool_registry,
                    extra_body=reasoning_extra,
                    max_tokens=safe_max_tokens,
                    exclude_tools=_exclude_tools,
                    response_format=sp.request.format,
                ):
                    if job.abort_event.is_set():
                        break

                    logger.debug("LLM chunk: type=%s", chunk.type)
                    match chunk.type:
                        case "text-delta":
                            text = chunk.data.get("text", "")
                            accumulated_text += text
                            job.publish(
                                SSEEvent(
                                    TEXT_DELTA,
                                    {
                                        "session_id": job.session_id,
                                        "message_id": self._assistant_msg_id,
                                        "text": text,
                                    },
                                )
                            )

                        case "reasoning-delta":
                            text = chunk.data.get("text", "")
                            accumulated_reasoning += text
                            job.publish(SSEEvent(REASONING_DELTA, {"text": text}))

                        case "tool-call":
                            has_tool_calls = True
                            tool_calls_in_step.append(chunk.data)

                        case "web-search-start":
                            # Native web search started (OpenAI subscription)
                            ws_call_id = chunk.data.get("id", "")
                            ws_query = chunk.data.get("query", "")
                            native_search_ids.add(ws_call_id)

                            # Persist "running" tool part
                            _ws_part_ids[ws_call_id] = generate_ulid()
                            async with session_factory() as db:
                                async with db.begin():
                                    await create_part(
                                        db,
                                        message_id=self._assistant_msg_id,
                                        session_id=job.session_id,
                                        part_id=_ws_part_ids[ws_call_id],
                                        data={
                                            "type": "tool",
                                            "tool": "web_search",
                                            "call_id": ws_call_id,
                                            "state": {"status": "running", "input": {"query": ws_query}},
                                        },
                                    )

                            # Emit TOOL_START so frontend shows searching state
                            job.publish(SSEEvent(
                                TOOL_START,
                                {
                                    "tool": "web_search",
                                    "call_id": ws_call_id,
                                    "arguments": {"query": ws_query},
                                    "session_id": job.session_id,
                                },
                            ))

                        case "web-search-result":
                            # Native web search completed (OpenAI subscription)
                            ws_call_id = chunk.data.get("id", "")
                            ws_query = chunk.data.get("query", "")
                            ws_results = chunk.data.get("results", [])

                            # Format results like the custom web_search tool
                            output_lines: list[str] = []
                            results_data: list[dict[str, str]] = []
                            for i, r in enumerate(ws_results, 1):
                                title = r.get("title", "")
                                url = r.get("url", "")
                                snippet = r.get("snippet", "")
                                output_lines.append(f"{i}. {title}")
                                output_lines.append(f"   {url}")
                                if snippet:
                                    output_lines.append(f"   {snippet}")
                                output_lines.append("")
                                results_data.append({"url": url, "title": title, "snippet": snippet})

                            count = len(results_data)
                            output_text = "\n".join(output_lines) if output_lines else "No results found."
                            ws_title = f"Search: {ws_query[:50]} ({count} results)"
                            ws_metadata = {
                                "query": ws_query,
                                "count": count,
                                "results": results_data,
                                "_native": True,
                            }

                            # Update tool part to completed
                            ws_part_id = _ws_part_ids.pop(ws_call_id, None)
                            if ws_part_id:
                                async with session_factory() as db:
                                    async with db.begin():
                                        await update_part_data(
                                            db,
                                            part_id=ws_part_id,
                                            data={
                                                "type": "tool",
                                                "tool": "web_search",
                                                "call_id": ws_call_id,
                                                "state": {
                                                    "status": "completed",
                                                    "input": {"query": ws_query},
                                                    "output": output_text,
                                                    "title": ws_title,
                                                    "metadata": ws_metadata,
                                                },
                                            },
                                        )

                            # Emit TOOL_RESULT so frontend updates to completed
                            job.publish(SSEEvent(
                                TOOL_RESULT,
                                {
                                    "call_id": ws_call_id,
                                    "tool": "web_search",
                                    "output": output_text[:500],
                                    "title": ws_title,
                                    "metadata": ws_metadata,
                                },
                            ))

                        case "usage":
                            self.usage_data = chunk.data

                        case "finish":
                            raw_reason = chunk.data.get("reason", "stop")
                            # Normalize: OpenAI uses "tool_calls", we use "tool_use"
                            if raw_reason == "tool_calls":
                                raw_reason = "tool_use"
                            self.finish_reason = raw_reason

                        case "error":
                            if accumulated_text:
                                async with session_factory() as db:
                                    async with db.begin():
                                        await create_part(
                                            db,
                                            message_id=self._assistant_msg_id,
                                            session_id=job.session_id,
                                            data={"type": "text", "text": accumulated_text},
                                        )
                            job.publish(
                                SSEEvent(
                                    AGENT_ERROR,
                                    {"error_message": chunk.data.get("message", "LLM error")},
                                )
                            )
                            await _delete_empty_assistant_messages(session_factory, job.session_id)
                            return "stop"

                stream_error = None
                logger.info(
                    "LLM stream completed: text=%d chars, reasoning=%d chars, "
                    "tool_calls=%d, finish=%s",
                    len(accumulated_text),
                    len(accumulated_reasoning),
                    len(tool_calls_in_step),
                    self.finish_reason,
                )

                # --- Empty response guard: retry if LLM produced nothing ---
                if (
                    not accumulated_text.strip()
                    and not has_tool_calls
                    and not accumulated_reasoning
                    and not job.abort_event.is_set()
                    and attempt < 2
                ):
                    logger.warning(
                        "Empty LLM response (attempt %d/%d), retrying",
                        attempt + 1,
                        MAX_RETRIES + 1,
                    )
                    accumulated_text = ""
                    accumulated_reasoning = ""
                    tool_calls_in_step = []
                    has_tool_calls = False
                    continue

                break

            except Exception as e:
                if is_auth_error(e) and attempt == 0:
                    _settings = get_settings()
                    if _settings.proxy_refresh_token:
                        from app.provider.proxy_auth import refresh_proxy_token

                        refreshed = await refresh_proxy_token(_settings, sp.provider_registry)
                        if refreshed:
                            logger.info("Proxy token refreshed after 401, retrying stream")
                            accumulated_text = ""
                            accumulated_reasoning = ""
                            tool_calls_in_step = []
                            has_tool_calls = False
                            continue

                stream_error = e
                retry_reason = is_retryable(e)

                if retry_reason and attempt < MAX_RETRIES:
                    delay = retry_delay(attempt, e)
                    logger.warning(
                        "LLM stream error (attempt %d/%d, %s), retrying in %.1fs: %s",
                        attempt + 1,
                        MAX_RETRIES,
                        retry_reason,
                        delay,
                        e,
                    )
                    job.publish(
                        SSEEvent(
                            RETRY,
                            {
                                "attempt": attempt + 1,
                                "max_retries": MAX_RETRIES,
                                "delay": delay,
                                "reason": retry_reason,
                                "message": str(e),
                            },
                        )
                    )
                    accumulated_text = ""
                    accumulated_reasoning = ""
                    tool_calls_in_step = []
                    has_tool_calls = False
                    aborted = await sleep_with_abort(delay, job.abort_event)
                    if aborted:
                        break
                    continue
                else:
                    break

        if stream_error:
            logger.exception("LLM stream error (not retryable or retries exhausted)")
            if accumulated_text:
                async with session_factory() as db:
                    async with db.begin():
                        await create_part(
                            db,
                            message_id=self._assistant_msg_id,
                            session_id=job.session_id,
                            data={"type": "text", "text": accumulated_text},
                        )
            await _delete_empty_assistant_messages(session_factory, job.session_id)
            job.publish(SSEEvent(AGENT_ERROR, {"error_message": f"LLM stream error: {stream_error}"}))
            return "stop"

        # --- Empty output after retries: clean up and continue the loop ---
        # The model produced nothing (no text, no tools, no reasoning) even after retries.
        # Rather than surfacing an error, delete the empty assistant message shell and
        # return "continue" so the outer loop re-invokes the LLM with the full conversation
        # context intact. The hard step cap (50) prevents infinite looping.
        if (
            not accumulated_text.strip()
            and not has_tool_calls
            and not accumulated_reasoning
            and not stream_error
            and not job.abort_event.is_set()
        ):
            logger.warning(
                "LLM produced no output after retries for session %s, continuing loop",
                job.session_id,
            )
            # Publish a paired STEP_FINISH so the frontend step tracker stays consistent
            job.publish(SSEEvent(STEP_FINISH, {"tokens": None, "cost": 0.0, "total_cost": sp.total_cost, "reason": "empty"}))
            await _delete_empty_assistant_messages(session_factory, job.session_id)
            return "continue"

        # --- Persist text and reasoning parts ---
        async with session_factory() as db:
            async with db.begin():
                if accumulated_text.strip():
                    await create_part(
                        db,
                        message_id=self._assistant_msg_id,
                        session_id=job.session_id,
                        data={"type": "text", "text": accumulated_text},
                    )
                if accumulated_reasoning:
                    await create_part(
                        db,
                        message_id=self._assistant_msg_id,
                        session_id=job.session_id,
                        data={"type": "reasoning", "text": accumulated_reasoning},
                    )

        # --- Process tool calls ---
        # Filter out native web search calls (already persisted during streaming)
        if native_search_ids:
            tool_calls_in_step = [
                tc for tc in tool_calls_in_step
                if tc.get("id") not in native_search_ids
            ]
            if not tool_calls_in_step:
                has_tool_calls = False

        if has_tool_calls and tool_calls_in_step:
            for tc_data in tool_calls_in_step:
                if job.abort_event.is_set():
                    break

                tool_name = tc_data.get("name", "")
                tool_args = tc_data.get("arguments", {})
                call_id = tc_data.get("id", generate_ulid())
                tool_name, tool_args = _repair_tool_call_payload(tool_name, tool_args)

                # --- Doom loop detection ---
                sig = f"{tool_name}:{json.dumps(tool_args, sort_keys=True)}"
                sp.doom_history.append(sig)
                if len(sp.doom_history) >= DOOM_LOOP_THRESHOLD:
                    recent = sp.doom_history[-DOOM_LOOP_THRESHOLD:]
                    if all(s == recent[0] for s in recent):
                        if job.interactive:
                            allowed = await _ask_permission(
                                job,
                                call_id,
                                "doom_loop",
                                f"Tool '{tool_name}' called {DOOM_LOOP_THRESHOLD} times "
                                f"with identical arguments. Continue?",
                            )
                            if not allowed:
                                await _persist_tool_error(
                                    session_factory,
                                    self._assistant_msg_id,
                                    job.session_id,
                                    tool_name,
                                    call_id,
                                    tool_args,
                                    "Doom loop blocked by user",
                                )
                                return "stop"
                            sp.doom_history.clear()
                        else:
                            job.publish(
                                SSEEvent(
                                    AGENT_ERROR,
                                    {
                                        "error_type": "doom_loop",
                                        "error_message": (
                                            f"Detected doom loop: {tool_name} called "
                                            f"{DOOM_LOOP_THRESHOLD} times with identical arguments"
                                        ),
                                        "tool": tool_name,
                                    },
                                )
                            )
                            await _persist_tool_error(
                                session_factory,
                                self._assistant_msg_id,
                                job.session_id,
                                tool_name,
                                call_id,
                                tool_args,
                                "Doom loop detected",
                            )
                            return "stop"

                # --- Tool call repair ---
                tool = sp.tool_registry.get(tool_name)
                if tool is None:
                    tool = sp.tool_registry.get(tool_name.lower())
                if tool is None:
                    tool = sp.tool_registry.get("invalid")
                    if tool:
                        tool_args = {"name": tool_name}

                if tool is None:
                    job.publish(
                        SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": f"Tool not found: {tool_name}"})
                    )
                    continue

                # --- Two-dimensional permission check ---
                resource_pattern = "*"
                if tool.id in _FILE_TOOLS:
                    resource_pattern = tool_args.get("file_path", "*")

                action = evaluate(tool.id, resource_pattern, sp.merged_permissions)

                if action == "deny":
                    job.publish(
                        SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": f"Permission denied for tool: {tool.id}"})
                    )
                    await _persist_tool_error(
                        session_factory,
                        self._assistant_msg_id,
                        job.session_id,
                        tool.id,
                        call_id,
                        tool_args,
                        "Permission denied",
                    )
                    continue

                if action == "ask":
                    if job.interactive:
                        allowed = await _ask_permission(
                            job,
                            call_id,
                            tool.id,
                            f"Allow tool '{tool.id}' with arguments: "
                            f"{json.dumps(tool_args, default=str)[:200]}?",
                        )
                        if not allowed:
                            job.publish(
                                SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": f"User denied permission for: {tool.id}"})
                            )
                            await _persist_tool_error(
                                session_factory,
                                self._assistant_msg_id,
                                job.session_id,
                                tool.id,
                                call_id,
                                tool_args,
                                "Permission denied by user",
                            )
                            continue
                    # else: auto-approve in headless/test mode

                # --- Execute tool (2-phase ToolPart state machine) ---
                # Phase 1: persist "running" and emit TOOL_START SSE so the UI shows it immediately.
                # SSE handles real-time display; a separate "pending" DB write adds a roundtrip
                # with no observable benefit since the frontend is driven by SSE events.
                tool_part_id = generate_ulid()
                async with session_factory() as db:
                    async with db.begin():
                        await create_part(
                            db,
                            message_id=self._assistant_msg_id,
                            session_id=job.session_id,
                            part_id=tool_part_id,
                            data={
                                "type": "tool",
                                "tool": tool.id,
                                "call_id": call_id,
                                "state": {"status": "running", "input": tool_args},
                            },
                        )

                job.publish(
                    SSEEvent(
                        TOOL_START,
                        {
                            "tool": tool.id,
                            "call_id": call_id,
                            "arguments": tool_args,
                            "session_id": job.session_id,
                        },
                    )
                )

                ctx = ToolContext(
                    session_id=job.session_id,
                    message_id=self._assistant_msg_id,
                    agent=sp.agent,
                    call_id=call_id,
                    abort_event=job.abort_event,
                    workspace=sp.workspace,
                    index_manager=getattr(sp, "index_manager", None),
                    messages=self._llm_messages,
                    _publish_fn=lambda event_type, data: job.publish(SSEEvent(event_type, data)),
                )
                # Inject runtime state for task tool and question tool
                ctx._app_state = {  # type: ignore[attr-defined]
                    "session_factory": session_factory,
                    "provider_registry": sp.provider_registry,
                    "agent_registry": sp.agent_registry,
                    "tool_registry": sp.tool_registry,
                }
                ctx._model_id = sp.model_id  # type: ignore[attr-defined]
                ctx._job = job  # type: ignore[attr-defined]
                ctx._depth = job._depth  # type: ignore[attr-defined]

                try:
                    result = await asyncio.wait_for(
                        tool(tool_args, ctx),
                        timeout=_TOOL_TIMEOUT_SECONDS,
                    )

                    if result.error:
                        job.publish(
                            SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": result.error, "tool": tool.id})
                        )
                    else:
                        job.publish(
                            SSEEvent(
                                TOOL_RESULT,
                                {
                                    "call_id": call_id,
                                    "tool": tool.id,
                                    "output": result.output[:500] if result.output else "",
                                    "title": result.title,
                                    "metadata": result.metadata,
                                },
                            )
                        )

                    # Web search quota tracking
                    if tool.id == "web_search" and result.success:
                        charged = bool(result.metadata and result.metadata.get("charged"))
                        await _increment_search_count(charged=charged)

                    # Track session files from write/edit tools
                    if (
                        tool.id in ("write", "edit")
                        and result.success
                        and result.metadata
                        and result.metadata.get("file_path")
                    ):
                        await _track_session_file(
                            session_factory,
                            session_id=job.session_id,
                            file_path=result.metadata["file_path"],
                            tool_id=tool.id,
                        )

                    # Track todos from todo tool results
                    if tool.id == "todo" and result.metadata and "todos" in result.metadata:
                        sp.current_todos = list(result.metadata["todos"])

                    # Build persisted output (may include todo reminder for LLM)
                    persist_output = result.output or result.error or ""
                    if (
                        tool.id in _MODIFYING_TOOLS
                        and tool.id != "todo"
                        and sp.current_todos
                        and any(
                            t.get("status") in ("pending", "in_progress")
                            for t in sp.current_todos
                        )
                    ):
                        persist_output += (
                            "\n\n<reminder>You have an active todo list. "
                            "Call the todo tool NOW to mark this task completed "
                            "and start the next one.</reminder>"
                        )

                    # NOTE: truncation is now handled in ToolDefinition.__call__
                    # via truncate_output() which saves full output to file.
                    # No second truncation here — the output is already trimmed.

                    # Phase 3: update to "completed" or "error"
                    async with session_factory() as db:
                        async with db.begin():
                            await update_part_data(
                                db,
                                tool_part_id,
                                {
                                    "type": "tool",
                                    "tool": tool.id,
                                    "call_id": call_id,
                                    "state": {
                                        "status": "completed" if result.success else "error",
                                        "input": tool_args,
                                        "output": persist_output,
                                        "title": result.title,
                                        "metadata": result.metadata,
                                    },
                                },
                            )

                    # Persist file attachments returned by the tool as FileParts
                    if result.attachments:
                        async with session_factory() as db:
                            async with db.begin():
                                for att in result.attachments:
                                    await create_part(
                                        db,
                                        message_id=self._assistant_msg_id,
                                        session_id=job.session_id,
                                        data={"type": "file", **att},
                                    )

                    # --- Agent switching (plan tool enter/exit) ---
                    if result.metadata and result.metadata.get("switch_agent"):
                        new_agent_name = result.metadata["switch_agent"]
                        new_agent = sp.agent_registry.get(new_agent_name)
                        if new_agent:
                            sp.agent = new_agent
                            if sp.agent.model:
                                new_resolved = sp.provider_registry.resolve_model(
                                    sp.agent.model.model_id
                                )
                                if new_resolved:
                                    sp.provider, sp.model_info = new_resolved
                                    sp.model_id = sp.agent.model.model_id
                            sp.rebuild_permissions_and_prompt()
                            logger.info("Agent switched to: %s", sp.agent.name)

                except asyncio.TimeoutError:
                    timeout_msg = f"Tool timed out after {_TOOL_TIMEOUT_SECONDS}s: {tool.id}"
                    logger.warning(timeout_msg)
                    job.publish(SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": timeout_msg}))
                    # Update part to error state
                    async with session_factory() as db:
                        async with db.begin():
                            await update_part_data(
                                db,
                                tool_part_id,
                                {
                                    "type": "tool",
                                    "tool": tool.id,
                                    "call_id": call_id,
                                    "state": {"status": "error", "input": tool_args, "output": timeout_msg},
                                },
                            )
                    continue

                except RejectedError as e:
                    rejected_msg = f"Permission denied: {e.permission}"
                    job.publish(
                        SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": rejected_msg})
                    )
                    try:
                        async with session_factory() as db:
                            async with db.begin():
                                await update_part_data(
                                    db,
                                    tool_part_id,
                                    {
                                        "type": "tool",
                                        "tool": tool.id,
                                        "call_id": call_id,
                                        "state": {"status": "error", "input": tool_args, "output": rejected_msg},
                                    },
                                )
                    except Exception:
                        logger.warning("Failed to persist RejectedError state for tool %s", tool.id)
                except Exception as e:
                    logger.exception("Tool execution error: %s", tool.id)
                    job.publish(SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": str(e)}))
                    try:
                        async with session_factory() as db:
                            async with db.begin():
                                await update_part_data(
                                    db,
                                    tool_part_id,
                                    {
                                        "type": "tool",
                                        "tool": tool.id,
                                        "call_id": call_id,
                                        "state": {"status": "error", "input": tool_args, "output": str(e)},
                                    },
                                )
                    except Exception:
                        logger.warning("Failed to persist error state for tool %s", tool.id)

        # --- Cost tracking ---
        if self.usage_data and sp.model_info:
            if sp.model_info.pricing and (
                sp.model_info.pricing.prompt > 0 or sp.model_info.pricing.completion > 0
            ):
                _cfg = get_settings()
                _effective_markup = (
                    _cfg.markup_percent if _cfg.proxy_url and _cfg.proxy_token else 0.0
                )
                self.step_cost = _calculate_step_cost(
                    self.usage_data, sp.model_info, markup_percent=_effective_markup
                )
            else:
                logger.warning(
                    "Pricing unavailable for model %s, cost will be $0.00 "
                    "(tokens: %d input, %d output)",
                    sp.model_info.id,
                    self.usage_data.get("input", 0),
                    self.usage_data.get("output", 0),
                )

        if self.usage_data:
            logger.info(
                "Step usage [%s]: input=%d, output=%d, reasoning=%d, "
                "cache_read=%d, cache_write=%d",
                sp.model_info.id if sp.model_info else "unknown",
                self.usage_data.get("input", 0),
                self.usage_data.get("output", 0),
                self.usage_data.get("reasoning", 0),
                self.usage_data.get("cache_read", 0),
                self.usage_data.get("cache_write", 0),
            )

        # --- Step finish ---
        job.publish(
            SSEEvent(
                STEP_FINISH,
                {
                    "tokens": self.usage_data,
                    "cost": self.step_cost,
                    "total_cost": sp.total_cost + self.step_cost,
                    "reason": self.finish_reason,
                },
            )
        )

        async with session_factory() as db:
            async with db.begin():
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=job.session_id,
                    data={
                        "type": "step-finish",
                        "reason": self.finish_reason,
                        "tokens": self.usage_data,
                        "cost": self.step_cost,
                    },
                )

        # --- Context overflow check → compaction ---
        if self.usage_data and sp.model_info:
            from app.session.compaction import should_compact

            max_ctx = sp.model_info.capabilities.max_context
            max_out = sp.model_info.capabilities.max_output
            if should_compact(self.usage_data, max_ctx, model_max_output=max_out):
                logger.info("Context overflow detected, running compaction")
                return "compact"

        # --- Determine continuation ---
        if not has_tool_calls:
            return "stop"

        return "continue"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _ask_permission(
    job: GenerationJob,
    call_id: str,
    permission: str,
    message: str,
) -> bool:
    """Ask user for permission via SSE and wait for response."""
    permission_call_id = generate_ulid()
    job.publish(
        SSEEvent(
            PERMISSION_REQUEST,
            {
                "call_id": permission_call_id,
                "tool_call_id": call_id,
                "permission": permission,
                "message": message,
            },
        )
    )

    try:
        response = await job.wait_for_response(permission_call_id, timeout=300.0)
        return str(response).lower() in ("allow", "yes", "true", "1")
    except TimeoutError:
        logger.warning("Permission request timed out for %s", permission)
        return False


async def _delete_empty_assistant_messages(
    session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
    *,
    _retried: bool = False,
) -> None:
    """Remove assistant message shells that ended with zero persisted parts."""
    try:
        async with session_factory() as db:
            async with db.begin():
                messages = await get_messages(db, session_id)
                for msg in messages:
                    payload = dict(msg.data) if msg.data else {}
                    if payload.get("role") == "assistant" and not msg.parts:
                        await db.delete(msg)
    except Exception:
        if not _retried:
            logger.warning("Retrying empty assistant cleanup for session %s", session_id)
            await _delete_empty_assistant_messages(
                session_factory, session_id, _retried=True
            )
        else:
            logger.error(
                "Failed to clean empty assistant messages for session %s after retry",
                session_id,
            )


async def _persist_tool_error(
    session_factory: async_sessionmaker[AsyncSession],
    assistant_msg_id: str,
    session_id: str,
    tool_name: str,
    call_id: str,
    tool_args: dict[str, Any],
    error_msg: str,
) -> None:
    """Persist a tool error part to the database."""
    async with session_factory() as db:
        async with db.begin():
            await create_part(
                db,
                message_id=assistant_msg_id,
                session_id=session_id,
                data={
                    "type": "tool",
                    "tool": tool_name,
                    "call_id": call_id,
                    "state": {
                        "status": "error",
                        "input": tool_args,
                        "output": error_msg,
                    },
                },
            )


