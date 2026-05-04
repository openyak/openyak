"""Session prompt orchestrator.

Owns the setup phase and the main agent while-loop.
Mirrors OpenCode's session/prompt.ts.

Separation of concerns:
  - SessionPrompt: setup + cross-step state + loop skeleton
  - SessionProcessor: single LLM step execution + tool dispatching
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.agent.permission import (
    GLOBAL_DEFAULTS,
    merge_rulesets,
    parse_session_permissions,
    presets_to_ruleset,
)
from app.models.message import Message, Part
from app.provider.registry import ProviderRegistry
from app.schemas.chat import PromptRequest
from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_messages,
    get_session,
    update_session_title,
)
from app.session.system_prompt import (
    SystemPromptParts,
    _active_skills_from_registry,
    assemble as assemble_system_prompt,
    default_tz_name,
    load_project_instructions,
    render_skills_section,
)
from app.streaming.events import (
    AGENT_ERROR,
    DONE,
    STEP_START,
    TITLE_UPDATE,
    SSEEvent,
)
from app.streaming.manager import GenerationJob
from app.tool.registry import ToolRegistry
from app.config import get_settings

if TYPE_CHECKING:
    from app.schemas.agent import AgentInfo
    from app.session.processor import SessionProcessor

logger = logging.getLogger(__name__)

def _cfg():
    return get_settings()


class SessionPrompt:
    """Owns the setup phase and the main agent while-loop.

    Instance state is split into:
      - Setup state: resolved agent/model/provider, system prompt, permissions
      - Cross-step loop state: cost, tokens, doom history, todos, etc.

    SessionProcessor is created fresh per loop step and writes back mutable
    state (agent, model_id, etc.) on agent switching.
    """

    def __init__(
        self,
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
        self.job = job
        self.request = request
        self.session_factory = session_factory
        self.provider_registry = provider_registry
        self.agent_registry = agent_registry
        self.tool_registry = tool_registry
        self.index_manager = index_manager
        self.skip_user_message = skip_user_message

        # Populated by _setup() — setup-phase state
        self.agent: AgentInfo | None = None  # type: ignore[assignment]
        self.model_id: str | None = None
        self.provider: Any | None = None
        self.model_info: Any | None = None
        self.directory: str | None = None
        self.workspace: str | None = None
        self.fts_status: dict[str, Any] | None = None
        self.workspace_memory_section: str | None = None
        self.system_prompt_parts: SystemPromptParts | None = None
        self.merged_permissions: list = []
        self.request_permissions: list = []
        self.preset_permissions: list = []
        self.session_permissions: list = []
        self.is_first_turn: bool = False
        self.first_user_text: str = request.text
        self.session_permission_data: Any = None

        # Whether the provider supports Anthropic-style prompt caching.
        # Set during _setup() after provider is resolved.
        self._supports_prompt_caching: bool = False

        # Middleware chain (composable cross-cutting concerns)
        from app.session.middlewares.factory import build_middleware_chain

        self.middleware_chain = build_middleware_chain(
            get_todos_fn=lambda: self.current_todos,
        )

        # Deferred tools: MCP tool IDs discovered via tool_search this generation
        self.discovered_tools: set[str] = set()

        # Cross-step loop state
        self.step: int = 0
        self.total_cost: float = 0.0
        self.total_tokens_accumulated: dict[str, int] = {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_read": 0,
            "cache_write": 0,
        }
        self.latest_tokens_snapshot: dict[str, int] = {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_read": 0,
            "cache_write": 0,
            "total": 0,
        }
        self.current_todos: list[dict[str, Any]] = []
        self.continuation_attempts: int = 0
        self._length_continuations: int = 0
        self._context_collapse_exhausted: bool = False
        self.finish_reason: str = "stop"
        self.assistant_msg_id: str | None = None

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def system_prompt(self) -> str | list[dict[str, Any]]:
        """Return the system prompt formatted for the active provider.

        For Anthropic providers, returns a list of content blocks with
        ``cache_control`` on the static portion (enables prompt caching).
        For all other providers, returns a plain concatenated string.
        """
        if self.system_prompt_parts is None:
            return ""
        if self._supports_prompt_caching:
            return self.system_prompt_parts.as_cached_blocks()
        return self.system_prompt_parts.as_plain_text()

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main entry point: setup → loop → post-loop."""
        await self._setup()
        await self._loop()
        await self._post_loop()

    # ------------------------------------------------------------------
    # Setup phase (steps 1-5 from the original _run_generation_inner)
    # ------------------------------------------------------------------

    async def _setup(self) -> None:
        """Resolve agent/model, create session, build system prompt, merge permissions."""

        # --- 1. Resolve agent ---
        self.agent = self.agent_registry.get(self.request.agent) or self.agent_registry.default_agent()

        # --- 2. Resolve model & provider (with per-agent model override) ---
        model_id = self.request.model
        if not model_id and self.agent.model:
            model_id = self.agent.model.model_id

        if not model_id:
            for _m in self.provider_registry.all_models():
                if _m.pricing.prompt == 0 and _m.pricing.completion == 0:
                    model_id = _m.id
                    break
            if not model_id:
                all_models = self.provider_registry.all_models()
                if all_models:
                    model_id = all_models[0].id

        provider_id = self.request.provider_id
        resolved = self.provider_registry.resolve_model(model_id, provider_id)
        if not resolved:
            try:
                await self.provider_registry.refresh_models()
                resolved = self.provider_registry.resolve_model(model_id, provider_id)
            except Exception:
                pass
        if not resolved:
            self.job.publish(SSEEvent(AGENT_ERROR, {"error_message": f"Model not found: {model_id}"}))
            raise RuntimeError(f"Model not found: {model_id}")

        self.provider, self.model_info = resolved
        self.model_id = model_id

        # Enable prompt caching for Anthropic provider
        self._supports_prompt_caching = (
            self.provider.id == "anthropic"
            or (self.model_info and getattr(self.model_info.capabilities, "prompt_caching", False))
        )

        # Remember last-used Ollama model for startup pre-warming
        if self.provider.id == "ollama":
            try:
                from app.api.config import _update_env_file
                _update_env_file("OPENYAK_OLLAMA_LAST_MODEL", model_id.removeprefix("ollama/"))
            except Exception:
                pass

        # --- 3. Create/load session and persist user message ---
        if self.skip_user_message:
            pass
        else:
            async with self.session_factory() as db:
                async with db.begin():
                    session = await get_session(db, self.job.session_id)
                    if session is None:
                        session = await create_session(
                            db,
                            id=self.job.session_id,
                            directory=self.request.workspace or ".",
                        )
                        self.is_first_turn = True

                    user_msg = await create_message(
                        db,
                        session_id=session.id,
                        data={"role": "user", "agent": self.agent.name},
                    )
                    await create_part(
                        db,
                        message_id=user_msg.id,
                        session_id=session.id,
                        data={"type": "text", "text": self.request.text},
                    )

                    for att in self.request.attachments:
                        await create_part(
                            db,
                            message_id=user_msg.id,
                            session_id=session.id,
                            data={
                                "type": "file",
                                "file_id": att.get("file_id", ""),
                                "name": att.get("name", ""),
                                "path": att.get("path", ""),
                                "size": att.get("size", 0),
                                "mime_type": att.get("mime_type", ""),
                                "source": att.get("source", "uploaded"),
                                "content_hash": att.get("content_hash"),
                            },
                        )

        # --- 4. Build system prompt ---
        async with self.session_factory() as db:
            async with db.begin():
                session = await get_session(db, self.job.session_id)
                if session:
                    self.directory = session.directory

        self.workspace = (
            self.directory if self.directory and self.directory != "." else self.request.workspace
        )

        if self.index_manager is not None and self.workspace:
            try:
                await self.index_manager.ensure_index(self.workspace, self.job.session_id)
                self.fts_status = self.index_manager.index_status(self.job.session_id)

                # Ingest attachments that live OUTSIDE the workspace
                if self.request.attachments:
                    from pathlib import Path as _Path
                    ws_resolved = _Path(self.workspace).resolve()
                    for att in self.request.attachments:
                        att_path = att.get("path")
                        if not att_path or not _Path(att_path).is_file():
                            continue
                        try:
                            _Path(att_path).resolve().relative_to(ws_resolved)
                            continue
                        except ValueError:
                            pass
                        try:
                            await self.index_manager.ingest_file(self.workspace, att_path)
                            logger.info("FTS: ingested attachment %s", att_path)
                        except Exception as e:
                            logger.warning("FTS: failed to ingest attachment %s: %s", att_path, e)
            except Exception as e:
                logger.warning("FTS: setup failed for session %s: %s", self.job.session_id, e)

        # --- Load workspace-scoped memory for system prompt ---
        if self.workspace and self.workspace != ".":
            try:
                from app.memory.injection import build_workspace_memory_section

                self.workspace_memory_section = await build_workspace_memory_section(
                    self.session_factory, self.workspace
                )
            except Exception:
                logger.debug("Workspace memory injection skipped", exc_info=True)

        # I/O is resolved here so assemble() stays pure (per ADR-0009).
        import platform as _platform
        from datetime import datetime as _datetime

        self.system_prompt_parts = assemble_system_prompt(
            self.agent,
            directory=self.directory,
            workspace=self.workspace,
            fts_status=self.fts_status,
            workspace_memory_section=self.workspace_memory_section,
            project_instructions=load_project_instructions(self.directory),
            skills_summary=render_skills_section(_active_skills_from_registry()),
            now=_datetime.now(),
            tz_name=default_tz_name(),
            platform_name=_platform.system(),
        )

        # --- 5. Merge permission rulesets ---
        # Persisted browser choices arrive as request permissions. Do not read
        # historical Session.permission here; Settings must be the visible source
        # of truth for remembered approvals and denials.
        self.session_permissions = parse_session_permissions(self.session_permission_data)
        self.preset_permissions = presets_to_ruleset(self.request.permission_presets)
        self.request_permissions = parse_session_permissions(self.request.permission_rules)
        self.merged_permissions = merge_rulesets(
            GLOBAL_DEFAULTS,
            self.agent.permissions,
            self.preset_permissions,
            self.request_permissions,
            self.session_permissions,
        )

        # --- Reconstruct artifact cache from message history ---
        # Allows update/rewrite operations to work across generations.
        async with self.session_factory() as db:
            async with db.begin():
                _hist_msgs = await get_messages(db, self.job.session_id)
                for _msg in _hist_msgs:
                    for _part in _msg.parts:
                        _pd = _part.data or {}
                        if _pd.get("type") == "tool" and _pd.get("tool") == "artifact":
                            _state = _pd.get("state") or {}
                            _meta = _state.get("metadata") or {}
                            _inp = _state.get("input") or {}
                            _ident = _meta.get("identifier") or _inp.get("identifier")
                            _cont = _meta.get("content") or _inp.get("content")
                            if _ident and _cont:
                                self.job.artifact_cache[_ident] = {
                                    "content": _cont,
                                    "type": _meta.get("type") or _inp.get("type", "code"),
                                    "title": _meta.get("title") or _inp.get("title", "Untitled"),
                                    "language": _meta.get("language") or _inp.get("language"),
                                }

    # ------------------------------------------------------------------
    # Main agent while-loop
    # ------------------------------------------------------------------

    async def _loop(self) -> None:
        """Main agent while-loop: step → LLM → tools → repeat."""
        # Deferred import to avoid circular dependency (processor imports prompt via TYPE_CHECKING only)
        from app.session.processor import (
            SessionProcessor,
            _delete_empty_assistant_messages,
        )
        from app.session.utils import (
            get_effective_context_window as _get_effective_context_window,
            sanitize_llm_messages_for_request as _sanitize_llm_messages_for_request,
        )
        from app.session.compaction import run_compaction, should_compact
        from app.session.manager import create_message as _create_message, get_message_history_for_llm
        from app.session.microcompact import microcompact_messages, apply_tool_result_budget, context_collapse

        _hard_cap_final_done = False
        _consecutive_compact_failures = 0
        _MAX_CONSECUTIVE_COMPACT_FAILURES = 3
        _has_any_text = False  # Track if any step produced visible text
        _empty_response_nudged = False  # Prevent infinite nudge loop

        while True:
            if self.job.abort_event.is_set():
                break

            self.step += 1

            if self.step > _cfg().max_steps:
                if _hard_cap_final_done:
                    # Already did the forced final step — truly stop now
                    logger.warning(
                        "Hard step cap+1 reached for session %s, stopping",
                        self.job.session_id,
                    )
                    break

                # First time hitting the cap: inject a summary request and let
                # one more LLM step execute so the agent can wrap up gracefully
                _hard_cap_final_done = True
                logger.warning(
                    "Hard step cap (%d) reached for session %s, requesting final summary",
                    _cfg().max_steps,
                    self.job.session_id,
                )
                async with self.session_factory() as db:
                    async with db.begin():
                        cap_msg = await _create_message(
                            db,
                            session_id=self.job.session_id,
                            data={"role": "user", "agent": self.agent.name, "system": True},
                        )
                        await create_part(
                            db,
                            message_id=cap_msg.id,
                            session_id=self.job.session_id,
                            data={
                                "type": "text",
                                "text": (
                                    "[System: You have reached the maximum number of steps. "
                                    "Stop using tools and provide a final summary of what you "
                                    "have accomplished and any remaining work.]"
                                ),
                            },
                        )
                # Fall through to normal step execution (do NOT break or continue)

            self.job.publish(SSEEvent(STEP_START, {"step": self.step, "session_id": self.job.session_id}))

            # Proactively refresh proxy token if expired (step 1 only)
            if self.step == 1:
                _settings = get_settings()
                if _settings.proxy_url and _settings.proxy_refresh_token:
                    from app.session.utils import is_jwt_expired as _is_jwt_expired
                    _token = getattr(_settings, "proxy_token", "")
                    if _token and _is_jwt_expired(_token):
                        logger.info("Proxy token expired, refreshing before LLM call")
                        from app.provider.proxy_auth import refresh_proxy_token
                        await refresh_proxy_token(_settings, self.provider_registry)

            # Load message history for this step
            async with self.session_factory() as db:
                async with db.begin():
                    llm_messages = await get_message_history_for_llm(db, self.job.session_id)
            llm_messages = _sanitize_llm_messages_for_request(
                llm_messages,
                session_id=self.job.session_id,
                model_max_context=(
                    _get_effective_context_window(self.model_info)
                    if self.model_info
                    else None
                ),
            )

            # --- Zero-cost context compression (inspired by Claude Code) ---
            # Layer 1: Replace old tool outputs from specific tools with stubs
            llm_messages = microcompact_messages(llm_messages)
            # Layer 2: Enforce aggregate tool result size budget
            llm_messages = apply_tool_result_budget(llm_messages)

            # Run middleware before_llm_call hook
            from app.session.middleware import MiddlewareContext

            mw_ctx = MiddlewareContext(
                session_id=self.job.session_id,
                step=self.step,
                job=self.job,
                model_id=self.model_id,
                agent_name=self.agent.name if self.agent else None,
            )
            llm_messages = await self.middleware_chain.run_before_llm_call(
                llm_messages, mw_ctx,
            )

            # Create assistant message shell
            async with self.session_factory() as db:
                async with db.begin():
                    assistant_msg = await _create_message(
                        db,
                        session_id=self.job.session_id,
                        data={
                            "role": "assistant",
                            "agent": self.agent.name,
                            "model_id": self.model_id,
                            "provider_id": self.provider.id,
                        },
                    )
            self.assistant_msg_id = assistant_msg.id

            # Execute one LLM step — processor handles streaming + tool dispatch
            processor: SessionProcessor = SessionProcessor(
                session_prompt=self,
                llm_messages=llm_messages,
                assistant_msg_id=self.assistant_msg_id,
                middleware_ctx=mw_ctx,
            )
            result = await processor.process()

            # Accumulate cost and tokens from this step
            if processor.has_text:
                _has_any_text = True
            self.total_cost += processor.step_cost
            self.finish_reason = processor.finish_reason
            # Reset length continuation counter when model finishes normally
            if self.finish_reason != "length":
                self._length_continuations = 0
            if processor.usage_data:
                for k in self.total_tokens_accumulated:
                    self.total_tokens_accumulated[k] += processor.usage_data.get(k, 0)
                self.latest_tokens_snapshot = {
                    "input": processor.usage_data.get("input", 0),
                    "output": processor.usage_data.get("output", 0),
                    "reasoning": processor.usage_data.get("reasoning", 0),
                    "cache_read": processor.usage_data.get("cache_read", 0),
                    "cache_write": processor.usage_data.get("cache_write", 0),
                    "total": processor.usage_data.get("total", 0),
                }

            # Handle processor result
            if result == "compact":
                # --- Layer 3: Try context collapse first (zero LLM cost) ---
                # Drop the oldest 1/3 of messages. If that frees enough
                # tokens, skip the expensive LLM-based full compaction.
                _skip_full_compaction = False
                if not self._context_collapse_exhausted:
                    try:
                        async with self.session_factory() as db:
                            async with db.begin():
                                _collapse_msgs = await get_message_history_for_llm(
                                    db, self.job.session_id
                                )
                        collapsed, tokens_saved = context_collapse(_collapse_msgs)
                        if tokens_saved > 0:
                            # Persist the collapsed messages by deleting old ones
                            await _persist_context_collapse(
                                self.job.session_id,
                                collapsed,
                                session_factory=self.session_factory,
                            )
                            logger.info(
                                "Context collapse freed ~%d tokens, "
                                "skipping full compaction",
                                tokens_saved,
                            )
                            _skip_full_compaction = True
                        else:
                            # Nothing to collapse — mark exhausted so we
                            # go straight to full compaction next time
                            self._context_collapse_exhausted = True
                    except Exception:
                        logger.debug(
                            "Context collapse failed, falling back to full compaction",
                            exc_info=True,
                        )
                        self._context_collapse_exhausted = True

                if not _skip_full_compaction:
                    # --- Layer 4: Full LLM-based compaction ---
                    # Queue workspace memory BEFORE compaction so important info
                    # from messages about to be pruned is preserved in memory.
                    if self.workspace and self.workspace != ".":
                        try:
                            from app.memory.workspace_memory_queue import get_workspace_memory_queue

                            _ws_mq = get_workspace_memory_queue()
                            if _ws_mq is not None:
                                async with self.session_factory() as db:
                                    async with db.begin():
                                        _pre_msgs = await get_message_history_for_llm(
                                            db, self.job.session_id
                                        )
                                _ws_mq.add(
                                    self.job.session_id,
                                    self.workspace,
                                    _pre_msgs,
                                    model_id=self.model_id,
                                )
                        except Exception:
                            logger.debug(
                                "Pre-compaction workspace memory queue failed",
                                exc_info=True,
                            )

                    try:
                        await run_compaction(
                            self.job.session_id,
                            job=self.job,
                            session_factory=self.session_factory,
                            provider_registry=self.provider_registry,
                            agent_registry=self.agent_registry,
                            model_id=self.model_id,
                        )
                        _consecutive_compact_failures = 0
                    except Exception:
                        _consecutive_compact_failures += 1
                        logger.warning(
                            "Compaction failed (%d/%d) for session %s",
                            _consecutive_compact_failures,
                            _MAX_CONSECUTIVE_COMPACT_FAILURES,
                            self.job.session_id,
                            exc_info=True,
                        )
                        if _consecutive_compact_failures >= _MAX_CONSECUTIVE_COMPACT_FAILURES:
                            self.job.publish(SSEEvent(AGENT_ERROR, {
                                "error_message": (
                                    "Context compression failed repeatedly. "
                                    "Please start a new conversation."
                                ),
                            }))
                            break

                # Todo context recovery: after compaction the LLM may have
                # lost awareness of outstanding todos (the original todo tool
                # call got truncated). Re-inject a reminder so it can continue.
                incomplete = [
                    t for t in self.current_todos
                    if t.get("status") in ("pending", "in_progress")
                ]
                if incomplete:
                    todo_summary = "\n".join(
                        f"  - [{t.get('status', '?')}] {t.get('content', 'unnamed')}"
                        for t in incomplete[:10]
                    )
                    logger.info(
                        "Todo recovery after compaction: %d incomplete todo(s)",
                        len(incomplete),
                    )
                    async with self.session_factory() as db:
                        async with db.begin():
                            recovery_msg = await _create_message(
                                db,
                                session_id=self.job.session_id,
                                data={"role": "user", "agent": self.agent.name, "system": True},
                            )
                            await create_part(
                                db,
                                message_id=recovery_msg.id,
                                session_id=self.job.session_id,
                                data={
                                    "type": "text",
                                    "text": (
                                        "[System: Context was compacted. Your active todo list:\n"
                                        f"{todo_summary}\n"
                                        "Continue working on these tasks. Call the todo tool to "
                                        "update status as you complete each one.]"
                                    ),
                                },
                            )

                continue

            if result == "stop":
                # Length continuation: model hit token limit, keep going
                # Cap at 3 to prevent runaway token consumption.
                if self.finish_reason == "length":
                    self._length_continuations += 1
                    if self._length_continuations <= 3:
                        logger.info(
                            "finish_reason=length at step %d (attempt %d/3), "
                            "continuing for more output",
                            self.step,
                            self._length_continuations,
                        )
                        continue
                    else:
                        logger.warning(
                            "finish_reason=length exceeded max continuations (3) "
                            "at step %d, stopping to prevent runaway token usage",
                            self.step,
                        )
                        # Fall through to stop

                # First-turn tool nudge: if step 1 had 3+ attachments but no tool calls,
                # nudge the model to use tools for analysis
                if (
                    self.step == 1
                    and len(self.request.attachments) >= 3
                    and not self.job.abort_event.is_set()
                ):
                    logger.info(
                        "First-turn tool nudge: %d attachments with no tool calls",
                        len(self.request.attachments),
                    )
                    async with self.session_factory() as db:
                        async with db.begin():
                            nudge_msg = await _create_message(
                                db,
                                session_id=self.job.session_id,
                                data={"role": "user", "agent": self.agent.name, "system": True},
                            )
                            await create_part(
                                db,
                                message_id=nudge_msg.id,
                                session_id=self.job.session_id,
                                data={
                                    "type": "text",
                                    "text": (
                                        "[System: You have access to tools. Please use them to "
                                        "analyze the attached files and provide a thorough response.]"
                                    ),
                                },
                            )
                    continue

                # Completion guard: nudge agent if it stopped with incomplete todos
                incomplete = [
                    t for t in self.current_todos
                    if t.get("status") in ("pending", "in_progress")
                ]
                if incomplete and self.continuation_attempts < _cfg().max_continuation_attempts:
                    self.continuation_attempts += 1
                    incomplete_names = ", ".join(
                        t.get("content", "unnamed") for t in incomplete[:5]
                    )
                    logger.info(
                        "Completion guard: %d incomplete todo(s), attempt %d/%d",
                        len(incomplete),
                        self.continuation_attempts,
                        _cfg().max_continuation_attempts,
                    )
                    async with self.session_factory() as db:
                        async with db.begin():
                            cont_msg = await _create_message(
                                db,
                                session_id=self.job.session_id,
                                data={"role": "user", "agent": self.agent.name, "system": True},
                            )
                            await create_part(
                                db,
                                message_id=cont_msg.id,
                                session_id=self.job.session_id,
                                data={
                                    "type": "text",
                                    "text": (
                                        f"[System: You have {len(incomplete)} incomplete todo(s): "
                                        f"{incomplete_names}. "
                                        f"Continue working on them. Call the todo tool to update "
                                        f"status, then use tools to complete each task.]"
                                    ),
                                },
                            )
                    continue

                # Empty response guard: if the entire generation produced no
                # visible text, nudge the model once to provide a final summary.
                # Without this, the user sees a blank response (all output was
                # reasoning + tool calls hidden in the activity panel).
                if (
                    not _has_any_text
                    and not _empty_response_nudged
                    and not self.job.abort_event.is_set()
                ):
                    _empty_response_nudged = True
                    logger.warning(
                        "Agent produced no text output across %d step(s) for "
                        "session %s, nudging for final summary",
                        self.step,
                        self.job.session_id,
                    )
                    async with self.session_factory() as db:
                        async with db.begin():
                            nudge_msg = await _create_message(
                                db,
                                session_id=self.job.session_id,
                                data={"role": "user", "agent": self.agent.name, "system": True},
                            )
                            await create_part(
                                db,
                                message_id=nudge_msg.id,
                                session_id=self.job.session_id,
                                data={
                                    "type": "text",
                                    "text": (
                                        "[System: You completed your work but produced no visible "
                                        "response text. The user cannot see your reasoning or tool "
                                        "activity. Please provide a clear, helpful summary of what "
                                        "you found and accomplished. Do NOT use any tools — just "
                                        "respond with text.]"
                                    ),
                                },
                            )
                    continue

                break  # No tool calls, no incomplete todos → done

            # result == "continue": has tool calls, loop again with tool results

    # ------------------------------------------------------------------
    # Post-loop: cleanup, persist cost, DONE, auto-title
    # ------------------------------------------------------------------

    async def _post_loop(self) -> None:
        """Cleanup, persist accumulated cost/tokens, publish DONE, auto-title."""
        from app.session.processor import _delete_empty_assistant_messages

        await _delete_empty_assistant_messages(self.session_factory, self.job.session_id)

        # Persist accumulated cost and tokens on the last assistant message
        if self.assistant_msg_id and (
            self.total_cost > 0 or any(v > 0 for v in self.total_tokens_accumulated.values())
        ):
            try:
                async with self.session_factory() as db:
                    async with db.begin():
                        msg = await db.get(Message, self.assistant_msg_id)
                        if msg:
                            updated_data = dict(msg.data) if msg.data else {}
                            updated_data["cost"] = self.total_cost
                            # Latest step snapshot for UI display (matches OpenCode style)
                            updated_data["tokens"] = self.latest_tokens_snapshot
                            # Full accumulated totals for diagnostics
                            updated_data["tokens_accumulated"] = self.total_tokens_accumulated
                            msg.data = updated_data
            except Exception:
                logger.warning(
                    "Failed to persist cost/tokens on message %s", self.assistant_msg_id
                )

        # Set title on first turn — use first user message directly.
        # Must happen BEFORE DONE so the SSE client receives TITLE_UPDATE.
        if self.is_first_turn:
            title = self.first_user_text.strip()[:60]
            if title:
                try:
                    async with self.session_factory() as db:
                        async with db.begin():
                            await update_session_title(db, self.job.session_id, title)
                    self.job.publish(SSEEvent(TITLE_UPDATE, {"title": title}))
                except Exception:
                    logger.warning(
                        "Failed to persist title for %s", self.job.session_id
                    )

        # Queue conversation for workspace memory refresh
        if not self.job.abort_event.is_set() and self.workspace and self.workspace != ".":
            try:
                from app.memory.workspace_memory_queue import get_workspace_memory_queue
                from app.session.manager import get_message_history_for_llm as _get_hist

                ws_queue = get_workspace_memory_queue()
                if ws_queue is not None:
                    async with self.session_factory() as db:
                        async with db.begin():
                            _msgs = await _get_hist(db, self.job.session_id)
                    ws_queue.add(
                        self.job.session_id,
                        self.workspace,
                        _msgs,
                        model_id=self.model_id,
                    )
                    logger.info(
                        "Workspace memory: queued %s for refresh (%d messages)",
                        self.workspace,
                        len(_msgs),
                    )
            except Exception:
                logger.warning("Workspace memory queue submission failed", exc_info=True)

        # Publish DONE to unlock the frontend UI.
        self.job.publish(
            SSEEvent(
                DONE,
                {
                    "session_id": self.job.session_id,
                    "finish_reason": (
                        self.finish_reason if not self.job.abort_event.is_set() else "aborted"
                    ),
                    "total_cost": self.total_cost,
                },
            )
        )

    # ------------------------------------------------------------------
    # Shared helpers (called by SessionProcessor on agent switch)
    # ------------------------------------------------------------------

    def rebuild_permissions_and_prompt(self) -> None:
        """Rebuild merged permissions and system prompt after an agent switch.

        Called by SessionProcessor when the plan tool switches agents.
        """
        self.merged_permissions = merge_rulesets(
            GLOBAL_DEFAULTS,
            self.agent.permissions,
            self.preset_permissions,
            self.request_permissions,
            self.session_permissions,
        )
        # I/O is resolved here so assemble() stays pure (per ADR-0009).
        import platform as _platform
        from datetime import datetime as _datetime

        self.system_prompt_parts = assemble_system_prompt(
            self.agent,
            directory=self.directory,
            workspace=self.workspace,
            fts_status=self.fts_status,
            workspace_memory_section=self.workspace_memory_section,
            project_instructions=load_project_instructions(self.directory),
            skills_summary=render_skills_section(_active_skills_from_registry()),
            now=_datetime.now(),
            tz_name=default_tz_name(),
            platform_name=_platform.system(),
        )


async def _persist_context_collapse(
    session_id: str,
    collapsed_messages: list[dict[str, Any]],
    *,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Persist context collapse by deleting old messages and inserting a boundary.

    The first message in ``collapsed_messages`` is expected to be the
    synthetic boundary marker from ``context_collapse()``.
    """
    if not collapsed_messages:
        return

    boundary = collapsed_messages[0]

    async with session_factory() as db:
        async with db.begin():
            # Get all existing messages ordered by time
            stmt = (
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.time_created.asc())
            )
            result = await db.execute(stmt)
            db_messages = list(result.scalars().all())

            if not db_messages:
                return

            # Calculate how many DB messages to delete.
            # collapsed_messages = [boundary_marker] + kept_messages
            # Original had len(db_messages) messages total.
            # kept_messages count = len(collapsed_messages) - 1 (boundary marker)
            kept_count = len(collapsed_messages) - 1
            delete_count = len(db_messages) - kept_count
            if delete_count <= 0:
                return

            # Delete the oldest messages (and their parts via cascade)
            for msg in db_messages[:delete_count]:
                await db.delete(msg)

            # Insert the boundary marker as a synthetic user message
            if boundary.get("content"):
                boundary_msg = Message(
                    session_id=session_id,
                    data={"role": "user", "agent": "system", "system": True},
                )
                db.add(boundary_msg)
                await db.flush()

                boundary_part = Part(
                    message_id=boundary_msg.id,
                    session_id=session_id,
                    data={
                        "type": "text",
                        "text": boundary["content"],
                        "synthetic": True,
                    },
                )
                db.add(boundary_part)
