"""Agent registry and built-in agent definitions."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from app.schemas.agent import AgentInfo, PermissionRule, Ruleset

logger = logging.getLogger(__name__)

# Prompt template directory
PROMPTS_DIR = Path(__file__).parent / "prompts"


def _load_prompt(name: str) -> str:
    """Load a prompt template file."""
    path = PROMPTS_DIR / f"{name}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


ULTRA_PROMPT = _load_prompt("ultra")


# --- Built-in agent definitions ---

BUILTIN_AGENTS: dict[str, AgentInfo] = {
    "build": AgentInfo(
        name="build",
        description="Full-featured AI assistant with all tools",
        mode="primary",
        tools=[],  # Empty = all tools (filtered by permissions)
        permissions=Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="ask", permission="bash"),
            PermissionRule(action="allow", permission="code_execute"),
            PermissionRule(action="ask", permission="write"),
            PermissionRule(action="ask", permission="edit"),
            PermissionRule(action="allow", permission="plan"),  # Can switch modes
        ]),
        system_prompt=_load_prompt("build"),
    ),
    "plan": AgentInfo(
        name="plan",
        description="Read-only analysis and planning mode",
        mode="primary",
        tools=[],
        permissions=Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="deny", permission="write"),
            PermissionRule(action="deny", permission="edit"),
            PermissionRule(action="deny", permission="apply_patch"),
            PermissionRule(action="deny", permission="artifact"),
            PermissionRule(action="deny", permission="bash"),
            PermissionRule(action="deny", permission="code_execute"),
            PermissionRule(action="allow", permission="read"),
            PermissionRule(action="allow", permission="glob"),
            PermissionRule(action="allow", permission="grep"),
            PermissionRule(action="allow", permission="plan"),   # Can switch modes
            PermissionRule(action="allow", permission="submit_plan"),  # Submit plan for review
            PermissionRule(action="allow", permission="skill"),
        ]),
        system_prompt=_load_prompt("plan"),
    ),
    "explore": AgentInfo(
        name="explore",
        description="Fast search and exploration subagent",
        mode="subagent",
        tools=["read", "glob", "grep", "search", "bash", "web_fetch", "web_search", "skill"],
        permissions=Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
            PermissionRule(action="allow", permission="read"),
            PermissionRule(action="allow", permission="glob"),
            PermissionRule(action="allow", permission="grep"),
            PermissionRule(action="allow", permission="search"),
            PermissionRule(action="allow", permission="bash"),
            PermissionRule(action="allow", permission="web_fetch"),
            PermissionRule(action="allow", permission="web_search"),
        ]),
        system_prompt=_load_prompt("explore"),
    ),
    "research": AgentInfo(
        name="research",
        description="Read-only research worker for parallel Agent swarms",
        mode="subagent",
        tools=["read", "glob", "grep", "search", "web_fetch", "web_search", "skill"],
        permissions=Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
            PermissionRule(action="allow", permission="read"),
            PermissionRule(action="allow", permission="glob"),
            PermissionRule(action="allow", permission="grep"),
            PermissionRule(action="allow", permission="search"),
            PermissionRule(action="allow", permission="web_fetch"),
            PermissionRule(action="allow", permission="web_search"),
            PermissionRule(action="allow", permission="skill"),
        ]),
        system_prompt=_load_prompt("explore"),
    ),
    "general": AgentInfo(
        name="general",
        description="General-purpose subagent with full access",
        mode="subagent",
        tools=[],
        permissions=Ruleset(rules=[
            PermissionRule(action="allow", permission="*"),
            PermissionRule(action="deny", permission="todo"),
            PermissionRule(action="ask", permission="bash"),
            PermissionRule(action="allow", permission="code_execute"),
            PermissionRule(action="ask", permission="write"),
            PermissionRule(action="ask", permission="edit"),
        ]),
        system_prompt=_load_prompt("build"),  # Reuses build prompt
    ),
    "compaction": AgentInfo(
        name="compaction",
        description="Context summarization agent (no tools)",
        mode="hidden",
        tools=[],
        permissions=Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
        ]),
        system_prompt=_load_prompt("compaction"),
    ),
    "title": AgentInfo(
        name="title",
        description="Session title generator (no tools)",
        mode="hidden",
        tools=[],
        permissions=Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
        ]),
        system_prompt=_load_prompt("title"),
        temperature=0.5,
    ),
    "summary": AgentInfo(
        name="summary",
        description="Change summary generator (no tools)",
        mode="hidden",
        tools=[],
        permissions=Ruleset(rules=[
            PermissionRule(action="deny", permission="*"),
        ]),
        system_prompt=_load_prompt("summary"),
    ),
}


class AgentRegistry:
    """Registry for agent definitions."""

    def __init__(self) -> None:
        self._agents: dict[str, AgentInfo] = dict(BUILTIN_AGENTS)

    def register(self, agent: AgentInfo) -> None:
        """Register a custom agent."""
        self._agents[agent.name] = agent

    def get(self, name: str) -> AgentInfo | None:
        """Get agent by name."""
        return self._agents.get(name)

    def default_agent(self) -> AgentInfo:
        """Return the default agent (first non-subagent, non-hidden)."""
        for agent in self._agents.values():
            if agent.mode == "primary":
                return agent
        return list(self._agents.values())[0]

    def list_agents(self, include_hidden: bool = False) -> list[AgentInfo]:
        """List all agents."""
        agents = list(self._agents.values())
        if not include_hidden:
            agents = [a for a in agents if a.mode != "hidden"]
        return agents

    def primary_agents(self) -> list[AgentInfo]:
        """List primary-mode agents."""
        return [a for a in self._agents.values() if a.mode == "primary"]

    def subagents(self) -> list[AgentInfo]:
        """List subagent-mode agents."""
        return [a for a in self._agents.values() if a.mode == "subagent"]

    def load_custom_agents(
        self,
        settings_agents: dict[str, Any] | None = None,
        project_dir: str = ".",
    ) -> None:
        """Load custom agents from settings YAML and .openyak/agents/*.md files.

        Sources (later overrides earlier):
        1. settings.agents dict from YAML config
        2. .openyak/agents/*.md Markdown files in the project directory
        """
        # 1. Load from settings.agents dict
        if settings_agents:
            for name, config in settings_agents.items():
                try:
                    agent = _agent_from_dict(name, config)
                    self.register(agent)
                    logger.info("Loaded custom agent from config: %s", name)
                except Exception:
                    logger.exception("Failed to load custom agent '%s' from config", name)

        # 2. Discover .openyak/agents/*.md files
        for agents_dir in [
            Path(project_dir) / ".openyak" / "agents",
            Path(project_dir) / ".agents",
        ]:
            if not agents_dir.is_dir():
                continue
            for md_file in sorted(agents_dir.glob("*.md")):
                try:
                    agent = _parse_agent_markdown(md_file)
                    self.register(agent)
                    logger.info("Loaded custom agent from %s: %s", md_file, agent.name)
                except Exception:
                    logger.exception("Failed to load agent from %s", md_file)


def _agent_from_dict(name: str, config: dict[str, Any]) -> AgentInfo:
    """Create an AgentInfo from a config dict (e.g. from settings.agents)."""
    permissions = Ruleset()
    if "permissions" in config:
        perm_data = config["permissions"]
        if isinstance(perm_data, dict) and "rules" in perm_data:
            permissions = Ruleset(
                rules=[PermissionRule(**r) for r in perm_data["rules"]]
            )

    metadata = config.get("metadata", {})
    metadata["custom"] = True

    return AgentInfo(
        name=name,
        description=config.get("description", f"Custom agent: {name}"),
        mode=config.get("mode", "primary"),
        tools=config.get("tools", []),
        permissions=permissions,
        system_prompt=config.get("system_prompt"),
        temperature=config.get("temperature"),
        metadata=metadata,
    )


def _parse_agent_markdown(path: Path) -> AgentInfo:
    """Parse a Markdown agent file with YAML frontmatter.

    Expected format:
        ---
        description: My agent
        mode: primary
        tools: [read, glob, grep]
        temperature: 0.3
        ---

        System prompt content here...
    """
    text = path.read_text(encoding="utf-8")
    name = path.stem  # filename without extension

    frontmatter: dict[str, Any] = {}
    body = text

    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            frontmatter = yaml.safe_load(parts[1]) or {}
            body = parts[2].strip()

    # Allow frontmatter to override the name
    name = frontmatter.pop("name", name)

    # Build permissions
    permissions = Ruleset()
    if "permissions" in frontmatter:
        perm_data = frontmatter.pop("permissions")
        if isinstance(perm_data, dict) and "rules" in perm_data:
            permissions = Ruleset(
                rules=[PermissionRule(**r) for r in perm_data["rules"]]
            )
    elif "permission" in frontmatter:
        # Shorthand alias
        perm_data = frontmatter.pop("permission")
        if isinstance(perm_data, dict) and "rules" in perm_data:
            permissions = Ruleset(
                rules=[PermissionRule(**r) for r in perm_data["rules"]]
            )

    metadata = frontmatter.get("metadata", {})
    metadata["custom"] = True

    return AgentInfo(
        name=name,
        description=frontmatter.get("description", f"Custom agent: {name}"),
        mode=frontmatter.get("mode", "primary"),
        tools=frontmatter.get("tools", []),
        permissions=permissions,
        system_prompt=body if body else None,
        temperature=frontmatter.get("temperature"),
        metadata=metadata,
    )
