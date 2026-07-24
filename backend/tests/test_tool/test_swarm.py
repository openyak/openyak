"""Swarm Tool boundary tests."""

from types import SimpleNamespace

import pytest

from app.agent.agent import AgentRegistry
from app.agent.swarm import SwarmCoordinator
from app.config import get_settings
from app.schemas.agent import AgentInfo
from app.streaming.manager import GenerationJob
from app.tool.builtin.swarm import SwarmTool
from app.tool.context import ToolContext
from app.tool.registry import ToolRegistry


def _context(*, execution_mode: str = "standard") -> ToolContext:
    return ToolContext(
        session_id="parent-session",
        message_id="parent-message",
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="swarm-call",
        execution_mode=execution_mode,
    )


@pytest.mark.asyncio
async def test_swarm_cannot_execute_outside_ultra_mode() -> None:
    result = await SwarmTool().execute(
        {
            "tasks": [
                {"title": "One", "prompt": "Inspect one"},
                {"title": "Two", "prompt": "Inspect two"},
            ]
        },
        _context(),
    )

    assert result.error == "Swarm is only available in Ultra execution mode"


@pytest.mark.asyncio
async def test_ultra_mode_reaches_runtime_scope_validation() -> None:
    result = await SwarmTool().execute(
        {
            "tasks": [
                {"title": "One", "prompt": "Inspect one"},
                {"title": "Two", "prompt": "Inspect two"},
            ]
        },
        _context(execution_mode="ultra"),
    )

    assert result.error == "Swarm is unavailable: missing Agent runtime scope"


def test_tool_timeout_covers_worst_case_serial_join() -> None:
    settings = get_settings()
    assert SwarmTool().execution_timeout >= (
        settings.swarm_timeout * settings.swarm_max_agents
    )


@pytest.mark.asyncio
async def test_swarm_enforces_total_child_budget_per_parent_generation(
    monkeypatch,
) -> None:
    async def fake_run(self, specs, context):
        del self, context
        return SimpleNamespace(
            output="ok",
            status="completed",
            metadata=lambda: {"members": len(specs)},
        )

    monkeypatch.setattr(SwarmCoordinator, "run", fake_run)
    ctx = _context(execution_mode="ultra")
    ctx.job = GenerationJob("parent-stream", "parent-session")
    ctx.app_state = {
        "session_factory": object(),
        "provider_registry": object(),
        "agent_registry": AgentRegistry(),
        "tool_registry": ToolRegistry(),
    }
    tool = SwarmTool()

    first = await tool.execute(
        {
            "tasks": [
                {"title": "One", "prompt": "Inspect one"},
                {"title": "Two", "prompt": "Inspect two"},
            ]
        },
        ctx,
    )
    bypass_attempt = await tool.execute(
        {
            "tasks": [
                {"title": "Three", "prompt": "Different prompt three"},
                {"title": "Four", "prompt": "Different prompt four"},
                {"title": "Five", "prompt": "Different prompt five"},
            ]
        },
        ctx,
    )

    assert first.error is None
    assert bypass_attempt.error is not None
    assert "total child Agent budget" in bypass_attempt.error
