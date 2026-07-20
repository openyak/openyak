"""Permission evaluation engine.

Implements OpenCode's 4-layer permission model:
  Global defaults → Agent-level → User config → Session-level

Each layer is a Ruleset (ordered list of PermissionRules).
Rules are evaluated in order; last match wins.

Two-dimensional matching (matches OpenCode's permission/next.ts):
  - permission dimension: matches tool/capability name
  - pattern dimension: matches resource (file path, etc.)
"""

from __future__ import annotations

import fnmatch

from app.schemas.agent import PermissionRule, Ruleset


class RejectedError(Exception):
    """Raised when a tool call is denied by the permission engine."""

    def __init__(self, permission: str, pattern: str = "*"):
        self.permission = permission
        self.pattern = pattern
        super().__init__(f"Permission denied: {permission} (pattern: {pattern})")


def evaluate(permission: str, pattern: str, ruleset: Ruleset) -> str:
    """Evaluate a permission against a ruleset with two-dimensional matching.

    Args:
        permission: tool/capability name (e.g., "read", "bash")
        pattern: resource being accessed (e.g., file path, "*" for generic)
        ruleset: merged permission ruleset

    Returns 'allow', 'deny', or 'ask'. Last matching rule wins.
    """
    result = "deny"
    for rule in ruleset.rules:
        if _glob_match(permission, rule.permission) and _glob_match(pattern, rule.pattern):
            result = rule.action
    return result


def merge_rulesets(*rulesets: Ruleset) -> Ruleset:
    """Merge multiple rulesets in priority order (last wins).

    Layers: defaults → agent → user → session
    """
    merged_rules: list[PermissionRule] = []
    for rs in rulesets:
        merged_rules.extend(rs.rules)
    return Ruleset(rules=merged_rules)


def disabled_tools(tool_names: list[str], ruleset: Ruleset) -> set[str]:
    """Return set of tool names that are denied by the ruleset.

    Checks with pattern="*" (generic resource).
    """
    denied = set()
    for name in tool_names:
        action = evaluate(name, "*", ruleset)
        if action == "deny":
            denied.add(name)
    return denied


def parse_session_permissions(permission_data: list[dict] | None) -> Ruleset:
    """Parse session-level permission JSON into a Ruleset.

    Session.permission stores:
      [{"action": "allow", "permission": "bash", "pattern": "*"}, ...]
    """
    if not permission_data:
        return Ruleset()
    rules = []
    for item in permission_data:
        try:
            rules.append(PermissionRule(
                action=item.get("action", "deny"),
                permission=item.get("permission", "*"),
                pattern=item.get("pattern", "*"),
            ))
        except (ValueError, KeyError):
            continue  # Skip malformed rules
    return Ruleset(rules=rules)


def presets_to_ruleset(presets: dict[str, bool] | None) -> Ruleset:
    """Convert frontend permission presets into a Ruleset.

    Preset keys:
      - file_changes  → allow write + edit
      - run_commands   → allow bash

    Only True values generate allow rules; False values are ignored so the
    GLOBAL_DEFAULTS "ask" behaviour is preserved.
    """
    if not presets:
        return Ruleset()
    rules: list[PermissionRule] = []
    if presets.get("file_changes"):
        rules.append(PermissionRule(action="allow", permission="write"))
        rules.append(PermissionRule(action="allow", permission="edit"))
    if presets.get("run_commands"):
        rules.append(PermissionRule(action="allow", permission="bash"))
    return Ruleset(rules=rules)


def pattern_matches(value: str, pattern: str) -> bool:
    """Public glob check: does this resource value fall under this pattern?

    Used by the processor to validate that a user-chosen remember-scope
    actually covers the resource that was just approved.
    """
    return _glob_match(value, pattern)


def _glob_match(value: str, pattern: str) -> bool:
    """Glob match for permission patterns.

    Examples:
      "*"         → matches everything
      "read"      → matches read exactly
      "read.*"    → matches read.file, read.dir
      "*.env"     → matches config.env, secrets.env
    """
    if pattern == "*":
        return True
    if "*" not in pattern and "?" not in pattern and "[" not in pattern:
        return value == pattern
    return fnmatch.fnmatch(value, pattern)


# --- Default rulesets ---

GLOBAL_DEFAULTS = Ruleset(rules=[
    PermissionRule(action="allow", permission="*"),
    PermissionRule(action="ask", permission="bash"),
    PermissionRule(action="ask", permission="write"),
    PermissionRule(action="ask", permission="edit"),
    PermissionRule(action="deny", permission="question"),
    PermissionRule(action="deny", permission="plan"),
    # .env file protection (two-dimensional: tool + resource pattern)
    PermissionRule(action="ask", permission="read", pattern="*.env"),
    PermissionRule(action="ask", permission="read", pattern="*.env.*"),
    PermissionRule(action="allow", permission="read", pattern="*.env.example"),
])
