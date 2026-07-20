"""Permission engine tests — including two-dimensional matching."""

from app.agent.permission import (
    GLOBAL_DEFAULTS,
    RejectedError,
    disabled_tools,
    evaluate,
    merge_rulesets,
    parse_session_permissions,
)
from app.schemas.agent import PermissionRule, Ruleset


class TestEvaluate:
    def test_wildcard_allow(self):
        rs = Ruleset(rules=[PermissionRule(action="allow", permission="*")])
        assert evaluate("read", "*", rs) == "allow"
        assert evaluate("bash", "*", rs) == "allow"

    def test_wildcard_deny(self):
        rs = Ruleset(rules=[PermissionRule(action="deny", permission="*")])
        assert evaluate("read", "*", rs) == "deny"

    def test_last_match_wins(self):
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="deny", permission="bash"),
        ])
        assert evaluate("read", "*", rs) == "allow"
        assert evaluate("bash", "*", rs) == "deny"

    def test_ask_permission(self):
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="write"),
        ])
        assert evaluate("read", "*", rs) == "allow"
        assert evaluate("write", "*", rs) == "ask"

    def test_glob_prefix(self):
        rs = Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
            PermissionRule(action="allow", permission="read*"),
        ])
        assert evaluate("read", "*", rs) == "allow"
        assert evaluate("write", "*", rs) == "deny"

    def test_no_match_defaults_deny(self):
        rs = Ruleset(rules=[])
        assert evaluate("anything", "*", rs) == "deny"

    def test_command_scoped_bash_rule(self):
        # The processor passes the bash command as the resource, so a
        # remembered "git *" rule covers the git family and nothing else.
        rs = merge_rulesets(
            GLOBAL_DEFAULTS,
            Ruleset(rules=[
                PermissionRule(action="allow", permission="bash", pattern="git *"),
            ]),
        )
        assert evaluate("bash", "git push origin main", rs) == "allow"
        assert evaluate("bash", "git status", rs) == "allow"
        assert evaluate("bash", "rm -rf build", rs) == "ask"
        # A remembered exact command matches only itself.
        rs_exact = merge_rulesets(
            GLOBAL_DEFAULTS,
            Ruleset(rules=[
                PermissionRule(action="allow", permission="bash", pattern="npm run preflight:ui"),
            ]),
        )
        assert evaluate("bash", "npm run preflight:ui", rs_exact) == "allow"
        assert evaluate("bash", "npm run deploy", rs_exact) == "ask"

    def test_exact_match(self):
        rs = Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
            PermissionRule(action="allow", permission="grep"),
        ])
        assert evaluate("grep", "*", rs) == "allow"
        assert evaluate("glob", "*", rs) == "deny"


class TestTwoDimensionalMatching:
    """Tests for the two-dimensional (tool + resource) permission matching."""

    def test_env_file_ask(self):
        """Reading .env files should require asking."""
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="read", pattern="*.env"),
        ])
        assert evaluate("read", "/tmp/test.py", rs) == "allow"
        assert evaluate("read", "/project/.env", rs) == "ask"
        assert evaluate("read", "config.env", rs) == "ask"

    def test_env_example_allowed(self):
        """Reading .env.example should be allowed even when .env.* is ask."""
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="read", pattern="*.env"),
            PermissionRule(action="ask", permission="read", pattern="*.env.*"),
            PermissionRule(action="allow", permission="read", pattern="*.env.example"),
        ])
        assert evaluate("read", ".env", rs) == "ask"
        assert evaluate("read", ".env.local", rs) == "ask"
        assert evaluate("read", ".env.example", rs) == "allow"

    def test_resource_pattern_only_affects_specified_tool(self):
        """Resource pattern on 'read' shouldn't affect 'write'."""
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="read", pattern="*.env"),
        ])
        assert evaluate("write", ".env", rs) == "allow"  # Write not affected
        assert evaluate("read", ".env", rs) == "ask"

    def test_directory_pattern(self):
        """Deny write to specific directory."""
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="deny", permission="write", pattern="/etc/*"),
        ])
        assert evaluate("write", "/etc/passwd", rs) == "deny"
        assert evaluate("write", "/home/user/test.txt", rs) == "allow"

    def test_wildcard_resource_matches_all(self):
        """Default pattern='*' matches all resources."""
        rs = Ruleset(rules=[
            PermissionRule(action="deny", permission="bash"),
        ])
        assert evaluate("bash", "*", rs) == "deny"
        assert evaluate("bash", "/any/path", rs) == "deny"
        assert evaluate("bash", "anything", rs) == "deny"


class TestMergeRulesets:
    def test_merge_order(self):
        base = Ruleset(rules=[PermissionRule(action="allow", permission="*")])
        override = Ruleset(rules=[PermissionRule(action="deny", permission="bash")])
        merged = merge_rulesets(base, override)
        assert evaluate("read", "*", merged) == "allow"
        assert evaluate("bash", "*", merged) == "deny"

    def test_later_layer_overrides(self):
        layer1 = Ruleset(rules=[PermissionRule(action="deny", permission="bash")])
        layer2 = Ruleset(rules=[PermissionRule(action="allow", permission="bash")])
        merged = merge_rulesets(layer1, layer2)
        assert evaluate("bash", "*", merged) == "allow"

    def test_three_layers(self):
        defaults = Ruleset(rules=[PermissionRule(action="allow", permission="*")])
        agent = Ruleset(rules=[PermissionRule(action="deny", permission="write")])
        session = Ruleset(rules=[PermissionRule(action="allow", permission="write")])
        merged = merge_rulesets(defaults, agent, session)
        assert evaluate("write", "*", merged) == "allow"

    def test_session_overrides_agent_for_resource(self):
        """Session can override agent-level env restriction."""
        agent = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="read", pattern="*.env"),
        ])
        session = Ruleset(rules=[
            PermissionRule(action="allow", permission="read", pattern="*.env"),
        ])
        merged = merge_rulesets(agent, session)
        assert evaluate("read", ".env", merged) == "allow"


class TestDisabledTools:
    def test_finds_denied(self):
        rs = Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="deny", permission="bash"),
            PermissionRule(action="deny", permission="write"),
        ])
        denied = disabled_tools(["read", "write", "bash", "grep"], rs)
        assert denied == {"bash", "write"}

    def test_all_allowed(self):
        rs = Ruleset(rules=[PermissionRule(action="allow", permission="*")])
        denied = disabled_tools(["read", "write", "bash"], rs)
        assert denied == set()


class TestGlobalDefaults:
    def test_defaults_allow_read(self):
        assert evaluate("read", "*", GLOBAL_DEFAULTS) == "allow"
        assert evaluate("glob", "*", GLOBAL_DEFAULTS) == "allow"
        assert evaluate("grep", "*", GLOBAL_DEFAULTS) == "allow"

    def test_defaults_ask_bash(self):
        assert evaluate("bash", "*", GLOBAL_DEFAULTS) == "ask"

    def test_defaults_ask_write(self):
        assert evaluate("write", "*", GLOBAL_DEFAULTS) == "ask"

    def test_defaults_deny_question(self):
        assert evaluate("question", "*", GLOBAL_DEFAULTS) == "deny"

    def test_defaults_deny_plan_tool(self):
        assert evaluate("plan", "*", GLOBAL_DEFAULTS) == "deny"

    def test_defaults_ask_env_files(self):
        assert evaluate("read", "/project/.env", GLOBAL_DEFAULTS) == "ask"
        assert evaluate("read", ".env.local", GLOBAL_DEFAULTS) == "ask"
        assert evaluate("read", ".env.example", GLOBAL_DEFAULTS) == "allow"


class TestParseSessionPermissions:
    def test_empty_returns_empty(self):
        rs = parse_session_permissions(None)
        assert rs.rules == []

    def test_empty_list_returns_empty(self):
        rs = parse_session_permissions([])
        assert rs.rules == []

    def test_valid_rules(self):
        data = [
            {"action": "allow", "permission": "bash"},
            {"action": "deny", "permission": "write", "pattern": "*.env"},
        ]
        rs = parse_session_permissions(data)
        assert len(rs.rules) == 2
        assert rs.rules[0].action == "allow"
        assert rs.rules[0].permission == "bash"
        assert rs.rules[1].pattern == "*.env"

    def test_malformed_skipped(self):
        data = [
            {"action": "invalid_action"},  # Invalid action
            {"action": "allow", "permission": "read"},
        ]
        rs = parse_session_permissions(data)
        # The invalid one should be skipped
        assert len(rs.rules) == 1
        assert rs.rules[0].permission == "read"
