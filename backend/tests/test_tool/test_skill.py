"""Tests for the SkillTool."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio

from app.schemas.agent import AgentInfo, Ruleset
from app.skill.registry import SkillRegistry
from app.tool.builtin.skill import SkillTool
from app.tool.context import ToolContext


def _make_ctx() -> ToolContext:
    """Create a minimal ToolContext for testing."""
    return ToolContext(
        session_id="test-session",
        message_id="msg-1",
        agent=AgentInfo(name="build", description="test agent", mode="primary"),
        call_id="call-1",
    )


class TestSkillToolProperties:
    def test_id(self):
        tool = SkillTool()
        assert tool.id == "skill"

    def test_description_no_skills(self):
        tool = SkillTool()
        assert "No skills are currently available" in tool.description

    def test_description_no_registry(self):
        tool = SkillTool(skill_registry=None)
        assert "No skills are currently available" in tool.description

    def test_description_with_skills(self, tmp_path: Path):
        skills_dir = tmp_path / ".openyak" / "skills" / "test-skill"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text(
            "---\nname: test-skill\ndescription: A test.\n---\nContent",
            encoding="utf-8",
        )
        registry = SkillRegistry()
        registry.scan(project_dir=str(tmp_path))

        tool = SkillTool(skill_registry=registry)
        desc = tool.description

        assert "test-skill" in desc
        assert "A test." in desc

    def test_parameters_schema(self):
        tool = SkillTool()
        schema = tool.parameters_schema()
        assert schema["type"] == "object"
        assert "name" in schema["properties"]
        assert "name" in schema["required"]


class TestSkillToolExecute:
    @pytest.mark.asyncio
    async def test_execute_loads_skill(self, tmp_path: Path):
        skills_dir = tmp_path / ".openyak" / "skills" / "my-skill"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text(
            "---\nname: my-skill\ndescription: My skill.\n---\n\n# Skill body\nInstructions here.",
            encoding="utf-8",
        )
        registry = SkillRegistry()
        registry.scan(project_dir=str(tmp_path))

        tool = SkillTool(skill_registry=registry)
        result = await tool.execute({"name": "my-skill"}, _make_ctx())

        assert result.success
        assert '<skill_content name="my-skill">' in result.output
        assert "# Skill body" in result.output
        assert "Instructions here." in result.output
        assert result.title == "Loaded skill: my-skill"

    @pytest.mark.asyncio
    async def test_execute_skill_not_found(self):
        registry = SkillRegistry()
        registry.scan()

        tool = SkillTool(skill_registry=registry)
        result = await tool.execute({"name": "nonexistent"}, _make_ctx())

        assert not result.success
        assert "not found" in result.error

    @pytest.mark.asyncio
    async def test_execute_no_registry(self):
        tool = SkillTool(skill_registry=None)
        result = await tool.execute({"name": "anything"}, _make_ctx())

        assert not result.success
        assert "not initialised" in result.error

    @pytest.mark.asyncio
    async def test_execute_lists_bundled_files(self, tmp_path: Path):
        skills_dir = tmp_path / ".openyak" / "skills" / "rich-skill"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text(
            "---\nname: rich-skill\ndescription: Has extra files.\n---\n\nMain content.",
            encoding="utf-8",
        )
        # Create a bundled reference file
        (skills_dir / "reference.md").write_text("Extra reference.", encoding="utf-8")

        registry = SkillRegistry()
        registry.scan(project_dir=str(tmp_path))

        tool = SkillTool(skill_registry=registry)
        result = await tool.execute({"name": "rich-skill"}, _make_ctx())

        assert result.success
        assert "<skill_files>" in result.output
        assert "reference.md" in result.output
