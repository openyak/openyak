"""Tests for agent listing API endpoints."""

from __future__ import annotations

import pytest

from app.schemas.agent import AgentInfo

pytestmark = pytest.mark.asyncio


def _agent(name: str, mode: str = "primary") -> AgentInfo:
    return AgentInfo(name=name, description=f"{name} agent", mode=mode)


async def test_list_agents_preserves_include_hidden_query(app_client):
    registry = app_client.app.state.agent_registry
    registry.list_agents.return_value = [_agent("build"), _agent("internal", "hidden")]

    response = await app_client.get("/api/agents", params={"include_hidden": "true"})

    assert response.status_code == 200
    assert [agent["name"] for agent in response.json()] == ["build", "internal"]
    registry.list_agents.assert_called_once_with(include_hidden=True)


async def test_get_agent(app_client):
    registry = app_client.app.state.agent_registry
    registry.get.return_value = _agent("build")

    response = await app_client.get("/api/agents/build")

    assert response.status_code == 200
    assert response.json()["name"] == "build"
    registry.get.assert_called_once_with("build")


async def test_get_agent_not_found_uses_domain_error_contract(app_client):
    registry = app_client.app.state.agent_registry
    registry.get.return_value = None

    response = await app_client.get("/api/agents/missing")

    assert response.status_code == 404
    assert response.json() == {
        "detail": "Agent not found: missing",
        "code": "not_found",
    }
