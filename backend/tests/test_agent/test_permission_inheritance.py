"""Inherited permissions must narrow a subagent, never widen it.

These tests drive the real ``SessionPrompt`` merges. An earlier version of this
file reimplemented ``_merge_inheritable_permissions`` and
``_merge_effective_permissions`` as local helpers and asserted against the
copies — so the production ordering could be reverted with the suite green. A
guard that duplicates the code it guards is not a guard.
"""

from __future__ import annotations

import pytest

from app.agent.agent import AgentRegistry, BUILTIN_AGENTS
from app.agent.permission import GLOBAL_DEFAULTS, agent_verdict, evaluate, merge_rulesets
from app.schemas.agent import AgentInfo, PermissionRule, Ruleset
from app.schemas.chat import PromptRequest
from app.schemas.provider import ModelInfo
from app.session.manager import create_session
from app.session.prompt import SessionPrompt
from app.streaming.manager import GenerationJob

MUTATING = ("write", "edit", "apply_patch", "bash")


class _Provider:
    id = "test-provider"


class _ProviderRegistry:
    def __init__(self) -> None:
        self.provider = _Provider()
        self.model = ModelInfo(id="test-model", name="Test", provider_id=self.provider.id)

    def resolve_model(self, _model_id: str, _provider_id: str | None = None):
        return self.provider, self.model

    async def refresh_models(self):
        return {}


def _locked_down() -> AgentInfo:
    """A user-defined agent that denies everything except read."""
    return AgentInfo(
        name="locked-down",
        description="",
        mode="subagent",
        tools=[],
        permissions=Ruleset(
            rules=[
                PermissionRule(action="deny", permission="*"),
                PermissionRule(action="allow", permission="read"),
            ]
        ),
        system_prompt="x",
    )


async def _prompt(
    session_factory,
    tool_registry,
    *,
    session_id: str,
    agent: AgentInfo,
    permission_rules: list[dict] | None = None,
    presets: dict[str, bool] | None = None,
) -> SessionPrompt:
    """A real SessionPrompt, set up the way the production loop sets one up."""
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=session_id)

    registry = AgentRegistry()
    registry.register(agent)

    prompt = SessionPrompt(
        job=GenerationJob(stream_id=f"{session_id}-stream", session_id=session_id),
        request=PromptRequest(
            session_id=session_id,
            text="do the thing",
            model="test-model",
            agent=agent.name,
            permission_rules=permission_rules,
            permission_presets=presets,
        ),
        session_factory=session_factory,
        provider_registry=_ProviderRegistry(),
        agent_registry=registry,
        tool_registry=tool_registry,
    )
    await prompt._setup()
    return prompt


async def _handoff(
    session_factory,
    tool_registry,
    *,
    parent: AgentInfo,
    child: AgentInfo,
    presets: dict[str, bool] | None = None,
    parent_rules: list[dict] | None = None,
) -> SessionPrompt:
    """Run the real parent → child permission handoff and return the child.

    Mirrors what ``SessionProcessor`` does: it builds ``ctx.permission_rules``
    from ``sp.inheritable_permissions`` and ``task``/``swarm`` pass that to the
    child as ``request.permission_rules``.
    """
    parent_prompt = await _prompt(
        session_factory,
        tool_registry,
        session_id=f"parent-{parent.name}-{child.name}",
        agent=parent,
        presets=presets,
        permission_rules=parent_rules,
    )
    # Go through the processor, which is what actually builds the rules a
    # subagent receives — reading `inheritable_permissions` here instead would
    # leave that step untested and revertible.
    from app.session.processor import SessionProcessor

    processor = SessionProcessor(parent_prompt, [], "assistant-msg")
    inherited = list(processor._inheritable_permission_rules())
    return await _prompt(
        session_factory,
        tool_registry,
        session_id=f"child-{parent.name}-{child.name}",
        agent=child,
        permission_rules=inherited,
    )


async def test_a_parent_does_not_hand_down_an_allow_all(session_factory, tool_registry) -> None:
    """``GLOBAL_DEFAULTS`` and ``build`` both lead with ``allow *``.

    Handing either down puts it above the child's own ``deny *``.
    """
    parent = await _prompt(
        session_factory, tool_registry, session_id="p-allow-all", agent=BUILTIN_AGENTS["build"]
    )

    assert GLOBAL_DEFAULTS.rules[0] == PermissionRule(action="allow", permission="*")
    assert not any(
        rule.action == "allow" and rule.permission == "*"
        for rule in parent.inheritable_permissions.rules
    ), "no allow-all may be inherited"


async def test_a_restrictive_child_keeps_its_denials(session_factory, tool_registry) -> None:
    child = await _handoff(
        session_factory, tool_registry, parent=BUILTIN_AGENTS["build"], child=_locked_down()
    )

    assert evaluate("write", "*", child.merged_permissions) == "deny"
    assert evaluate("read", "*", child.merged_permissions) == "allow"


async def test_plan_mode_cannot_delegate_around_its_read_only_ceiling(session_factory, tool_registry) -> None:
    child = await _handoff(
        session_factory, tool_registry, parent=BUILTIN_AGENTS["plan"], child=BUILTIN_AGENTS["general"]
    )

    for mutating in (*MUTATING, "computer", "browser"):
        assert evaluate(mutating, "*", child.merged_permissions) == "deny", mutating
    assert evaluate("read", "*", child.merged_permissions) == "allow"


async def test_an_auto_preset_cannot_reopen_an_inherited_denial(session_factory, tool_registry) -> None:
    """The ceiling must outrank the user layers travelling with it.

    An Auto preset emits broad ``allow`` rules. Ordered before the parent's
    denials, they win under last-match-wins — so Plan mode would delegate its
    way to a writable subagent for every user not on the Ask preset.
    """
    child = await _handoff(
        session_factory,
        tool_registry,
        parent=BUILTIN_AGENTS["plan"],
        child=BUILTIN_AGENTS["general"],
        presets={"file_changes": True, "run_commands": True},
    )

    for mutating in MUTATING:
        assert evaluate(mutating, "*", child.merged_permissions) == "deny", mutating


async def test_a_deny_all_parent_does_not_zero_out_its_child(
    session_factory, tool_registry
) -> None:
    """The ceiling is the parent's *verdict* per tool, not its literal rules.

    Every restrictive agent here is written as ``deny *`` plus an allow-list.
    Copying only the ``deny`` rules keeps the ``deny *`` and drops everything
    that re-opens it, handing the child a ceiling that forbids every tool.
    """
    parent = _locked_down()  # deny * + allow read
    child = await _handoff(
        session_factory, tool_registry, parent=parent, child=BUILTIN_AGENTS["general"]
    )

    assert evaluate("read", "*", child.merged_permissions) != "deny", (
        "the parent allows read, so the child must keep it"
    )
    assert evaluate("write", "*", child.merged_permissions) == "deny"

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child.agent, extra_ruleset=child.merged_permissions
        )
    }
    assert advertised, "a restrictive parent must not leave the child with no tools"
    assert "read" in advertised


async def test_an_explore_parent_keeps_its_allow_list_for_the_child(
    session_factory, tool_registry
) -> None:
    """Same shape, using a built-in: explore is ``deny *`` + seven allows."""
    child = await _handoff(
        session_factory,
        tool_registry,
        parent=BUILTIN_AGENTS["explore"],
        child=BUILTIN_AGENTS["general"],
    )

    for allowed in ("read", "grep", "web_fetch"):
        assert evaluate(allowed, "*", child.merged_permissions) != "deny", allowed
    assert evaluate("write", "*", child.merged_permissions) == "deny"


async def test_a_parent_denial_still_reaches_the_child(session_factory, tool_registry) -> None:
    """Narrowing must survive the handoff, not just widening be blocked."""
    child = await _handoff(
        session_factory,
        tool_registry,
        parent=BUILTIN_AGENTS["build"],
        child=BUILTIN_AGENTS["general"],
        parent_rules=[{"action": "deny", "permission": "bash", "pattern": "*"}],
    )

    assert evaluate("bash", "*", child.merged_permissions) == "deny"


async def test_a_permissive_parent_does_not_widen_a_strict_child(
    session_factory, tool_registry
) -> None:
    """End to end: the advertised tool list matches what the child may call."""
    child = await _handoff(
        session_factory,
        tool_registry,
        parent=BUILTIN_AGENTS["build"],
        child=_locked_down(),
        presets={"file_changes": True, "run_commands": True},
    )

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child.agent, extra_ruleset=child.merged_permissions
        )
    }
    assert advertised == {"read"}


async def test_a_whitelisted_subagent_keeps_its_declared_tools(
    session_factory, tool_registry
) -> None:
    """The narrowing must not shrink an agent whose rules already allow its tools."""
    child = await _handoff(
        session_factory,
        tool_registry,
        parent=BUILTIN_AGENTS["build"],
        child=BUILTIN_AGENTS["explore"],
    )

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child.agent, extra_ruleset=child.merged_permissions
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
        name="silent", description="", mode="subagent", tools=[],
        permissions=Ruleset(), system_prompt="x",
    )

    assert agent_verdict("read", "*", silent.permissions) == "allow"
    assert agent_verdict("write", "*", silent.permissions) == "ask"

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            silent, extra_ruleset=merge_rulesets(GLOBAL_DEFAULTS, silent.permissions)
        )
    }
    assert {"read", "bash"} <= advertised


def test_a_session_denial_still_removes_an_agent_allowed_tool(tool_registry) -> None:
    """The extra ruleset keeps its veto — this is an intersection, not a swap."""
    child = _locked_down()
    denies_read = Ruleset(
        rules=[PermissionRule(action="deny", permission="read", pattern="*")]
    )

    advertised = {
        tool.id
        for tool in tool_registry.resolve_for_agent(
            child, extra_ruleset=merge_rulesets(child.permissions, denies_read)
        )
    }
    assert advertised == set()


async def test_a_remembered_denial_propagates_to_subagents(session_factory, tool_registry) -> None:
    """``_remember_permission_rule`` must reach ``inheritable_permissions``.

    A non-interactive child cannot prompt, so an inherited ``ask`` executes
    where the user already said no.
    """
    from app.session.processor import _remember_permission_rule

    prompt = await _prompt(
        session_factory, tool_registry, session_id="remember-denial", agent=BUILTIN_AGENTS["build"]
    )
    await _remember_permission_rule(
        session_factory, "remember-denial", prompt,
        permission="bash", pattern="*", allow=False,
    )

    assert evaluate("bash", "*", prompt.inheritable_permissions) == "deny"


@pytest.mark.parametrize("agent_name", ["explore", "research", "compaction"])
def test_builtin_restrictive_agents_declare_a_real_ceiling(agent_name: str) -> None:
    """These agents' ``deny *`` is the thing the handoff must preserve."""
    agent = BUILTIN_AGENTS[agent_name]
    assert PermissionRule(action="deny", permission="*") in agent.permissions.rules
