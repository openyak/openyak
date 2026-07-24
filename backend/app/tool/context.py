"""Tool execution context."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Literal

from app.schemas.agent import AgentInfo


@dataclass
class ToolContext:
    """Context passed to every tool execution.

    Provides:
      - session/message identifiers
      - abort signaling
      - permission checking via ask()
      - metadata streaming to UI
      - full message history (read-only, mirrors OpenCode's Tool.Context.messages)
    """

    session_id: str
    message_id: str
    agent: AgentInfo
    call_id: str
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)
    workspace: str | None = None  # workspace directory restriction
    index_manager: Any | None = None  # FTS IndexManager; None when FTS disabled
    messages: list[dict[str, Any]] = field(default_factory=list)
    """Full LLM-formatted message history as of this tool call (read-only).

    Mirrors OpenCode's Tool.Context.messages field. Populated by SessionProcessor
    before each tool execution. Tools that need conversation context (e.g., task
    tool summarising prior work for a subagent) can read this field.
    """

    # Deferred-tools discovery state (shared reference with SessionPrompt)
    discovered_tools: set[str] | None = None

    # Explicit Agent runtime scope. New composed Tools should use these fields
    # instead of reaching through undocumented dynamic attributes.
    model_id: str | None = None
    provider_id: str | None = None
    permission_rules: tuple[dict[str, Any], ...] = ()
    reasoning: bool | None = None
    execution_mode: Literal["standard", "ultra"] = "standard"
    depth: int = 0
    job: Any | None = None
    app_state: dict[str, Any] | None = None

    # Callbacks set by the session processor
    _publish_fn: Callable[[str, dict[str, Any]], None] | None = None
    _ask_fn: Callable[[str, list[str]], Awaitable[bool]] | None = None

    def publish_metadata(self, title: str | None = None, metadata: dict[str, Any] | None = None) -> None:
        """Stream metadata update to the UI (e.g., tool progress)."""
        if self._publish_fn:
            self._publish_fn("tool_metadata", {
                "call_id": self.call_id,
                "title": title,
                "metadata": metadata or {},
            })

    async def ask(self, permission: str, patterns: list[str] | None = None) -> bool:
        """Check permission. Raises RejectedError if denied.

        For 'allow' → returns True immediately.
        For 'ask' → publishes permission_request, waits for user.
        For 'deny' → raises RejectedError.
        """
        if self._ask_fn:
            return await self._ask_fn(permission, patterns or [])
        return True  # Default: allow

    @property
    def is_aborted(self) -> bool:
        return self.abort_event.is_set()
