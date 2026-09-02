"""Agent listing endpoints wired through the Route Module."""

from __future__ import annotations

from app.agent.manager import get_agent, list_agents
from app.api._route import Route
from app.schemas.agent import AgentInfo

route = Route(tags=["agents"])

route.list(
    "/agents",
    manager=list_agents,
    response_model=list[AgentInfo],
)

route.get(
    "/agents/{name}",
    manager=get_agent,
    response_model=AgentInfo,
)

router = route.api_router
