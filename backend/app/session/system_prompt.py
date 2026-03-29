"""System prompt builder.

Assembles the full system prompt from:
  - Agent's base prompt template
  - Environment info (cwd, platform, date)
  - Project instructions (if any)
"""

from __future__ import annotations

import os
import platform
import time as _time
from datetime import datetime
from pathlib import Path

from app.schemas.agent import AgentInfo


def build_system_prompt(
    agent: AgentInfo,
    *,
    directory: str | None = None,
    skill_names: list[str] | None = None,
    workspace: str | None = None,
    fts_status: dict | None = None,
    workspace_memory_section: str | None = None,
) -> str:
    """Build the complete system prompt for an LLM call."""
    parts = []

    # Agent's base prompt
    if agent.system_prompt:
        parts.append(agent.system_prompt)

    # Workspace-scoped memory (auto-injected per workspace)
    if workspace_memory_section:
        parts.append(workspace_memory_section)

    # Environment info
    env_info = _environment_section(directory, workspace=workspace, fts_status=fts_status)
    parts.append(env_info)

    # Project instructions (AGENTS.md, .openyak/instructions)
    project_instructions = _load_project_instructions(directory)
    if project_instructions:
        parts.append(project_instructions)

    # Available skills hint
    skills_section = _skills_section(skill_names)
    if skills_section:
        parts.append(skills_section)

    return "\n\n".join(parts)


def _environment_section(directory: str | None = None, *, workspace: str | None = None, fts_status: dict | None = None) -> str:
    """Generate environment context section."""
    cwd = directory or os.getcwd()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M")
    tz_name = _time.tzname[_time.daylight] if _time.daylight else _time.tzname[0]
    plat = platform.system()

    section = f"""# Environment
- Working directory: {cwd}
- Platform: {plat}
- Current date: {today} ({current_time} {tz_name})
- Current year: {now.year}"""

    if workspace:
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


def _load_project_instructions(directory: str | None) -> str | None:
    """Load project-specific instructions from conventional locations."""
    if not directory:
        return None

    # Check common instruction file locations
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


def _skills_section(skill_names: list[str] | None) -> str | None:
    """Generate a hint about available skills for the system prompt."""
    if not skill_names:
        return None

    names = ", ".join(skill_names)
    return (
        "# Available Skills\n"
        f"The following skills are available via the `skill` tool: {names}\n\n"
        "Before starting a task, check if a relevant skill exists. "
        "If one looks related, load it first — it may contain useful "
        "workflows, best practices, or instructions that improve your output.\n\n"
        "IMPORTANT: Do NOT load a skill just to read a file. The `read` tool "
        "already handles ALL file types natively (PDF, DOCX, XLSX, PPTX, images, etc.). "
        "Simply call `read` directly — no skill needed."
    )
