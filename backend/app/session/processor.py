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
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.agent.permission import (
    RejectedError,
    evaluate,
)
from app.provider.registry import ProviderRegistry
from app.schemas.agent import PermissionRule
from app.schemas.chat import PromptRequest
from app.schemas.message import StepFinishReason
from app.session.llm import stream_llm
from app.session.manager import (
    create_part,
    get_messages,
    update_part_data,
)
from app.session.retry import (
    MAX_RETRIES,
    is_context_overflow,
    is_retryable,
    max_retries_for_error,
    retry_delay,
    sleep_with_abort,
)
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
from app.session.utils import (
    calculate_step_cost as _calculate_step_cost,
    compute_safe_max_tokens as _compute_safe_max_tokens,
    get_effective_context_window as _get_effective_context_window,
    llm_messages_have_image_content as _llm_messages_have_image_content,
    repair_tool_call_payload as _repair_tool_call_payload,
)
from app.utils.id import generate_ulid

if TYPE_CHECKING:
    from app.session.prompt import SessionPrompt

logger = logging.getLogger(__name__)

# Loop detection: two-stage warn-then-stop (replaces old doom loop)
from app.session.loop_detection import loop_detector, LoopCheckResult

# Tools that operate on file paths — used for two-dimensional permission check
_FILE_TOOLS = frozenset({"read", "write", "edit"})

# Tools that modify state — trigger todo reminders after execution
_MODIFYING_TOOLS = frozenset({"edit", "write", "bash", "code_execute"})

_PERMISSION_ARGUMENT_CHAR_LIMIT = 20_000
_SENSITIVE_ARG_KEY_RE = re.compile(
    r"(api[_-]?key|authorization|bearer|cookie|password|secret|token)",
    re.IGNORECASE,
)

# Agent limits — read from Settings (user-configurable via env vars).
# Accessed via _cfg() to avoid stale module-level reads.
def _cfg():
    return get_settings()


def _normalize_step_finish_reason(reason: str | None) -> StepFinishReason:
    """Normalize provider/internal finish reasons to the frontend contract."""
    if reason == "tool_calls":
        return "tool_use"
    if reason in {"stop", "tool_use", "length", "error"}:
        return cast(StepFinishReason, reason)
    logger.warning("Unexpected step finish reason %r; normalizing to 'error'", reason)
    return "error"


# --- Daily web_search usage tracking (single-user desktop app) ---

class SearchQuotaTracker:
    """Tracks daily web_search usage with automatic UTC-day reset.

    Encapsulates mutable quota state behind a lock for thread safety.
    """

    def __init__(self) -> None:
        self._date: str = ""
        self._count: int = 0
        self._credits_mode: bool = False  # Sticky: True once hosted proxy confirms paid search.
        self._lock = asyncio.Lock()

    def _reset_if_new_day(self) -> None:
        today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        if self._date != today:
            self._date = today
            self._count = 0

    async def get_quota(self) -> tuple[int, bool]:
        """Return (count_today, is_credits_mode), resetting if UTC day changed."""
        async with self._lock:
            self._reset_if_new_day()
            return self._count, self._credits_mode

    async def increment(self, *, charged: bool = False) -> None:
        async with self._lock:
            self._reset_if_new_day()
            self._count += 1
            if charged:
                self._credits_mode = True


_search_quota = SearchQuotaTracker()


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


_PRESENTABLE_DELIVERABLE_EXTS = {
    ".csv",
    ".docx",
    ".html",
    ".md",
    ".pdf",
    ".pptx",
    ".svg",
    ".txt",
    ".xlsx",
}

_NON_PRESENTABLE_OUTPUT_HINTS = {
    "helper",
    "scratch",
    "temp",
    "tmp",
}


def _presentation_reminder(tool_id: str, metadata: dict[str, Any] | None) -> str:
    """Return an LLM-only reminder when a tool produced likely deliverables."""
    if not metadata:
        return ""

    files: list[str] = []
    if tool_id in ("write", "edit") and metadata.get("file_path"):
        files.append(str(metadata["file_path"]))
    elif tool_id == "code_execute" and metadata.get("written_files"):
        files.extend(str(path) for path in metadata["written_files"])

    candidates: list[str] = []
    for file_path in files:
        path = Path(file_path)
        suffix = path.suffix.lower()
        name = path.name.lower()
        if suffix not in _PRESENTABLE_DELIVERABLE_EXTS:
            continue
        if any(hint in name for hint in _NON_PRESENTABLE_OUTPUT_HINTS):
            continue
        candidates.append(file_path)

    if not candidates:
        return ""

    joined = ", ".join(candidates[:5])
    return (
        "\n\n<reminder>Potential final deliverable file(s) were created: "
        f"{joined}. If these are final files the user asked for, call present_file "
        "for each user-facing deliverable before your final response. Mention "
        "supporting data files separately unless the user asked to open or share "
        "them. Do not present temporary scripts, scratch files, logs, helper "
        "files, or intermediate outputs.</reminder>"
    )


# Extension mapping for artifact types
_ARTIFACT_TYPE_EXT: dict[str, str] = {
    "markdown": ".md",
    "html": ".html",
    "svg": ".svg",
    "react": ".jsx",
    "mermaid": ".mmd",
    "code": ".txt",  # fallback; overridden by language when available
}

# Language → extension mapping for code artifacts
_LANG_EXT: dict[str, str] = {
    "python": ".py",
    "javascript": ".js",
    "typescript": ".ts",
    "java": ".java",
    "c": ".c",
    "cpp": ".cpp",
    "go": ".go",
    "rust": ".rs",
    "ruby": ".rb",
    "php": ".php",
    "swift": ".swift",
    "kotlin": ".kt",
    "css": ".css",
    "json": ".json",
    "yaml": ".yaml",
    "sql": ".sql",
    "shell": ".sh",
    "bash": ".sh",
}


async def _save_artifact_as_file(
    session_factory: Any,
    session_id: str,
    workspace: str | None,
    metadata: dict[str, Any],
) -> None:
    """Save artifact content to openyak_written/ and track as a session file."""
    import re
    from pathlib import Path

    if not workspace:
        return

    content = metadata.get("content", "")
    title = metadata.get("title", "artifact")
    artifact_type = metadata.get("type", "code")
    language = metadata.get("language", "")

    # Determine file extension
    if artifact_type == "code" and language:
        ext = _LANG_EXT.get(language.lower(), ".txt")
    else:
        ext = _ARTIFACT_TYPE_EXT.get(artifact_type, ".txt")

    # Sanitize title for filename: keep alphanumeric, spaces, hyphens, underscores,
    # and CJK/Unicode letters; replace others with underscore
    safe_title = re.sub(r'[<>:"/\\|?*]', "_", title).strip()
    if not safe_title:
        safe_title = "artifact"
    # Truncate to reasonable length
    if len(safe_title) > 100:
        safe_title = safe_title[:100]

    filename = f"{safe_title}{ext}"
    output_dir = Path(workspace).resolve() / "openyak_written"

    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        file_path = output_dir / filename
        file_path.write_text(content, encoding="utf-8")

        await _track_session_file(
            session_factory,
            session_id=session_id,
            file_path=str(file_path),
            tool_id="artifact",
        )
    except Exception:
        logger.debug("Failed to save artifact as file: %s", filename, exc_info=True)


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
        middleware_ctx: Any | None = None,
    ) -> None:
        self._sp = session_prompt
        self._llm_messages = llm_messages
        self._assistant_msg_id = assistant_msg_id
        self._mw_ctx = middleware_ctx  # MiddlewareContext from prompt.py

        # Step-local results exposed for SessionPrompt to accumulate
        self.usage_data: dict[str, Any] = {}
        self.finish_reason: str = "stop"
        self.step_cost: float = 0.0
        self.has_text: bool = False  # True if this step produced non-empty text

    async def process(self) -> Literal["continue", "stop", "compact"]:
        """Execute one LLM step and return the loop continuation signal.

        Returns:
          "continue" — tool calls were made; loop again so LLM sees results
          "stop"     — no tool calls; model finished this turn
          "compact"  — context overflow detected; run compaction then continue
        """
        self._init_step_state()
        await self._persist_step_start()

        # Phase 1: stream from LLM (with retry); may early-return "stop".
        early = await self._stream_llm_with_retry()
        if early is not None:
            return early

        # Phase 2: non-retryable / retries-exhausted stream error → "compact" or "stop".
        if self._stream_error is not None:
            return await self._handle_stream_error()

        # Phase 3: empty output after retries → continue the loop.
        if await self._handle_empty_output_after_retries():
            return "continue"

        # Phase 4: persist text + reasoning parts.
        await self._persist_text_and_reasoning()

        # Phase 5: dispatch concurrent tool calls.
        early = await self._dispatch_tool_calls()
        if early is not None:
            return early

        # Phase 6: cost tracking.
        self._compute_step_cost()

        # If this step produced tool calls, the agent loop is not actually
        # finished yet, even if the provider reported a generic "stop".
        # Surface that as "tool_use" so the frontend keeps streaming UI alive
        # until the follow-up step completes.
        if self._has_tool_calls and self.finish_reason != "tool_use":
            self.finish_reason = "tool_use"

        # Phase 7: step finish (SSE + DB step-finish part).
        await self._persist_step_finish()

        # Phase 8: reactive compaction on usage-based overflow.
        if self._check_context_overflow():
            return "compact"

        # Phase 9: middleware on_step_complete.
        if self._mw_ctx is not None:
            await self._sp.middleware_chain.run_on_step_complete(self._mw_ctx)

        # Phase 10: determine continuation.
        if not self._has_tool_calls:
            return "stop"
        return "continue"

    # ------------------------------------------------------------------
    # process() phases — initialization
    # ------------------------------------------------------------------

    def _init_step_state(self) -> None:
        """Initialize per-step accumulator state shared across phases."""
        from app.session.tool_executor import StreamingToolExecutor

        self._accumulated_text: str = ""
        self._accumulated_reasoning: str = ""
        self._tool_calls_in_step: list[dict[str, Any]] = []
        self._has_tool_calls: bool = False
        self._native_search_ids: set[str] = set()
        self._native_search_count: int = 0
        self._ws_part_ids: dict[str, str] = {}  # web_search call_id → part_id
        self._stream_error: Exception | None = None

        # Streaming tool executor: starts concurrent-safe tools during streaming
        self._streaming_executor = StreamingToolExecutor(self._sp.job.abort_event)
        self._exec_metadata: dict[int, dict[str, Any]] = {}
        self._exec_index: int = 0
        self._exec_blocked: bool = False  # Set True if loop detection blocks

    async def _persist_step_start(self) -> None:
        """Persist the StepStart part (mirrors OpenCode's StepStartPart)."""
        sp = self._sp
        async with sp.session_factory() as db:
            async with db.begin():
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=sp.job.session_id,
                    data={"type": "step-start", "step": sp.step},
                )

    # ------------------------------------------------------------------
    # process() phases — LLM streaming with retry
    # ------------------------------------------------------------------

    async def _stream_llm_with_retry(self) -> Literal["stop"] | None:
        """Stream from the LLM with retry. Mutates self._accumulated_*, self._stream_error.

        Returns "stop" early only for fatal in-stream conditions (non-vision model
        received images, or the stream chunk reported an explicit error).
        """
        sp = self._sp
        job = sp.job

        for attempt in range(MAX_RETRIES + 1):
            if job.abort_event.is_set():
                break

            try:
                reasoning_extra, safe_max_tokens, exclude_tools = await self._build_stream_args()

                logger.info(
                    "Starting LLM stream for model=%s, messages=%d, max_tokens=%d",
                    sp.model_id,
                    len(self._llm_messages),
                    safe_max_tokens,
                )

                # Notify frontend that the model may need loading (Ollama cold start)
                if sp.provider.id == "ollama":
                    job.publish(SSEEvent(MODEL_LOADING, {"model": sp.model_id, "status": "loading"}))

                blocked = await self._check_vision_blocked()
                if blocked is not None:
                    return blocked

                async for chunk in stream_llm(
                    sp.provider,
                    sp.model_id,
                    self._llm_messages,
                    system_prompt=sp.system_prompt,
                    agent=sp.agent,
                    tool_registry=sp.tool_registry,
                    extra_body=reasoning_extra,
                    max_tokens=safe_max_tokens,
                    exclude_tools=exclude_tools,
                    discovered_tools=sp.discovered_tools,
                    response_format=sp.request.format,
                ):
                    if job.abort_event.is_set():
                        break

                    logger.debug("LLM chunk: type=%s", chunk.type)
                    match chunk.type:
                        case "text-delta":
                            text = chunk.data.get("text", "")
                            self._accumulated_text += text
                            job.publish(SSEEvent(TEXT_DELTA, {
                                "session_id": job.session_id,
                                "message_id": self._assistant_msg_id,
                                "text": text,
                            }))

                        case "reasoning-delta":
                            text = chunk.data.get("text", "")
                            self._accumulated_reasoning += text
                            job.publish(SSEEvent(REASONING_DELTA, {"text": text}))

                        case "tool-call":
                            self._has_tool_calls = True
                            self._tool_calls_in_step.append(chunk.data)
                            if not self._exec_blocked:
                                await self._handle_tool_call_chunk(chunk)

                        case "web-search-start":
                            await self._handle_web_search_start_chunk(chunk)

                        case "web-search-result":
                            await self._handle_web_search_result_chunk(chunk)

                        case "usage":
                            self.usage_data = chunk.data

                        case "finish":
                            self.finish_reason = _normalize_step_finish_reason(
                                chunk.data.get("reason", "stop")
                            )

                        case "error":
                            return await self._handle_stream_error_chunk(chunk)

                self._stream_error = None
                logger.info(
                    "LLM stream completed: text=%d chars, reasoning=%d chars, "
                    "tool_calls=%d, finish=%s",
                    len(self._accumulated_text),
                    len(self._accumulated_reasoning),
                    len(self._tool_calls_in_step),
                    self.finish_reason,
                )

                # --- Empty response guard: retry if LLM produced nothing ---
                if (
                    not self._accumulated_text.strip()
                    and not self._has_tool_calls
                    and not self._accumulated_reasoning
                    and not job.abort_event.is_set()
                    and attempt < 2
                ):
                    logger.warning(
                        "Empty LLM response (attempt %d/%d), retrying",
                        attempt + 1,
                        MAX_RETRIES + 1,
                    )
                    self._reset_stream_accumulators()
                    continue

                break

            except Exception as e:
                self._stream_error = e
                retry_reason = is_retryable(e)
                effective_max = max_retries_for_error(e)

                if retry_reason and attempt < effective_max:
                    delay = retry_delay(attempt, e)
                    logger.warning(
                        "LLM stream error (attempt %d/%d, %s), retrying in %.1fs: %s",
                        attempt + 1,
                        effective_max,
                        retry_reason,
                        delay,
                        e,
                    )
                    job.publish(SSEEvent(RETRY, {
                        "attempt": attempt + 1,
                        "max_retries": MAX_RETRIES,
                        "delay": delay,
                        "reason": retry_reason,
                        "message": str(e),
                    }))
                    self._reset_stream_accumulators()
                    aborted = await sleep_with_abort(delay, job.abort_event)
                    if aborted:
                        break
                    continue
                else:
                    break

        return None

    async def _build_stream_args(self) -> tuple[Any, int, set[str] | None]:
        """Compute (reasoning_extra, safe_max_tokens, exclude_tools) for one stream attempt."""
        sp = self._sp

        reasoning_extra = None
        if sp.request.reasoning is False:
            reasoning_extra = {"reasoning": {"enabled": False}}

        safe_max_tokens = _compute_safe_max_tokens(
            self._llm_messages,
            model_max_context=(
                _get_effective_context_window(sp.model_info) if sp.model_info else 8192
            ),
            model_max_output=(
                sp.model_info.capabilities.max_output if sp.model_info else None
            ),
        )

        exclude_tools: set[str] | None = None
        sq_count, sq_credits = await _search_quota.get_quota()
        if not sq_credits and sq_count >= get_settings().daily_search_limit:
            exclude_tools = {"web_search"}

        # Use native web search for OpenAI subscription provider
        if sp.provider.id == "openai-subscription":
            exclude_tools = exclude_tools or set()
            exclude_tools.add("web_search")

        return reasoning_extra, safe_max_tokens, exclude_tools

    async def _check_vision_blocked(self) -> Literal["stop"] | None:
        """If a non-vision model received image content, persist an error + return 'stop'."""
        sp = self._sp
        job = sp.job

        if not (
            sp.model_info
            and not sp.model_info.capabilities.vision
            and _llm_messages_have_image_content(self._llm_messages)
        ):
            return None

        message = (
            "The selected model does not support images. "
            "Choose a vision model and try again."
        )
        logger.info(
            "Blocked image content for non-vision model=%s session=%s",
            sp.model_id,
            job.session_id,
        )
        job.publish(SSEEvent(
            AGENT_ERROR,
            {
                "error_type": "MODEL_DOES_NOT_SUPPORT_IMAGES",
                "error_message": message,
            },
        ))
        async with sp.session_factory() as db:
            async with db.begin():
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=job.session_id,
                    data={"type": "text", "text": message},
                )
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=job.session_id,
                    data={
                        "type": "step-finish",
                        "reason": "error",
                        "tokens": {},
                        "cost": 0.0,
                    },
                )
        self.finish_reason = "error"
        return "stop"

    def _reset_stream_accumulators(self) -> None:
        """Reset per-attempt accumulators between retries (mirrors original local reset)."""
        self._accumulated_text = ""
        self._accumulated_reasoning = ""
        self._tool_calls_in_step = []
        self._has_tool_calls = False

    # ------------------------------------------------------------------
    # process() phases — chunk handlers
    # ------------------------------------------------------------------

    async def _handle_tool_call_chunk(self, chunk: Any) -> None:
        """Submit one streamed tool call to the executor (with loop/permission checks)."""
        from app.session.tool_executor import ToolCallInfo

        sp = self._sp
        job = sp.job
        session_factory = sp.session_factory

        tc = chunk.data
        tn = tc.get("name", "")
        ta = tc.get("arguments", {})
        ci = tc.get("id", generate_ulid())
        tn, ta = _repair_tool_call_payload(tn, ta)

        # Loop detection
        lr: LoopCheckResult = loop_detector.check(job.session_id, tn, ta)
        if lr.action == "block":
            job.publish(SSEEvent(AGENT_ERROR, {
                "error_type": "loop_detected",
                "error_message": lr.message,
                "tool": tn,
            }))
            await _persist_tool_error(
                session_factory, self._assistant_msg_id,
                job.session_id, tn, ci, ta,
                lr.message or "Loop detected — hard stop",
            )
            self._exec_blocked = True
            return

        # Resolve tool
        tool = sp.tool_registry.get(tn)
        if tool is None:
            tool = sp.tool_registry.get(tn.lower())
        if tool is None:
            tool = sp.tool_registry.get("invalid")
            if tool:
                ta = {"name": tn}
        if tool is None:
            job.publish(SSEEvent(TOOL_ERROR, {"call_id": ci, "error": f"Tool not found: {tn}"}))
            return

        # Permission check
        rp = "*"
        if tool.id in _FILE_TOOLS:
            rp = ta.get("file_path", "*")
        action = evaluate(tool.id, rp, sp.merged_permissions)

        if action == "deny":
            job.publish(SSEEvent(TOOL_ERROR, {"call_id": ci, "error": f"Permission denied for tool: {tool.id}"}))
            await _persist_tool_error(
                session_factory, self._assistant_msg_id,
                job.session_id, tool.id, ci, ta, "Permission denied",
            )
            return

        if action == "ask" and job.interactive:
            decision = await _ask_permission(
                job,
                call_id=ci,
                tool_name=tool.id,
                tool_args=ta,
                resource_pattern=rp,
            )
            if decision.get("remember"):
                await _remember_permission_rule(
                    session_factory,
                    job.session_id,
                    sp,
                    permission=tool.id,
                    pattern=rp,
                    allow=bool(decision.get("allowed")),
                )
            if not decision.get("allowed"):
                job.publish(SSEEvent(TOOL_ERROR, {"call_id": ci, "error": f"User denied permission for: {tool.id}"}))
                await _persist_tool_error(
                    session_factory, self._assistant_msg_id,
                    job.session_id, tool.id, ci, ta, "Permission denied by user",
                )
                return

        # Persist "running" state
        tool_part_id = generate_ulid()
        async with session_factory() as db:
            async with db.begin():
                await create_part(
                    db, message_id=self._assistant_msg_id,
                    session_id=job.session_id, part_id=tool_part_id,
                    data={"type": "tool", "tool": tool.id, "call_id": ci,
                          "state": {"status": "running", "input": ta}},
                )
        job.publish(SSEEvent(TOOL_START, {
            "tool": tool.id, "call_id": ci,
            "arguments": ta, "session_id": job.session_id,
        }))

        # Build context
        ctx = ToolContext(
            session_id=job.session_id,
            message_id=self._assistant_msg_id,
            agent=sp.agent, call_id=ci,
            abort_event=job.abort_event,
            workspace=sp.workspace,
            index_manager=getattr(sp, "index_manager", None),
            messages=self._llm_messages,
            discovered_tools=sp.discovered_tools,
            _publish_fn=lambda et, d: job.publish(SSEEvent(et, d)),
        )
        ctx._app_state = {  # type: ignore[attr-defined]
            "session_factory": session_factory,
            "provider_registry": sp.provider_registry,
            "agent_registry": sp.agent_registry,
            "tool_registry": sp.tool_registry,
        }
        ctx._model_id = sp.model_id  # type: ignore[attr-defined]
        ctx._job = job  # type: ignore[attr-defined]
        ctx._depth = job._depth  # type: ignore[attr-defined]

        # Submit to streaming executor (concurrent tools start NOW)
        self._streaming_executor.submit(ToolCallInfo(
            index=self._exec_index, tool=tool,
            tool_name=tool.id, tool_args=ta,
            call_id=ci, ctx=ctx,
            timeout=_cfg().tool_timeout,
        ))
        self._exec_metadata[self._exec_index] = {
            "tool_part_id": tool_part_id,
            "loop_result": lr,
            "tool": tool,
            "tool_args": ta,
            "call_id": ci,
        }
        self._exec_index += 1

    async def _handle_web_search_start_chunk(self, chunk: Any) -> None:
        """Persist a 'running' tool part for an OpenAI-native web search start."""
        sp = self._sp
        job = sp.job

        ws_call_id = chunk.data.get("id", "")
        ws_query = chunk.data.get("query", "")
        self._native_search_ids.add(ws_call_id)
        self._native_search_count += 1

        # Drop excess searches beyond the per-step cap
        if self._native_search_count > get_settings().max_native_searches_per_step:
            return

        self._ws_part_ids[ws_call_id] = generate_ulid()
        async with sp.session_factory() as db:
            async with db.begin():
                await create_part(
                    db,
                    message_id=self._assistant_msg_id,
                    session_id=job.session_id,
                    part_id=self._ws_part_ids[ws_call_id],
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

    async def _handle_web_search_result_chunk(self, chunk: Any) -> None:
        """Format & persist completion of an OpenAI-native web search."""
        sp = self._sp
        job = sp.job

        ws_call_id = chunk.data.get("id", "")
        ws_query = chunk.data.get("query", "")
        ws_results = chunk.data.get("results", [])

        # Skip results for searches that exceeded the per-step cap
        if ws_call_id not in self._ws_part_ids:
            return

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
        ws_part_id = self._ws_part_ids.pop(ws_call_id, None)
        if ws_part_id:
            async with sp.session_factory() as db:
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

    async def _handle_stream_error_chunk(self, chunk: Any) -> Literal["stop"]:
        """Mid-stream 'error' chunk: persist any accumulated text + publish error + clean up."""
        sp = self._sp
        job = sp.job

        if self._accumulated_text:
            async with sp.session_factory() as db:
                async with db.begin():
                    await create_part(
                        db,
                        message_id=self._assistant_msg_id,
                        session_id=job.session_id,
                        data={"type": "text", "text": self._accumulated_text},
                    )
        job.publish(SSEEvent(
            AGENT_ERROR,
            {"error_message": chunk.data.get("message", "LLM error")},
        ))
        await _delete_empty_assistant_messages(sp.session_factory, job.session_id)
        return "stop"

    # ------------------------------------------------------------------
    # process() phases — post-stream
    # ------------------------------------------------------------------

    async def _handle_stream_error(self) -> Literal["compact", "stop"]:
        """Handle a retries-exhausted or non-retryable stream exception."""
        sp = self._sp
        job = sp.job

        # --- Reactive compact: recover from context overflow via compaction ---
        # Inspired by Claude Code's reactive compact pattern.
        if is_context_overflow(self._stream_error):
            logger.info(
                "Context overflow detected, triggering reactive compaction for session %s",
                job.session_id,
            )
            await _delete_empty_assistant_messages(sp.session_factory, job.session_id)
            return "compact"

        logger.exception("LLM stream error (not retryable or retries exhausted)")
        self.has_text = bool(self._accumulated_text.strip())
        self.finish_reason = "error"
        if self._accumulated_text or self._accumulated_reasoning:
            async with sp.session_factory() as db:
                async with db.begin():
                    if self._accumulated_text:
                        await create_part(
                            db,
                            message_id=self._assistant_msg_id,
                            session_id=job.session_id,
                            data={"type": "text", "text": self._accumulated_text},
                        )
                    if self._accumulated_reasoning:
                        await create_part(
                            db,
                            message_id=self._assistant_msg_id,
                            session_id=job.session_id,
                            data={"type": "reasoning", "text": self._accumulated_reasoning},
                        )
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
            job.publish(SSEEvent(
                STEP_FINISH,
                {
                    "tokens": self.usage_data,
                    "cost": self.step_cost,
                    "total_cost": sp.total_cost + self.step_cost,
                    "reason": self.finish_reason,
                },
            ))
        await _delete_empty_assistant_messages(sp.session_factory, job.session_id)
        job.publish(SSEEvent(
            AGENT_ERROR,
            {"error_message": f"LLM stream error: {self._stream_error}"},
        ))
        return "stop"

    async def _handle_empty_output_after_retries(self) -> bool:
        """Return True if the step produced nothing after retries (caller continues the loop).

        The model produced nothing (no text, no tools, no reasoning) even after retries.
        Rather than surfacing an error, delete the empty assistant message shell and let
        the outer loop re-invoke the LLM with the full conversation context intact.
        The hard step cap (50) prevents infinite looping.
        """
        sp = self._sp
        job = sp.job

        if not (
            not self._accumulated_text.strip()
            and not self._has_tool_calls
            and not self._accumulated_reasoning
            and self._stream_error is None
            and not job.abort_event.is_set()
        ):
            return False

        logger.warning(
            "LLM produced no output after retries for session %s, continuing loop",
            job.session_id,
        )
        # Publish a paired non-terminal STEP_FINISH so the frontend step tracker
        # stays consistent without seeing an undeclared terminal reason.
        job.publish(SSEEvent(
            STEP_FINISH,
            {
                "tokens": None,
                "cost": 0.0,
                "total_cost": sp.total_cost,
                "reason": "tool_use",
            },
        ))
        await _delete_empty_assistant_messages(sp.session_factory, job.session_id)
        return True

    async def _persist_text_and_reasoning(self) -> None:
        """Persist accumulated text + reasoning as parts on the assistant message."""
        sp = self._sp
        self.has_text = bool(self._accumulated_text.strip())
        async with sp.session_factory() as db:
            async with db.begin():
                if self._accumulated_text.strip():
                    await create_part(
                        db,
                        message_id=self._assistant_msg_id,
                        session_id=sp.job.session_id,
                        data={"type": "text", "text": self._accumulated_text},
                    )
                if self._accumulated_reasoning:
                    await create_part(
                        db,
                        message_id=self._assistant_msg_id,
                        session_id=sp.job.session_id,
                        data={"type": "reasoning", "text": self._accumulated_reasoning},
                    )

    # ------------------------------------------------------------------
    # process() phases — tool dispatch
    # ------------------------------------------------------------------

    async def _dispatch_tool_calls(self) -> Literal["stop"] | None:
        """Collect concurrent tool results, finalize each. Returns 'stop' if loop-blocked."""
        # Filter out native web search calls (already persisted during streaming)
        if self._native_search_ids:
            self._tool_calls_in_step = [
                tc for tc in self._tool_calls_in_step
                if tc.get("id") not in self._native_search_ids
            ]
            if not self._tool_calls_in_step:
                self._has_tool_calls = False

        if not (self._has_tool_calls and self._streaming_executor.has_submissions):
            return None

        if self._exec_blocked:
            return "stop"

        # === Collect results — concurrent tools already running, exclusive run now ===
        exec_results = await self._streaming_executor.collect()

        # === Finalize — persist results, emit SSE, handle side effects ===
        if exec_results:
            for exec_result in exec_results:
                meta = self._exec_metadata.get(exec_result.index)
                if meta is None:
                    continue
                await self._finalize_one_tool_result(meta, exec_result)

        return None

    async def _finalize_one_tool_result(
        self, meta: dict[str, Any], exec_result: Any,
    ) -> None:
        """Persist one tool result: timeouts/errors, SSE, side effects, agent switching."""
        sp = self._sp
        job = sp.job
        session_factory = sp.session_factory

        tool_part_id = meta["tool_part_id"]
        loop_result = meta["loop_result"]
        tool = meta["tool"]
        tool_args = meta["tool_args"]
        call_id = meta["call_id"]

        # Handle timeout
        if exec_result.timed_out:
            timeout_msg = f"Tool timed out after {_cfg().tool_timeout}s: {tool.id}"
            logger.warning(timeout_msg)
            job.publish(SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": timeout_msg}))
            await _update_tool_part_error(
                session_factory, tool_part_id, tool.id, call_id, tool_args, timeout_msg,
            )
            return

        # Handle execution error
        if exec_result.error is not None:
            if isinstance(exec_result.error, RejectedError):
                err_msg = f"Permission denied: {exec_result.error.permission}"
            else:
                err_msg = str(exec_result.error)
                logger.exception("Tool execution error: %s", tool.id)
            job.publish(SSEEvent(TOOL_ERROR, {"call_id": call_id, "error": err_msg}))
            await _update_tool_part_error(
                session_factory, tool_part_id, tool.id, call_id, tool_args, err_msg,
            )
            return

        result = exec_result.result
        if result is None:
            return

        # Emit SSE result
        if result.error:
            job.publish(SSEEvent(
                TOOL_ERROR,
                {"call_id": call_id, "error": result.error, "tool": tool.id},
            ))
        else:
            job.publish(SSEEvent(
                TOOL_RESULT,
                {
                    "call_id": call_id,
                    "tool": tool.id,
                    "output": result.output[:500] if result.output else "",
                    "title": result.title,
                    "metadata": result.metadata,
                },
            ))

        await self._apply_tool_side_effects(tool, result)
        persist_output = await self._build_tool_persist_output(
            tool, tool_args, result, loop_result,
        )

        # Update tool part to "completed" / "error"
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

        self._maybe_switch_agent(result)

    async def _apply_tool_side_effects(self, tool: Any, result: Any) -> None:
        """Update session files / artifact files / todos / web_search quota from a tool result."""
        sp = self._sp
        job = sp.job
        session_factory = sp.session_factory

        # Web search usage tracking
        if tool.id == "web_search" and result.success:
            charged = bool(result.metadata and result.metadata.get("charged"))
            await _search_quota.increment(charged=charged)

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

        # Track files created or modified inside code_execute runs.
        if (
            tool.id == "code_execute"
            and result.success
            and result.metadata
            and result.metadata.get("written_files")
        ):
            for file_path in result.metadata["written_files"]:
                await _track_session_file(
                    session_factory,
                    session_id=job.session_id,
                    file_path=file_path,
                    tool_id=tool.id,
                )

        # Track artifacts as workspace files (save to disk)
        if (
            tool.id == "artifact"
            and result.success
            and result.metadata
            and result.metadata.get("content")
        ):
            await _save_artifact_as_file(
                session_factory,
                session_id=job.session_id,
                workspace=sp.workspace,
                metadata=result.metadata,
            )

        # Track todos from todo tool results
        if tool.id == "todo" and result.metadata and "todos" in result.metadata:
            sp.current_todos = list(result.metadata["todos"])

    async def _build_tool_persist_output(
        self,
        tool: Any,
        tool_args: dict[str, Any],
        result: Any,
        loop_result: Any,
    ) -> str:
        """Assemble the output text persisted to the tool part (+ reminders, middleware)."""
        sp = self._sp

        persist_output = result.output or result.error or ""
        if result.success:
            persist_output += _presentation_reminder(tool.id, result.metadata)

        # Inject loop warning into output so LLM sees it
        if loop_result.action == "warn" and loop_result.message:
            persist_output += f"\n\n{loop_result.message}"

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

        # Run middleware after_tool_exec hooks
        if self._mw_ctx is not None:
            persist_output = await sp.middleware_chain.run_after_tool_exec(
                tool.id, tool_args, persist_output, self._mw_ctx,
            )

        return persist_output

    def _maybe_switch_agent(self, result: Any) -> None:
        """Apply agent switching if the tool result requested it (plan tool enter/exit)."""
        sp = self._sp
        if not (result.metadata and result.metadata.get("switch_agent")):
            return

        new_agent_name = result.metadata["switch_agent"]
        new_agent = sp.agent_registry.get(new_agent_name)
        if not new_agent:
            return

        sp.agent = new_agent
        if sp.agent.model:
            new_resolved = sp.provider_registry.resolve_model(sp.agent.model.model_id)
            if new_resolved:
                sp.provider, sp.model_info = new_resolved
                sp.model_id = sp.agent.model.model_id
        sp.rebuild_permissions_and_prompt()
        logger.info("Agent switched to: %s", sp.agent.name)

    # ------------------------------------------------------------------
    # process() phases — cost / finish / overflow
    # ------------------------------------------------------------------

    def _compute_step_cost(self) -> None:
        """Compute self.step_cost from self.usage_data + model pricing; log usage."""
        sp = self._sp
        if self.usage_data and sp.model_info:
            if sp.model_info.pricing and (
                sp.model_info.pricing.prompt > 0 or sp.model_info.pricing.completion > 0
            ):
                self.step_cost = _calculate_step_cost(self.usage_data, sp.model_info)
            elif sp.model_info.provider_id == "openai-subscription":
                self.step_cost = 0.0
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

    async def _persist_step_finish(self) -> None:
        """Emit STEP_FINISH SSE event + persist the step-finish part."""
        sp = self._sp
        job = sp.job

        job.publish(SSEEvent(
            STEP_FINISH,
            {
                "tokens": self.usage_data,
                "cost": self.step_cost,
                "total_cost": sp.total_cost + self.step_cost,
                "reason": self.finish_reason,
            },
        ))
        async with sp.session_factory() as db:
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

    def _check_context_overflow(self) -> bool:
        """Return True if usage_data exceeds the safe compaction threshold."""
        sp = self._sp
        if not (self.usage_data and sp.model_info):
            return False

        from app.session.compaction import should_compact

        max_ctx = (
            _get_effective_context_window(sp.model_info)
            or sp.model_info.capabilities.max_context
        )
        max_out = sp.model_info.capabilities.max_output
        if should_compact(self.usage_data, max_ctx, model_max_output=max_out):
            logger.info("Context overflow detected, running compaction")
            return True
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _ask_permission(
    job: GenerationJob,
    call_id: str,
    tool_name: str,
    tool_args: dict[str, Any],
    resource_pattern: str = "*",
) -> dict[str, bool]:
    """Ask user for permission via SSE and wait for response."""
    permission_call_id = generate_ulid()
    arguments, truncated = _permission_arguments_for_event(tool_args)
    message = _permission_message(tool_name, arguments, truncated)
    job.publish(
        SSEEvent(
            PERMISSION_REQUEST,
            {
                "call_id": permission_call_id,
                "tool_call_id": call_id,
                "tool": tool_name,
                "permission": tool_name,
                "patterns": [resource_pattern] if resource_pattern else [],
                "arguments": arguments,
                "message": message,
                "arguments_truncated": truncated,
            },
        )
    )

    try:
        response = await job.wait_for_response(permission_call_id, timeout=300.0)
        return _permission_decision_from_response(response)
    except TimeoutError:
        logger.warning("Permission request timed out for %s", tool_name)
        return {"allowed": False, "remember": False}


def _permission_decision_from_response(response: Any) -> dict[str, bool]:
    if isinstance(response, dict):
        return {
            "allowed": bool(response.get("allowed")),
            "remember": bool(response.get("remember")),
        }
    allowed = str(response).lower() in ("allow", "yes", "true", "1")
    return {"allowed": allowed, "remember": False}


async def _remember_permission_rule(
    _session_factory: async_sessionmaker[AsyncSession],
    session_id: str,
    sp: SessionPrompt,
    *,
    permission: str,
    pattern: str,
    allow: bool,
) -> None:
    del _session_factory, session_id
    action: Literal["allow", "deny"] = "allow" if allow else "deny"
    rule = PermissionRule(action=action, permission=permission, pattern=pattern or "*")

    sp.session_permissions.rules = [
        existing
        for existing in sp.session_permissions.rules
        if not (existing.permission == rule.permission and existing.pattern == rule.pattern)
    ]
    sp.session_permissions.rules.append(rule)
    sp.merged_permissions.rules.append(rule)


def _permission_arguments_for_event(
    value: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Return permission arguments suitable for SSE display.

    The permission prompt must show the action being approved, but it should not
    turn one huge file write into an unbounded SSE event. Key names that are
    obviously secret-like are redacted; long string values are truncated with a
    clear marker so the UI can still show the relevant target and command.
    """
    sanitized = _sanitize_permission_value(value)
    encoded = json.dumps(sanitized, default=str, ensure_ascii=False)
    if len(encoded) <= _PERMISSION_ARGUMENT_CHAR_LIMIT:
        return cast(dict[str, Any], sanitized), False

    clipped = _clip_permission_value(sanitized)
    return cast(dict[str, Any], clipped), True


def _sanitize_permission_value(value: Any, key: str | None = None) -> Any:
    if key and _SENSITIVE_ARG_KEY_RE.search(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {
            str(k): _sanitize_permission_value(v, str(k))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_permission_value(item) for item in value]
    if isinstance(value, tuple):
        return [_sanitize_permission_value(item) for item in value]
    return value


def _clip_permission_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _clip_permission_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clip_permission_value(item) for item in value[:50]]
    if isinstance(value, str) and len(value) > 12_000:
        return value[:12_000] + "\n\n[permission preview truncated]"
    return value


def _permission_message(
    tool_name: str,
    arguments: dict[str, Any],
    truncated: bool,
) -> str:
    if tool_name == "bash":
        command = arguments.get("command")
        if isinstance(command, str) and command.strip():
            return f"Allow running this shell command?\n\n{command}"
        return "Allow running a shell command?"

    if tool_name in {"write", "edit", "read"}:
        file_path = arguments.get("file_path")
        if isinstance(file_path, str) and file_path.strip():
            suffix = " The preview was truncated." if truncated else ""
            return f"Allow {tool_name} on {file_path}?{suffix}"

    suffix = " Preview was truncated." if truncated else ""
    return f"Allow tool '{tool_name}' with the shown arguments?{suffix}"


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


async def _update_tool_part_error(
    session_factory: async_sessionmaker[AsyncSession],
    part_id: str,
    tool_name: str,
    call_id: str,
    tool_args: dict[str, Any],
    error_msg: str,
) -> None:
    """Update an existing tool part to error state. Logs warning on failure."""
    try:
        async with session_factory() as db:
            async with db.begin():
                await update_part_data(
                    db,
                    part_id,
                    {
                        "type": "tool",
                        "tool": tool_name,
                        "call_id": call_id,
                        "state": {"status": "error", "input": tool_args, "output": error_msg},
                    },
                )
    except Exception:
        logger.warning("Failed to persist error state for tool %s", tool_name)
