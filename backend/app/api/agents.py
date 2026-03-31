"""Agent listing endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.dependencies import AgentRegistryDep
from app.schemas.agent import AgentInfo

router = APIRouter()


@router.get("/agents", response_model=list[AgentInfo])
async def list_agents(registry: AgentRegistryDep, include_hidden: bool = False) -> list[AgentInfo]:
    """List all registered agents."""
    return registry.list_agents(include_hidden=include_hidden)


@router.get("/agents/{name}", response_model=AgentInfo)
async def get_agent(registry: AgentRegistryDep, name: str) -> AgentInfo:
    """Get agent details by name."""
    agent = registry.get(name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent not found: {name}")
    return agent
