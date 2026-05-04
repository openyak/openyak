"""System prompt assembly.

The ``assemble`` function is **pure**: it takes already-resolved inputs and
returns a ``SystemPromptParts``. Callers (today: ``SessionPrompt._setup``)
resolve I/O upstream — project instructions from disk, the active skill list
from the registry, the wall-clock time, and the platform name — then hand
those values in. This makes ``assemble`` deterministic and unit-testable
without touching the filesystem, the global skill registry, or the clock.

``build_system_prompt`` is kept as a thin convenience that resolves the I/O
itself; prefer ``assemble`` in new call sites.

Per ADR-0009 (PromptAssembler extraction).
"""

from __future__ import annotations

import os
import platform as _platform
import time as _time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable

from app.schemas.agent import AgentInfo


@dataclass(frozen=True)
class SystemPromptParts:
    """System prompt split into cached (static) and dynamic sections.

    Semantically equivalent to ADR-0009's ``list[SystemPart]`` of length two —
    the cached segment plus the dynamic segment. ``as_cached_blocks()``
    materialises the list-of-dict form expected by ``BaseProvider.stream_chat``
    and Anthropic prompt caching.
    """

    cached: str
    dynamic: str

    def as_plain_text(self) -> str:
        """Join both parts into a single string (for non-caching providers)."""
        parts = [p for p in (self.cached, self.dynamic) if p]
        return "\n\n".join(parts)

    def as_cached_blocks(self) -> list[dict[str, Any]]:
        """Format as Anthropic system message blocks with cache_control.

        Returns a list suitable for the Anthropic API ``system`` parameter:
        the cached block gets a ``cache_control`` marker so it is stored
        server-side and reused across turns within the same session.
        """
        blocks: list[dict[str, Any]] = []
        if self.cached:
            blocks.append({
                "type": "text",
                "text": self.cached,
                "cache_control": {"type": "ephemeral"},
            })
        if self.dynamic:
            blocks.append({
                "type": "text",
                "text": self.dynamic,
            })
        return blocks


def assemble(
    agent: AgentInfo,
    *,
    directory: str | None = None,
    workspace: str | None = None,
    fts_status: dict | None = None,
    workspace_memory_section: str | None = None,
    project_instructions: str | None = None,
    skills_summary: str | None = None,
    now: datetime,
    tz_name: str,
    platform_name: str,
) -> SystemPromptParts:
    """Assemble the system prompt from caller-resolved inputs.

    Pure: no filesystem reads, no registry lookups, no clock calls. Resolve
    ``project_instructions`` via :func:`load_project_instructions`,
    ``skills_summary`` via :func:`render_skills_section`, and ``now`` /
    ``tz_name`` / ``platform_name`` from the caller's environment.

    Tests pin all inputs to assert exact output.
    """
    cached_parts: list[str] = []

    if agent.system_prompt:
        cached_parts.append(agent.system_prompt)

    if project_instructions:
        cached_parts.append(project_instructions)

    dynamic_parts: list[str] = []

    if workspace_memory_section:
        dynamic_parts.append(workspace_memory_section)

    if skills_summary:
        dynamic_parts.append(skills_summary)

    env_info = _environment_section(
        directory,
        workspace=workspace,
        fts_status=fts_status,
        now=now,
        tz_name=tz_name,
        platform_name=platform_name,
    )
    dynamic_parts.append(env_info)

    return SystemPromptParts(
        cached="\n\n".join(cached_parts),
        dynamic="\n\n".join(dynamic_parts),
    )


def build_system_prompt(
    agent: AgentInfo,
    *,
    directory: str | None = None,
    workspace: str | None = None,
    fts_status: dict | None = None,
    workspace_memory_section: str | None = None,
) -> SystemPromptParts:
    """Backward-compatible convenience wrapper that resolves I/O internally.

    Prefer :func:`assemble` in new call sites — it leaves I/O resolution to
    the caller, which keeps the assembly step deterministic and testable.
    """
    return assemble(
        agent,
        directory=directory,
        workspace=workspace,
        fts_status=fts_status,
        workspace_memory_section=workspace_memory_section,
        project_instructions=load_project_instructions(directory),
        skills_summary=render_skills_section(_active_skills_from_registry()),
        now=datetime.now(),
        tz_name=default_tz_name(),
        platform_name=_platform.system(),
    )


def default_tz_name() -> str:
    """Return the local timezone name, matching the existing prompt's format."""
    return _time.tzname[_time.daylight] if _time.daylight else _time.tzname[0]


def load_project_instructions(directory: str | None) -> str | None:
    """Load project-specific instructions from conventional locations.

    Returns the formatted ``# Project Instructions`` section or ``None`` if
    no instruction file is found. Public helper — callers resolve this and
    pass the result to :func:`assemble`.
    """
    if not directory:
        return None

    candidates = [
        os.path.join(directory, "AGENTS.md"),
        os.path.join(directory, ".openyak", "instructions.md"),
        os.path.join(directory, ".openyak", "instructions"),
    ]

    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                if content:
                    return f"# Project Instructions\n{content}"
            except OSError:
                continue

    return None


def render_skills_section(active_skills: Iterable[Any]) -> str | None:
    """Render the skill-routing section from a sorted list of active skills.

    Each skill must expose ``.name`` and ``.description`` attributes. Returns
    ``None`` when no skills are active. Public helper — callers fetch the
    skill list (e.g. ``registry.active_skills()``) and pass to :func:`assemble`.

    The list is duplicated in the system prompt because many models route
    better when relevant capabilities are surfaced there in addition to the
    skill tool's own description.
    """
    skills = list(active_skills)
    if not skills:
        return None

    shown = skills[:12]
    remaining = len(skills) - len(shown)

    lines = [
        "# Skill Routing",
        "If the task matches one of the skills below, call the `skill` tool before major work.",
        "Use skills for specialised workflows or output-generation tasks. Do not load a skill just to read a file.",
        "",
        "Currently available skills:",
    ]

    for skill in shown:
        desc = (skill.description or "").strip()
        if len(desc) > 90:
            desc = desc[:87] + "..."
        lines.append(f"- {skill.name}: {desc}")

    if remaining > 0:
        lines.append(f"- (and {remaining} more available via the `skill` tool)")

    return "\n".join(lines)


def _active_skills_from_registry() -> list[Any]:
    """Best-effort fetch of currently active skills, sorted by name."""
    try:
        from app.dependencies import get_skill_registry

        registry = get_skill_registry()
        return sorted(registry.active_skills(), key=lambda s: s.name.lower())
    except Exception:
        return []


def _environment_section(
    directory: str | None,
    *,
    workspace: str | None,
    fts_status: dict | None,
    now: datetime,
    tz_name: str,
    platform_name: str,
) -> str:
    """Render the environment section from already-resolved values."""
    cwd = directory or os.getcwd()
    today = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M")

    section = f"""# Environment
- Working directory: {cwd}
- Platform: {platform_name}
- Current date: {today} ({current_time} {tz_name})
- Current year: {now.year}"""

    if workspace:
        from pathlib import Path
        output_dir = str(Path(workspace) / "openyak_written")
        section += f"""

# Workspace Restriction
You are restricted to the following workspace directory: {workspace}
All file operations (read, write, edit, glob, grep) and shell command working directories \
MUST stay within this directory. Attempting to access paths outside will be blocked.
Always use paths relative to or inside: {workspace}

# Default Output Directory
When creating new files and the user does not specify a location, \
place them in: {output_dir}
This directory is auto-created for you. Use it to keep generated files organized.
If the user explicitly specifies a different path (within the workspace), use that instead."""
    else:
        section += f"""

# File Reference Format
You are not restricted to a workspace for this session.
When referencing local files in your response, prefer absolute paths rooted from the working directory: {cwd}
Do not return relative paths like `src/main.py` when an absolute path is available."""

    if fts_status:
        status = fts_status.get("status", "unknown")
        file_count = fts_status.get("file_count")
        count_str = f" ({file_count:,} files)" if file_count else ""
        if status == "indexed":
            section += f"""

# Full-Text Search
- FTS: enabled, workspace indexed{count_str}
- Full-text search available via `search` tool — use it for broad keyword discovery
- Use `grep` for exact regex pattern matching"""
        elif status == "indexing":
            section += """

# Full-Text Search
- FTS: enabled, workspace indexing in progress
- Full-text `search` tool will be available once indexing completes"""

    return section
