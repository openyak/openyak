"""Two-stage loop detection for agent tool calls.

Replaces the simple "block after N identical calls" approach with a
warn-then-stop strategy inspired by DeerFlow's LoopDetectionMiddleware:

  1. Hash each set of tool calls (name + args, order-independent).
  2. Track recent hashes in a sliding window per session.
  3. After ``warn_threshold`` identical hashes → inject a warning message
     into the tool output so the LLM knows it's repeating itself.
  4. After ``hard_limit`` identical hashes → block the tool call entirely
     and force the agent to produce a final text answer.

This is strictly better than the old binary block/allow: the model gets a
chance to self-correct before being hard-stopped.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections import OrderedDict, defaultdict
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Defaults — read from Settings when the singleton is created (see bottom of file)
_DEFAULT_WINDOW_SIZE = 20
_DEFAULT_MAX_SESSIONS = 200

WARNING_MSG = (
    "[LOOP DETECTED] You are repeating the same tool calls with identical arguments. "
    "Stop calling tools and produce your final answer now. If you cannot complete "
    "the task, summarize what you accomplished so far."
)

HARD_STOP_MSG = (
    "[FORCED STOP] Repeated tool calls exceeded the safety limit. "
    "Producing final answer with results collected so far."
)


def _hash_tool_call(name: str, args: dict) -> str:
    """Deterministic hash of a single tool call (name + args)."""
    blob = json.dumps({"name": name, "args": args}, sort_keys=True, default=str)
    return hashlib.md5(blob.encode()).hexdigest()[:12]


@dataclass
class LoopCheckResult:
    """Result of a loop detection check."""

    action: str  # "allow" | "warn" | "block"
    message: str | None = None  # Warning/block message to inject


class LoopDetector:
    """Per-session sliding-window loop detector with two-stage response.

    Usage::

        detector = LoopDetector()

        # In the tool execution loop:
        result = detector.check(session_id, tool_name, tool_args)
        if result.action == "block":
            # hard-stop: do not execute, force final answer
            ...
        elif result.action == "warn":
            # append result.message to tool output so LLM sees it
            ...
        else:
            # normal execution
            ...
    """

    def __init__(
        self,
        warn_threshold: int | None = None,
        hard_limit: int | None = None,
        window_size: int = _DEFAULT_WINDOW_SIZE,
        max_sessions: int = _DEFAULT_MAX_SESSIONS,
    ) -> None:
        from app.config import get_settings as _get_settings
        _s = _get_settings()
        if warn_threshold is None:
            warn_threshold = _s.loop_warn_threshold
        if hard_limit is None:
            hard_limit = _s.loop_hard_limit
        self.warn_threshold = warn_threshold
        self.hard_limit = hard_limit
        self.window_size = window_size
        self.max_sessions = max_sessions
        # Per-session tracking: OrderedDict for LRU eviction
        self._history: OrderedDict[str, list[str]] = OrderedDict()
        self._warned: dict[str, set[str]] = defaultdict(set)

    def check(self, session_id: str, tool_name: str, tool_args: dict) -> LoopCheckResult:
        """Check a tool call for loop patterns.

        Returns a LoopCheckResult indicating whether to allow, warn, or block.
        """
        call_hash = _hash_tool_call(tool_name, tool_args)

        # Touch / create entry (move to end for LRU)
        if session_id in self._history:
            self._history.move_to_end(session_id)
        else:
            self._history[session_id] = []
            self._evict_if_needed()

        history = self._history[session_id]
        history.append(call_hash)
        if len(history) > self.window_size:
            history[:] = history[-self.window_size:]

        count = history.count(call_hash)

        if count >= self.hard_limit:
            logger.error(
                "Loop hard limit reached for session %s: %s called %d times",
                session_id, tool_name, count,
            )
            return LoopCheckResult(action="block", message=HARD_STOP_MSG)

        if count >= self.warn_threshold:
            warned = self._warned[session_id]
            if call_hash not in warned:
                warned.add(call_hash)
                logger.warning(
                    "Repetitive tool calls detected for session %s: %s (%d times)",
                    session_id, tool_name, count,
                )
                return LoopCheckResult(action="warn", message=WARNING_MSG)

        return LoopCheckResult(action="allow")

    def reset(self, session_id: str | None = None) -> None:
        """Clear tracking state. If session_id given, clear only that session."""
        if session_id:
            self._history.pop(session_id, None)
            self._warned.pop(session_id, None)
        else:
            self._history.clear()
            self._warned.clear()

    def _evict_if_needed(self) -> None:
        """Evict least recently used sessions if over the limit."""
        while len(self._history) > self.max_sessions:
            evicted_id, _ = self._history.popitem(last=False)
            self._warned.pop(evicted_id, None)


# Module-level singleton — shared across all generations
loop_detector = LoopDetector()
