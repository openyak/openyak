"""Skill tool — lets agents load specialised instruction sets on demand."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from app.tool.base import ToolDefinition, ToolResult
from app.tool.context import ToolContext


class SkillTool(ToolDefinition):
    """Meta-tool that loads SKILL.md instruction sets into the conversation.

    The tool description dynamically lists all available skills so the LLM
    knows what it can invoke.
    """

    def __init__(self, skill_registry: "SkillRegistry | None" = None) -> None:
        self._skill_registry = skill_registry

    # ------------------------------------------------------------------
    # ToolDefinition interface
    # ------------------------------------------------------------------

    @property
    def id(self) -> str:
        return "skill"

    @property
    def is_concurrency_safe(self) -> bool:
        # Loading instructions and bundled resources is read-only.
        return True

    # Maximum number of skills to list in the tool description.
    # Beyond this limit, remaining skills are noted as "(and N more)".
    _MAX_LISTED_SKILLS = 40
    # Maximum characters per skill description before truncation.
    _MAX_DESC_CHARS = 120

    @property
    def description(self) -> str:
        """Dynamically generated — includes budgeted list of available skills."""
        base = (
            "Load a specialised skill that provides domain-specific "
            "instructions and workflows.\n\n"
            "When you recognise that a task matches one of the available "
            "skills listed below, use this tool to load the full skill "
            "instructions. The skill content and bundled resource file "
            "paths will be returned.\n\n"
            "IMPORTANT: Do NOT load a skill just to read a file. The `read` "
            "tool already handles ALL file types natively (PDF, DOCX, XLSX, "
            "PPTX, images, etc.). Simply call `read` directly — no skill "
            "needed.\n\n"
            "Available skills:"
        )

        active = self._skill_registry.active_skills() if self._skill_registry else []
        if not active:
            return base + "\n\nNo skills are currently available."

        shown = active[: self._MAX_LISTED_SKILLS]
        remaining = len(active) - len(shown)

        lines = [base, ""]
        for skill in shown:
            desc = skill.description or ""
            if len(desc) > self._MAX_DESC_CHARS:
                desc = desc[: self._MAX_DESC_CHARS - 3] + "..."
            lines.append(f"- {skill.name}: {desc}")

        if remaining > 0:
            lines.append(f"  (and {remaining} more — invoke by name to check availability)")
        return "\n".join(lines)

    def parameters_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The name of the skill to load (from available_skills).",
                },
            },
            "required": ["name"],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        name: str = args["name"]

        if not self._skill_registry:
            return ToolResult(error="Skill system is not initialised.")

        skill = self._skill_registry.get(name)
        if skill is None or self._skill_registry.is_disabled(name):
            available = ", ".join(self._skill_registry.active_skill_names()) or "none"
            return ToolResult(
                error=f'Skill "{name}" not found or disabled. Available skills: {available}',
            )

        # Collect bundled files in the same directory (up to 10)
        skill_dir = Path(skill.location).parent
        bundled_files = _list_bundled_files(skill_dir, limit=10)

        files_block = ""
        if bundled_files:
            file_tags = "\n".join(f"<file>{f}</file>" for f in bundled_files)
            files_block = (
                f"\n\n<skill_files>\n{file_tags}\n</skill_files>"
            )

        base_dir_hint = (
            f"\n\nBase directory for this skill: {skill_dir}\n"
            "Relative paths in this skill (e.g., scripts/, reference/) "
            "are relative to this base directory."
        )

        output = (
            f'<skill_content name="{skill.name}">\n'
            f"# Skill: {skill.name}\n\n"
            f"{skill.content.strip()}\n"
            f"{base_dir_hint}\n"
            f"{files_block}\n"
            f"</skill_content>"
        )

        ctx.publish_metadata(title=f"Loaded skill: {skill.name}")
        return ToolResult(
            output=output,
            title=f"Loaded skill: {skill.name}",
            metadata={"name": skill.name, "dir": str(skill_dir)},
        )


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _list_bundled_files(directory: Path, *, limit: int = 10) -> list[str]:
    """Return up to *limit* files under *directory*, excluding SKILL.md."""
    result: list[str] = []
    if not directory.is_dir():
        return result

    for root, _dirs, files in os.walk(directory):
        for fname in sorted(files):
            if fname == "SKILL.md":
                continue
            result.append(str(Path(root) / fname))
            if len(result) >= limit:
                return result
    return result
