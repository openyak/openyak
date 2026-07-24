"""Plan tool tests — unified enter/exit agent switching."""

import pytest

from app.schemas.agent import AgentInfo
from app.tool.builtin.plan import PlanTool
from app.tool.context import ToolContext


def _make_ctx(agent_name: str = "build") -> ToolContext:
    return ToolContext(
        session_id="test-session",
        message_id="test-msg",
        agent=AgentInfo(name=agent_name, description="", mode="primary"),
        call_id="test-call",
    )


class TestPlanTool:
    def test_tool_id(self):
        tool = PlanTool()
        assert tool.id == "plan"

    @pytest.mark.asyncio
    async def test_enter_returns_switch_metadata(self):
        tool = PlanTool()
        result = await tool.execute({"command": "enter"}, _make_ctx("build"))
        assert result.metadata is not None
        assert result.metadata["switch_agent"] == "plan"
        assert result.output is not None
        assert "plan mode" in result.output.lower()

    @pytest.mark.asyncio
    async def test_exit_returns_switch_metadata(self):
        tool = PlanTool()
        result = await tool.execute({"command": "exit"}, _make_ctx("plan"))
        assert result.metadata is not None
        assert result.metadata["switch_agent"] == "build"
        assert result.output is not None
        assert "build mode" in result.output.lower()

    @pytest.mark.asyncio
    async def test_enter_while_in_plan_fails(self):
        tool = PlanTool()
        result = await tool.execute({"command": "enter"}, _make_ctx("plan"))
        assert not result.success
        assert "already" in result.error.lower()

    @pytest.mark.asyncio
    async def test_exit_while_not_in_plan_fails(self):
        tool = PlanTool()
        result = await tool.execute({"command": "exit"}, _make_ctx("build"))
        assert not result.success
        assert "not in plan" in result.error.lower()

    def test_has_command_parameter(self):
        tool = PlanTool()
        schema = tool.parameters_schema()
        assert "command" in schema["properties"]
        assert schema["properties"]["command"]["enum"] == ["enter", "exit"]
        assert "command" in schema["required"]


class TestPlanPermissions:
    """Test that plan tool is properly gated by agent permissions."""

    def test_build_agent_can_use_plan(self):
        from app.agent.agent import BUILTIN_AGENTS
        from app.agent.permission import GLOBAL_DEFAULTS, evaluate, merge_rulesets

        build = BUILTIN_AGENTS["build"]
        merged = merge_rulesets(GLOBAL_DEFAULTS, build.permissions)
        assert evaluate("plan", "*", merged) == "allow"

    def test_plan_agent_can_use_plan(self):
        from app.agent.agent import BUILTIN_AGENTS
        from app.agent.permission import GLOBAL_DEFAULTS, evaluate, merge_rulesets

        plan = BUILTIN_AGENTS["plan"]
        merged = merge_rulesets(GLOBAL_DEFAULTS, plan.permissions)
        assert evaluate("plan", "*", merged) == "allow"

    def test_plan_agent_denies_write(self):
        from app.agent.agent import BUILTIN_AGENTS
        from app.agent.permission import GLOBAL_DEFAULTS, evaluate, merge_rulesets

        plan = BUILTIN_AGENTS["plan"]
        merged = merge_rulesets(GLOBAL_DEFAULTS, plan.permissions)
        for permission in (
            "write",
            "edit",
            "apply_patch",
            "artifact",
            "bash",
            "code_execute",
        ):
            assert evaluate(permission, "*", merged) == "deny"

    def test_plan_agent_allows_read(self):
        from app.agent.agent import BUILTIN_AGENTS
        from app.agent.permission import GLOBAL_DEFAULTS, evaluate, merge_rulesets

        plan = BUILTIN_AGENTS["plan"]
        merged = merge_rulesets(GLOBAL_DEFAULTS, plan.permissions)
        assert evaluate("read", "*", merged) == "allow"
        assert evaluate("glob", "*", merged) == "allow"
        assert evaluate("grep", "*", merged) == "allow"
