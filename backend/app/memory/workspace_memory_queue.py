"""Debounced async queue for workspace memory updates.

After each conversation in a workspace, the queue collects the
conversation context and, after a debounce period, triggers an LLM
call to refresh the workspace memory document.

The pending map is keyed by *workspace_path* (not session_id) so that
concurrent sessions in the same workspace don't produce duplicate or
conflicting updates.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.memory.workspace_memory_storage import (
    get_workspace_memory,
    upsert_workspace_memory,
)
from app.memory.workspace_memory_updater import (
    WORKSPACE_MEMORY_UPDATE_PROMPT,
    format_conversation_for_workspace_update,
    parse_workspace_memory_response,
)

logger = logging.getLogger(__name__)


@dataclass
class WorkspaceConversationContext:
    """A conversation snapshot queued for workspace memory refresh."""

    session_id: str
    workspace_path: str
    messages: list[dict[str, Any]]
    model_id: str | None = None
    timestamp: float = field(default_factory=time.time)


class WorkspaceMemoryUpdateQueue:
    """Debounced queue that refreshes workspace memory after conversations.

    Usage::

        queue = WorkspaceMemoryUpdateQueue(session_factory, provider_registry)
        queue.add(session_id, workspace_path, messages)
        # ... after debounce_seconds, refresh runs automatically
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        provider_registry: Any,
        *,
        debounce_seconds: int = 10,
    ) -> None:
        self._session_factory = session_factory
        self._provider_registry = provider_registry
        self._debounce_seconds = debounce_seconds
        self._pending: dict[str, WorkspaceConversationContext] = {}
        self._timer: asyncio.TimerHandle | None = None
        self._processing = False
        self._lock = asyncio.Lock()

    def add(
        self,
        session_id: str,
        workspace_path: str,
        messages: list[dict[str, Any]],
        *,
        model_id: str | None = None,
    ) -> None:
        """Queue a conversation for workspace memory refresh.

        Keyed by workspace_path — newer submissions replace older ones.
        Resets the debounce timer.
        """
        self._pending[workspace_path] = WorkspaceConversationContext(
            session_id=session_id,
            workspace_path=workspace_path,
            messages=messages,
            model_id=model_id,
        )

        # Reset debounce timer
        if self._timer is not None:
            self._timer.cancel()

        loop = asyncio.get_event_loop()
        self._timer = loop.call_later(
            self._debounce_seconds,
            lambda: asyncio.ensure_future(self._process()),
        )
        logger.info(
            "Workspace memory queue: added %s (session %s), "
            "will process in %ds (pending: %d)",
            workspace_path,
            session_id,
            self._debounce_seconds,
            len(self._pending),
        )

    async def _process(self) -> None:
        """Process all pending workspace memory refreshes."""
        async with self._lock:
            if self._processing:
                logger.info("Workspace memory queue: already processing, skipping")
                return
            self._processing = True

        try:
            to_process = dict(self._pending)
            self._pending.clear()

            if not to_process:
                return

            logger.info(
                "Workspace memory queue: processing %d workspace(s)",
                len(to_process),
            )

            for ws_path, ctx in to_process.items():
                try:
                    await self._refresh_workspace_memory(ctx)
                except Exception:
                    logger.exception(
                        "Workspace memory refresh failed for %s", ws_path
                    )
                await asyncio.sleep(0.5)

        finally:
            async with self._lock:
                self._processing = False

    async def _refresh_workspace_memory(
        self,
        ctx: WorkspaceConversationContext,
    ) -> None:
        """Run LLM-based workspace memory refresh for a single workspace."""
        conversation_text = format_conversation_for_workspace_update(ctx.messages)
        if not conversation_text.strip():
            logger.info(
                "Workspace memory: skipping %s — no conversation text extracted "
                "from %d messages",
                ctx.workspace_path,
                len(ctx.messages),
            )
            return

        logger.info(
            "Workspace memory: refreshing %s (conversation: %d chars, model: %s)",
            ctx.workspace_path,
            len(conversation_text),
            ctx.model_id,
        )

        # Load current memory
        current_memory = await get_workspace_memory(
            self._session_factory, ctx.workspace_path
        )
        if not current_memory:
            current_memory = "(empty — new workspace, no prior memory)"

        # Build the refresh prompt
        from app.memory.workspace_memory_storage import MAX_WORKSPACE_MEMORY_LINES

        prompt = WORKSPACE_MEMORY_UPDATE_PROMPT.format(
            current_memory=current_memory,
            conversation=conversation_text,
            max_lines=MAX_WORKSPACE_MEMORY_LINES,
        )

        # Call LLM
        response_text = await self._call_llm(prompt, model_id=ctx.model_id)
        if not response_text:
            logger.warning(
                "Workspace memory: LLM returned empty response for %s",
                ctx.workspace_path,
            )
            return

        # Parse and save
        new_content = parse_workspace_memory_response(response_text)
        if new_content.strip():
            await upsert_workspace_memory(
                self._session_factory, ctx.workspace_path, new_content
            )
            logger.info(
                "Workspace memory updated for %s (%d lines)",
                ctx.workspace_path,
                len(new_content.split("\n")),
            )
        else:
            logger.warning(
                "Workspace memory: parsed response was empty for %s",
                ctx.workspace_path,
            )

    async def _call_llm(
        self, prompt: str, *, model_id: str | None = None
    ) -> str | None:
        """Call an LLM for workspace memory refresh.

        Uses the caller's model_id so that the refresh runs on the same
        provider the session was already using.
        """
        try:
            effective_model_id = model_id

            if not effective_model_id:
                all_models = self._provider_registry.all_models()
                if all_models:
                    effective_model_id = all_models[0].id

            if not effective_model_id:
                logger.warning("Workspace memory: no model available")
                return None

            resolved = self._provider_registry.resolve_model(effective_model_id)
            if not resolved:
                logger.warning(
                    "Workspace memory: could not resolve model %s",
                    effective_model_id,
                )
                return None

            provider, _model_info = resolved

            system = (
                "You are a workspace memory manager. "
                "Maintain a concise plain-text document capturing important "
                "workspace context. Respond with pure plain text only. "
                "Never use Markdown syntax (no #, **, *, `, ```, >, []()])."
            )
            messages = [{"role": "user", "content": prompt}]
            response_text = ""
            async for chunk in provider.stream_chat(
                effective_model_id, messages, system=system, max_tokens=4000
            ):
                if chunk.type == "text-delta":
                    response_text += chunk.data.get("text", "")

            return response_text if response_text.strip() else None

        except Exception:
            logger.exception("Workspace memory: LLM call failed")
            return None

    def clear(self) -> None:
        """Clear pending queue without processing."""
        self._pending.clear()
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None


# Module-level singleton (initialized by app lifespan)
_queue: WorkspaceMemoryUpdateQueue | None = None


def get_workspace_memory_queue() -> WorkspaceMemoryUpdateQueue | None:
    return _queue


def set_workspace_memory_queue(queue: WorkspaceMemoryUpdateQueue) -> None:
    global _queue
    _queue = queue
