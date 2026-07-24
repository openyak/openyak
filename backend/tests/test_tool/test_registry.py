"""Tool registry tests."""

import pytest

from app.agent.agent import AgentRegistry
from app.main import _register_builtin_tools
from app.schemas.agent import AgentInfo, PermissionRule, Ruleset
from app.tool.registry import ToolRegistry


class TestToolRegistry:
    @pytest.fixture
    def registry(self) -> ToolRegistry:
        tr = ToolRegistry()
        _register_builtin_tools(tr)
        return tr

    def test_all_builtin_tools_registered(self, registry: ToolRegistry):
        tool_ids = {t.id for t in registry.all_tools()}
        expected = {"read", "write", "edit", "apply_patch", "bash", "code_execute",
                    "glob", "grep", "question", "todo", "task", "swarm",
                    "web_fetch", "web_search", "invalid",
                    "plan", "submit_plan", "artifact", "present_file", "skill"}
        assert tool_ids == expected

    def test_get_by_id(self, registry: ToolRegistry):
        assert registry.get("read") is not None
        assert registry.get("nonexistent") is None

    def test_resolve_for_build_agent(self, registry: ToolRegistry):
        ar = AgentRegistry()
        build = ar.get("build")
        tools = registry.resolve_for_agent(build)
        tool_ids = {t.id for t in tools}
        # Build agent has allow *, ask bash/write/edit — none denied
        assert "read" in tool_ids
        assert "bash" in tool_ids  # ask != deny

    def test_resolve_for_explore_agent(self, registry: ToolRegistry):
        ar = AgentRegistry()
        explore = ar.get("explore")
        tools = registry.resolve_for_agent(explore)
        tool_ids = {t.id for t in tools}
        # Explore whitelists: read, glob, grep, bash, web_fetch, web_search
        assert "read" in tool_ids
        assert "glob" in tool_ids
        assert "grep" in tool_ids
        assert "write" not in tool_ids
        assert "edit" not in tool_ids
        assert "todo" not in tool_ids

    def test_resolve_for_compaction_agent(self, registry: ToolRegistry):
        ar = AgentRegistry()
        compaction = ar.get("compaction")
        tools = registry.resolve_for_agent(compaction)
        # Compaction denies all tools
        assert len(tools) == 0

    def test_openai_specs(self, registry: ToolRegistry):
        ar = AgentRegistry()
        build = ar.get("build")
        specs = registry.to_openai_specs(build)
        assert len(specs) > 0
        # Each spec should have the OpenAI function format
        for spec in specs:
            assert spec["type"] == "function"
            assert "name" in spec["function"]
            assert "parameters" in spec["function"]
