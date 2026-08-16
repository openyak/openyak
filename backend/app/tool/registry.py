"""Tool registry — manages tool instances and per-agent filtering."""

from __future__ import annotations

import logging
from typing import Any

from app.agent.permission import agent_verdict, evaluate, merge_rulesets
from app.schemas.agent import AgentInfo, Ruleset
from app.tool.base import ToolDefinition

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Central registry for all tool definitions."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, tool: ToolDefinition) -> None:
        """Register a tool."""
        self._tools[tool.id] = tool
        logger.debug("Registered tool: %s", tool.id)

    def unregister(self, tool_id: str) -> None:
        """Remove a tool by ID."""
        self._tools.pop(tool_id, None)

    def get(self, tool_id: str) -> ToolDefinition | None:
        """Get a tool by ID."""
        return self._tools.get(tool_id)

    def all_tools(self) -> list[ToolDefinition]:
        """List all registered tools."""
        return list(self._tools.values())

    def resolve_for_agent(
        self,
        agent: AgentInfo,
        *,
        extra_ruleset: Ruleset | None = None,
        exclude: set[str] | None = None,
    ) -> list[ToolDefinition]:
        """Get tools available to an agent, filtered by permissions.

        If agent.tools is non-empty, only those tools are considered.
        Then permission rules further filter the set.
        ``exclude`` silently removes tools (e.g. quota-exceeded tools).
        """
        # Start with agent's tool whitelist or all tools
        if agent.tools:
            candidates = [
                self._tools[tid]
                for tid in agent.tools
                if tid in self._tools
            ]
        else:
            candidates = list(self._tools.values())

        # Filter by permissions. The agent's own ruleset and the session's
        # merged ruleset each get a veto — inherited rules narrow what an agent
        # may do, never widen it. Merging them into one list instead would let
        # a later layer outrank the agent: a subagent inherits its parent's
        # rules, and those start with the global ``allow *``, which would
        # otherwise reopen everything a restrictive agent denies. This mirrors
        # the agent-policy gate in ``SessionProcessor`` so the tools advertised
        # to the model are exactly the ones it is allowed to call.
        result = [
            tool for tool in candidates
            if agent_verdict(tool.id, "*", agent.permissions) != "deny"
            and (
                extra_ruleset is None
                or evaluate(tool.id, "*", merge_rulesets(agent.permissions, extra_ruleset))
                != "deny"
            )
        ]

        if exclude:
            result = [t for t in result if t.id not in exclude]

        return result

    def to_openai_specs(
        self,
        agent: AgentInfo,
        *,
        extra_ruleset: Ruleset | None = None,
        exclude: set[str] | None = None,
        discovered: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Get OpenAI function specs for tools available to an agent.

        When *discovered* is provided (not None), MCP tools are deferred:
        only those whose id is in *discovered* are included.  Non-MCP tools
        (builtins, skill, tool_search) are always included.  When *discovered*
        is None the behaviour is unchanged — all tools are included.
        """
        tools = self.resolve_for_agent(agent, extra_ruleset=extra_ruleset, exclude=exclude)
        if discovered is not None:
            from app.mcp.tool_wrapper import McpToolWrapper

            tools = [
                t for t in tools
                if not isinstance(t, McpToolWrapper) or t.id in discovered
            ]
        return [tool.to_openai_spec() for tool in tools]
