"""Agent registry tests."""

from app.agent.agent import AgentRegistry, BUILTIN_AGENTS


class TestAgentRegistry:
    def test_builtin_agents_loaded(self):
        r = AgentRegistry()
        agents = r.list_agents(include_hidden=True)
        names = {a.name for a in agents}
        assert names == {
            "build",
            "plan",
            "explore",
            "research",
            "general",
            "compaction",
            "title",
            "summary",
        }

    def test_default_agent_is_build(self):
        r = AgentRegistry()
        default = r.default_agent()
        assert default.name == "build"
        assert default.mode == "primary"

    def test_get_agent(self):
        r = AgentRegistry()
        agent = r.get("explore")
        assert agent is not None
        assert agent.mode == "subagent"

    def test_get_nonexistent_returns_none(self):
        r = AgentRegistry()
        assert r.get("nonexistent") is None

    def test_hidden_agents_excluded_by_default(self):
        r = AgentRegistry()
        visible = r.list_agents(include_hidden=False)
        names = {a.name for a in visible}
        assert "compaction" not in names
        assert "title" not in names
        assert "summary" not in names
        assert "build" in names

    def test_primary_agents(self):
        r = AgentRegistry()
        primaries = r.primary_agents()
        assert all(a.mode == "primary" for a in primaries)
        assert {a.name for a in primaries} == {"build", "plan"}

    def test_subagents(self):
        r = AgentRegistry()
        subs = r.subagents()
        assert all(a.mode == "subagent" for a in subs)
        assert {a.name for a in subs} == {"explore", "research", "general"}

    def test_explore_has_restricted_tools(self):
        r = AgentRegistry()
        explore = r.get("explore")
        assert explore is not None
        assert "read" in explore.tools
        assert "write" not in explore.tools

    def test_title_has_temperature(self):
        r = AgentRegistry()
        title = r.get("title")
        assert title is not None
        assert title.temperature == 0.5

    def test_register_custom_agent(self):
        from app.schemas.agent import AgentInfo
        r = AgentRegistry()
        custom = AgentInfo(name="custom", description="test", mode="subagent")
        r.register(custom)
        assert r.get("custom") is not None
