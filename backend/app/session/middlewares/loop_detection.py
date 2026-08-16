"""Middleware: two-stage loop detection for tool calls.

Detects repetitive tool calls using a sliding-window hash comparison.
Stage 1 (warn): inject a warning into tool output after warn_threshold hits.
Stage 2 (block): prevent tool execution after hard_limit hits.
"""

from __future__ import annotations

from typing import Any

from app.session.loop_detection import LoopCheckResult, loop_detector
from app.session.middleware import Middleware, MiddlewareContext, ToolAction


class LoopDetectionMiddleware(Middleware):
    """Two-stage warn-then-stop loop detection for tool calls."""

    _SLOT = "_loop_warnings"

    @staticmethod
    def _key(tool_name: str, tool_args: dict[str, Any]) -> str:
        """Identify the call a warning belongs to.

        ``before_tool_exec`` runs for every call as its chunk streams in, while
        ``after_tool_exec`` runs later, once per call, during dispatch. A single
        shared slot would be popped by whichever call finishes first, so a
        warning earned by a repeated ``read`` could be appended to an unrelated
        ``bash`` in the same step. Keying by the call's own identity — the same
        (name, args) pair the detector counts — puts it back on its own result.
        """
        return f"{tool_name}:{sorted(tool_args.items())!r}"

    async def before_tool_exec(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        ctx: MiddlewareContext,
    ) -> ToolAction:
        result: LoopCheckResult = loop_detector.check(
            ctx.session_id, tool_name, tool_args,
        )
        if result.action == "block":
            return ToolAction(action="block", message=result.message)
        if result.action == "warn":
            warnings: dict[str, str] = ctx.extra.setdefault(self._SLOT, {})
            warnings[self._key(tool_name, tool_args)] = result.message or ""
        return ToolAction(action="allow")

    async def after_tool_exec(
        self,
        tool_name: str,
        tool_args: dict[str, Any],
        output: str,
        ctx: MiddlewareContext,
    ) -> str:
        warnings = ctx.extra.get(self._SLOT)
        if not warnings:
            return output
        warning = warnings.pop(self._key(tool_name, tool_args), None)
        if warning:
            output += f"\n\n{warning}"
        return output
