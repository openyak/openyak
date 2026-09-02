"""Manager functions for agent API routes."""

from __future__ import annotations

from app.agent.agent import AgentRegistry
from app.errors import NotFound
from app.schemas.agent import AgentInfo


async def list_agents(
    registry: AgentRegistry,
    include_hidden: bool = False,
) -> list[AgentInfo]:
    """List registered agents, optionally including internal agents."""
    return registry.list_agents(include_hidden=include_hidden)


async def get_agent(registry: AgentRegistry, name: str) -> AgentInfo:
    """Return a registered agent by name."""
    agent = registry.get(name)
    if agent is None:
        raise NotFound(f"Agent not found: {name}")
    return agent
