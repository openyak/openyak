"""Swarm Tool — bounded parallel child-Agent fork/join."""

from __future__ import annotations

from typing import Any

from app.agent.swarm import SwarmCoordinator, SwarmRunContext, SwarmTaskSpec
from app.config import get_settings
from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext


class SwarmTool(ToolDefinition):
    @property
    def id(self) -> str:
        return "swarm"

    @property
    def description(self) -> str:
        return (
            "Delegate 2 or more independent assignments to a bounded Agent swarm. "
            "Read-only research Agents run in parallel; Agents that can mutate the "
            "Workspace are serialized to prevent write conflicts. Use this in Ultra "
            "execution mode for complex work that benefits from independent research, "
            "review, or disjoint analysis, then synthesize the returned results."
        )

    @property
    def execution_timeout(self) -> float:
        # Mutation-capable members may serialize, so the outer Tool budget
        # must cover the worst-case join rather than only one child.
        settings = get_settings()
        return float(
            settings.swarm_timeout * settings.swarm_max_agents + 30
        )

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": (
                        "Independent child-Agent assignments. Prefer 2-4 focused tasks."
                    ),
                    "minItems": 2,
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "Short assignment title (3-8 words)",
                            },
                            "prompt": {
                                "type": "string",
                                "description": (
                                    "Self-contained instructions, expected result, and scope"
                                ),
                            },
                            "agent": {
                                "type": "string",
                                "description": (
                                    "Subagent name. Use 'research' for parallel read-only "
                                    "work; use 'general' only when mutation is necessary."
                                ),
                                "default": "research",
                            },
                        },
                        "required": ["title", "prompt"],
                    },
                },
            },
            "required": ["tasks"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        if ctx.execution_mode != "ultra":
            return ToolResult(
                error="Swarm is only available in Ultra execution mode"
            )

        settings = get_settings()
        raw_tasks = args.get("tasks")
        if not isinstance(raw_tasks, list):
            return ToolResult(error="Swarm tasks must be an array")
        if len(raw_tasks) < 2:
            return ToolResult(error="A Swarm requires at least 2 child Agent tasks")
        if len(raw_tasks) > settings.swarm_max_agents:
            return ToolResult(
                error=(
                    f"A Swarm supports at most {settings.swarm_max_agents} child Agents"
                )
            )
        if ctx.depth >= settings.subtask_max_depth:
            return ToolResult(
                error=(
                    f"Maximum Agent nesting depth "
                    f"({settings.subtask_max_depth}) exceeded"
                )
            )

        app_state = ctx.app_state or getattr(ctx, "_app_state", None)
        parent_job = ctx.job or getattr(ctx, "_job", None)
        if not app_state or parent_job is None:
            return ToolResult(error="Swarm is unavailable: missing Agent runtime scope")

        agent_registry = app_state["agent_registry"]
        specs: list[SwarmTaskSpec] = []
        for index, raw in enumerate(raw_tasks):
            if not isinstance(raw, dict):
                return ToolResult(error=f"Swarm task {index + 1} must be an object")
            title = str(raw.get("title") or "").strip()
            prompt = str(raw.get("prompt") or "").strip()
            agent_name = str(raw.get("agent") or "research").strip()
            if not title or not prompt:
                return ToolResult(
                    error=f"Swarm task {index + 1} requires a title and prompt"
                )
            agent = agent_registry.get(agent_name)
            if agent is None or agent.mode != "subagent":
                return ToolResult(
                    error=f"Swarm task {index + 1} has unknown subagent: {agent_name}"
                )
            specs.append(
                SwarmTaskSpec(title=title, prompt=prompt, agent=agent_name)
            )

        total_limit = settings.swarm_max_total_agents_per_generation
        if not parent_job.reserve_swarm_agents(len(specs), total_limit):
            return ToolResult(
                error=(
                    "Ultra total child Agent budget exceeded: "
                    f"at most {total_limit} child Agents may be reserved "
                    "during one parent generation"
                )
            )

        coordinator = SwarmCoordinator(
            session_factory=app_state["session_factory"],
            provider_registry=app_state["provider_registry"],
            agent_registry=agent_registry,
            tool_registry=app_state["tool_registry"],
            index_manager=ctx.index_manager,
            stream_manager=app_state.get("stream_manager"),
        )
        outcome = await coordinator.run(
            specs,
            SwarmRunContext(
                parent_job=parent_job,
                parent_message_id=ctx.message_id,
                workspace=ctx.workspace,
                model_id=ctx.model_id or getattr(ctx, "_model_id", None),
                provider_id=ctx.provider_id,
                depth=ctx.depth or getattr(ctx, "_depth", 0),
                permission_rules=ctx.permission_rules,
                reasoning=ctx.reasoning,
                max_concurrency=settings.swarm_max_concurrency,
                timeout_seconds=float(settings.swarm_timeout),
            ),
        )
        return ToolResult(
            output=outcome.output,
            title=f"Agent swarm · {outcome.status}",
            metadata=outcome.metadata(),
        )
