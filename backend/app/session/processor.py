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
    is_auth_error,
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
    repair_tool_call_payload as _repair_tool_call_payload,
    strip_image_content as _strip_image_content,
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


# --- Daily web_search quota tracking (single-user desktop app) ---

class SearchQuotaTracker:
    """Tracks daily web_search usage with automatic UTC-day reset.

    Encapsulates mutable quota state behind a lock for thread safety.
    """

    def __init__(self) -> None:
        self._date: str = ""
        self._count: int = 0
        self._credits_mode: bool = False  # Sticky: True once proxy confirms Credits billing
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
        native_search_count: int = 0  # counts native web searches in this step
        _ws_part_ids: dict[str, str] = {}  # web_search call_id → part_id
        stream_error: Exception | None = None

        # Streaming tool executor: starts concurrent-safe tools during streaming
        from app.session.tool_executor import StreamingToolExecutor, ToolCallInfo
        streaming_executor = StreamingToolExecutor(job.abort_event)
        # Maps submission index → metadata for post-processing
        _exec_metadata: dict[int, dict[str, Any]] = {}
        _exec_index = 0
        _exec_blocked = False  # Set True if loop detection blocks

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
                        _get_effective_context_window(sp.model_info) if sp.model_info else 8192
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
                _sq_count, _sq_credits = await _search_quota.get_quota()
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
                    discovered_tools=sp.discovered_tools,
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

                            # --- Streaming tool execution: prepare & submit immediately ---
                            if not _exec_blocked:
                                _tc = chunk.data
                                _tn = _tc.get("name", "")
                                _ta = _tc.get("arguments", {})
                                _ci = _tc.get("id", generate_ulid())
                                _tn, _ta = _repair_tool_call_payload(_tn, _ta)

                                # Loop detection
                                _lr: LoopCheckResult = loop_detector.check(job.session_id, _tn, _ta)
                                if _lr.action == "block":
                                    job.publish(SSEEvent(AGENT_ERROR, {
                                        "error_type": "loop_detected",
                                        "error_message": _lr.message,
                                        "tool": _tn,
                                    }))
                                    await _persist_tool_error(
                                        session_factory, self._assistant_msg_id,
                                        job.session_id, _tn, _ci, _ta,
                                        _lr.message or "Loop detected — hard stop",
                                    )
                                    _exec_blocked = True
                                    continue

                                # Resolve tool
                                _tool = sp.tool_registry.get(_tn)
                                if _tool is None:
                                    _tool = sp.tool_registry.get(_tn.lower())
                                if _tool is None:
                                    _tool = sp.tool_registry.get("invalid")
                                    if _tool:
                                        _ta = {"name": _tn}
                                if _tool is None:
                                    job.publish(SSEEvent(TOOL_ERROR, {"call_id": _ci, "error": f"Tool not found: {_tn}"}))
                                    continue

                                # Permission check
                                _rp = "*"
                                if _tool.id in _FILE_TOOLS:
                                    _rp = _ta.get("file_path", "*")
                                _action = evaluate(_tool.id, _rp, sp.merged_permissions)

                                if _action == "deny":
                                    job.publish(SSEEvent(TOOL_ERROR, {"call_id": _ci, "error": f"Permission denied for tool: {_tool.id}"}))
                                    await _persist_tool_error(
                                        session_factory, self._assistant_msg_id,
                                        job.session_id, _tool.id, _ci, _ta, "Permission denied",
                                    )
                                    continue

                                if _action == "ask":
                                    if job.interactive:
                                        _decision = await _ask_permission(
                                            job,
                                            call_id=_ci,
                                            tool_name=_tool.id,
                                            tool_args=_ta,
                                            resource_pattern=_rp,
                                        )
                                        if _decision.get("remember"):
                                            await _remember_permission_rule(
                                                session_factory,
                                                job.session_id,
                                                sp,
                                                permission=_tool.id,
                                                pattern=_rp,
                                                allow=bool(_decision.get("allowed")),
                                            )
                                        if not _decision.get("allowed"):
                                            job.publish(SSEEvent(TOOL_ERROR, {"call_id": _ci, "error": f"User denied permission for: {_tool.id}"}))
                                            await _persist_tool_error(
                                                session_factory, self._assistant_msg_id,
                                                job.session_id, _tool.id, _ci, _ta, "Permission denied by user",
                                            )
                                            continue

                                # Persist "running" state
                                _tpid = generate_ulid()
                                async with session_factory() as db:
                                    async with db.begin():
                                        await create_part(
                                            db, message_id=self._assistant_msg_id,
                                            session_id=job.session_id, part_id=_tpid,
                                            data={"type": "tool", "tool": _tool.id, "call_id": _ci,
                                                  "state": {"status": "running", "input": _ta}},
                                        )
                                job.publish(SSEEvent(TOOL_START, {
                                    "tool": _tool.id, "call_id": _ci,
                                    "arguments": _ta, "session_id": job.session_id,
                                }))

                                # Build context
                                _ctx = ToolContext(
                                    session_id=job.session_id,
                                    message_id=self._assistant_msg_id,
                                    agent=sp.agent, call_id=_ci,
                                    abort_event=job.abort_event,
                                    workspace=sp.workspace,
                                    index_manager=getattr(sp, "index_manager", None),
                                    messages=self._llm_messages,
                                    discovered_tools=sp.discovered_tools,
                                    _publish_fn=lambda et, d: job.publish(SSEEvent(et, d)),
                                )
                                _ctx._app_state = {  # type: ignore[attr-defined]
                                    "session_factory": session_factory,
                                    "provider_registry": sp.provider_registry,
                                    "agent_registry": sp.agent_registry,
                                    "tool_registry": sp.tool_registry,
                                }
                                _ctx._model_id = sp.model_id  # type: ignore[attr-defined]
                                _ctx._job = job  # type: ignore[attr-defined]
                                _ctx._depth = job._depth  # type: ignore[attr-defined]

                                # Submit to streaming executor (concurrent tools start NOW)
                                streaming_executor.submit(ToolCallInfo(
                                    index=_exec_index, tool=_tool,
                                    tool_name=_tool.id, tool_args=_ta,
                                    call_id=_ci, ctx=_ctx,
                                    timeout=_cfg().tool_timeout,
                                ))
                                _exec_metadata[_exec_index] = {
                                    "tool_part_id": _tpid,
                                    "loop_result": _lr,
                                    "tool": _tool,
                                    "tool_args": _ta,
                                    "call_id": _ci,
                                }
                                _exec_index += 1

                        case "web-search-start":
                            # Native web search started (OpenAI subscription)
                            ws_call_id = chunk.data.get("id", "")
                            ws_query = chunk.data.get("query", "")
                            native_search_ids.add(ws_call_id)
                            native_search_count += 1

                            # Drop excess searches beyond the per-step cap
                            if native_search_count > get_settings().max_native_searches_per_step:
                                continue

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

                            # Skip results for searches that exceeded the per-step cap
                            if ws_call_id not in _ws_part_ids:
                                continue

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
                            self.finish_reason = _normalize_step_finish_reason(
                                chunk.data.get("reason", "stop")
                            )

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

                _effective_max = max_retries_for_error(e)
                if retry_reason and attempt < _effective_max:
                    delay = retry_delay(attempt, e)
                    logger.warning(
                        "LLM stream error (attempt %d/%d, %s), retrying in %.1fs: %s",
                        attempt + 1,
                        _effective_max,
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
            # --- Reactive compact: recover from context overflow via compaction ---
            # Inspired by Claude Code's reactive compact pattern.
            if is_context_overflow(stream_error):
                logger.info(
                    "Context overflow detected, triggering reactive compaction "
                    "for session %s",
                    job.session_id,
                )
                await _delete_empty_assistant_messages(session_factory, job.session_id)
                return "compact"

            logger.exception("LLM stream error (not retryable or retries exhausted)")
            had_visible_text = bool(accumulated_text.strip())
            self.has_text = had_visible_text
            self.finish_reason = "error"
            if accumulated_text or accumulated_reasoning:
                async with session_factory() as db:
                    async with db.begin():
                        if accumulated_text:
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
            # Publish a paired non-terminal STEP_FINISH so the frontend step tracker
            # stays consistent without seeing an undeclared terminal reason.
            job.publish(
                SSEEvent(
                    STEP_FINISH,
                    {
                        "tokens": None,
                        "cost": 0.0,
                        "total_cost": sp.total_cost,
                        "reason": "tool_use",
                    },
                )
            )
            await _delete_empty_assistant_messages(session_factory, job.session_id)
            return "continue"

        # --- Persist text and reasoning parts ---
        self.has_text = bool(accumulated_text.strip())
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

        if has_tool_calls and streaming_executor.has_submissions:
            if _exec_blocked:
                return "stop"

            # === Collect results — concurrent tools already running, exclusive run now ===
            exec_results = await streaming_executor.collect()

            # === Finalize — persist results, emit SSE, handle side effects ===
            if exec_results:
                for exec_result in exec_results:
                    meta = _exec_metadata.get(exec_result.index)
                    if meta is None:
                        continue

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
                        continue

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
                        continue

                    result = exec_result.result
                    if result is None:
                        continue

                    # Emit SSE result
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

                    # Build persisted output (may include todo reminder for LLM)
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

        # --- Cost tracking ---
        if self.usage_data and sp.model_info:
            if sp.model_info.pricing and (
                sp.model_info.pricing.prompt > 0 or sp.model_info.pricing.completion > 0
            ):
                self.step_cost = _calculate_step_cost(
                    self.usage_data, sp.model_info
                )
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

        # If this step produced tool calls, the agent loop is not actually
        # finished yet, even if the provider reported a generic "stop".
        # Surface that as "tool_use" so the frontend keeps streaming UI alive
        # until the follow-up step completes.
        if has_tool_calls and self.finish_reason != "tool_use":
            self.finish_reason = "tool_use"

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

            max_ctx = _get_effective_context_window(sp.model_info) or sp.model_info.capabilities.max_context
            max_out = sp.model_info.capabilities.max_output
            if should_compact(self.usage_data, max_ctx, model_max_output=max_out):
                logger.info("Context overflow detected, running compaction")
                return "compact"

        # --- Run middleware on_step_complete ---
        if self._mw_ctx is not None:
            await sp.middleware_chain.run_on_step_complete(self._mw_ctx)

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
