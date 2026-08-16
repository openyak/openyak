"""Inherited permissions must narrow a subagent, never widen it.

A subagent is spawned with its parent's permission rules, and a session layers
those in *after* its own agent rules under last-match-wins. Anything permissive
in the inherited set therefore outranks the child's own restrictions unless the
handoff and the tool filter both keep the agent's denials on top.
"""

from __future__ import annotations

from app.agent.agent import BUILTIN_AGENTS
from app.agent.permission import (
    GLOBAL_DEFAULTS,
    agent_verdict,
    evaluate,
    merge_rulesets,
)
from app.schemas.agent import AgentInfo, PermissionRule, Ruleset


def _restrictive_agent(*, tools: list[str] | None = None) -> AgentInfo:
    """A user-defined agent that denies everything except read."""
    return AgentInfo(
        name="locked-down",
        description="",
        mode="subagent",
        tools=tools or [],
        permissions=Ruleset(
            rules=[
                PermissionRule(action="deny", permission="*"),
                PermissionRule(action="allow", permission="read"),
            ]
        ),
        system_prompt="x",
    )


def _child_merged(child: AgentInfo, inherited: Ruleset) -> Ruleset:
    """Reproduce PromptAssembler._merge_effective_permissions for a child."""
    return merge_rulesets(
        GLOBAL_DEFAULTS, child.permissions, Ruleset(), inherited, Ruleset()
    )


def _inheritable(agent: AgentInfo, *user_layers: Ruleset) -> Ruleset:
    """Reproduce PromptAssembler._merge_inheritable_permissions."""
    denials = Ruleset(
        rules=[rule for rule in agent.permissions.rules if rule.action == "deny"]
    )
    return merge_rulesets(denials, *user_layers)


def test_inherited_rules_carry_no_allow_all() -> None:
    """Neither the global defaults nor the parent persona may re-open the child.

    ``GLOBAL_DEFAULTS`` and ``build``'s own ruleset both lead with ``allow *``.
    Handing either down puts it above the child's ``deny *``.
    """
    parent = BUILTIN_AGENTS["build"]
    assert GLOBAL_DEFAULTS.rules[0] == PermissionRule(action="allow", permission="*")
    assert PermissionRule(action="allow", permission="*") in parent.permissions.rules

    inheritable = _inheritable(parent)
    assert not any(
        rule.action == "allow" and rule.permission == "*"
        for rule in inheritable.rules
    ), "no allow-all may be inherited"

    child = _restrictive_agent()
    assert evaluate("write", "*", _child_merged(child, inheritable)) == "deny"
    assert evaluate("read", "*", _child_merged(child, inheritable)) == "allow"


def test_parent_denial_still_reaches_the_child() -> None:
    """Dropping the defaults must not drop the parent's real restrictions."""
    parent = BUILTIN_AGENTS["build"]
    remembered_denial = Ruleset(
        rules=[PermissionRule(action="deny", permission="bash", pattern="*")]
    )
    inheritable = _inheritable(parent, remembered_denial)

    child = BUILTIN_AGENTS["general"]
    assert evaluate("bash", "*", _child_merged(child, inheritable)) == "deny"


def test_plan_mode_cannot_delegate_around_its_read_only_ceiling() -> None:
    """A Plan session's denials must follow the subagents it spawns."""
    plan = BUILTIN_AGENTS["plan"]
    inheritable = _inheritable(plan)
    child = BUILTIN_AGENTS["general"]
    merged = _child_merged(child, inheritable)

    for mutating in ("write", "edit", "apply_patch", "bash", "computer", "browser"):
        assert evaluate(mutating, "*", merged) == "deny", mutating
    assert evaluate("read", "*", merged) == "allow"


def test_advertised_tools_match_what_the_agent_may_call(tool_registry) -> None:
    """A restrictive agent without a tool whitelist must not be over-advertised.

    Inherited rules used to widen the advertised list, so the model was offered
    tools the agent-policy gate then refused on every call.
    """
    parent = BUILTIN_AGENTS["build"]
    inherited = merge_rulesets(parent.permissions)
    child = _restrictive_agent()

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child, extra_ruleset=_child_merged(child, inherited)
        )
    }

    assert advertised == {"read"}


def test_whitelisted_subagent_keeps_its_declared_tools(tool_registry) -> None:
    """The fix must not shrink an agent whose rules already allow its tools."""
    parent = BUILTIN_AGENTS["build"]
    inherited = merge_rulesets(parent.permissions)
    explore = BUILTIN_AGENTS["explore"]

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            explore, extra_ruleset=_child_merged(explore, inherited)
        )
    }

    assert {"read", "glob", "grep", "bash", "web_fetch", "web_search"} <= advertised
    assert "write" not in advertised
    assert "computer" not in advertised


def test_an_agent_that_declares_no_permissions_is_not_locked_out(
    tool_registry,
) -> None:
    """Saying nothing means "use the global defaults", not "deny everything".

    ``evaluate`` returns ``deny`` when no rule matches, so reading an agent's
    ruleset in isolation refuses every tool for an agent defined without a
    ``permissions`` block — the default shape of a user-defined agent in
    ``.openyak/agents/*.md``.
    """
    silent = AgentInfo(
        name="silent",
        description="",
        mode="subagent",
        tools=[],
        permissions=Ruleset(),
        system_prompt="x",
    )

    assert agent_verdict("read", "*", silent.permissions) == "allow"
    assert agent_verdict("write", "*", silent.permissions) == "ask"

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            silent, extra_ruleset=_child_merged(silent, Ruleset())
        )
    }
    assert "read" in advertised
    assert "bash" in advertised
    assert len(advertised) > 10


def test_session_denial_still_removes_an_agent_allowed_tool(tool_registry) -> None:
    """The extra ruleset keeps its veto — this is an intersection, not a swap."""
    child = _restrictive_agent()
    session_denies_read = Ruleset(
        rules=[PermissionRule(action="deny", permission="read", pattern="*")]
    )

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child, extra_ruleset=merge_rulesets(child.permissions, session_denies_read)
        )
    }

    assert advertised == set()
