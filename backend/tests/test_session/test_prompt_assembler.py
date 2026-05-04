"""Pure-function tests for ``app.session.system_prompt.assemble``.

These tests pin every input — agent, time, platform, project instructions,
skill summary — and assert exact output structure. They run without touching
the filesystem, the skill registry, or the clock. The integration tests in
``test_system_prompt.py`` cover the convenience wrapper ``build_system_prompt``
which resolves I/O internally.

Per ADR-0009 (PromptAssembler extraction).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pytest

from app.schemas.agent import AgentInfo
from app.session.system_prompt import (
    SystemPromptParts,
    assemble,
    load_project_instructions,
    render_skills_section,
)


def _agent(*, system_prompt: str | None = "You are a helpful assistant.") -> AgentInfo:
    return AgentInfo(
        name="test",
        description="test agent",
        mode="primary",
        system_prompt=system_prompt,
    )


def _now() -> datetime:
    return datetime(2026, 5, 4, 15, 30, 0)


_PINNED = {
    "now": _now(),
    "tz_name": "PDT",
    "platform_name": "Darwin",
}


class TestAssemblePureness:
    def test_returns_system_prompt_parts(self) -> None:
        parts = assemble(_agent(), **_PINNED)
        assert isinstance(parts, SystemPromptParts)

    def test_no_global_state_consulted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Break the helpers that the convenience wrapper would use; assemble()
        # must not touch them.
        monkeypatch.setattr(
            "app.session.system_prompt._active_skills_from_registry",
            lambda: (_ for _ in ()).throw(RuntimeError("must not be called")),
        )
        monkeypatch.setattr(
            "app.session.system_prompt.load_project_instructions",
            lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("must not be called")),
        )

        parts = assemble(_agent(), directory="/anywhere", **_PINNED)
        assert "Working directory: /anywhere" in parts.dynamic


class TestCachedSection:
    def test_agent_system_prompt_in_cached(self) -> None:
        parts = assemble(_agent(system_prompt="ABC123"), **_PINNED)
        assert "ABC123" in parts.cached

    def test_no_agent_system_prompt_yields_empty_cached(self) -> None:
        parts = assemble(_agent(system_prompt=None), **_PINNED)
        assert parts.cached == ""

    def test_project_instructions_appended_to_cached(self) -> None:
        parts = assemble(
            _agent(system_prompt="AGENT"),
            project_instructions="# Project Instructions\nDo X.",
            **_PINNED,
        )
        assert "AGENT" in parts.cached
        assert "Do X." in parts.cached
        # Order: agent prompt first, project instructions after.
        assert parts.cached.index("AGENT") < parts.cached.index("Do X.")

    def test_project_instructions_alone(self) -> None:
        parts = assemble(
            _agent(system_prompt=None),
            project_instructions="# Project Instructions\nOnly project rules.",
            **_PINNED,
        )
        assert parts.cached == "# Project Instructions\nOnly project rules."


class TestDynamicSection:
    def test_workspace_memory_first(self) -> None:
        parts = assemble(
            _agent(),
            workspace_memory_section="# Memory\nremember this",
            **_PINNED,
        )
        assert parts.dynamic.startswith("# Memory\nremember this")

    def test_skills_summary_after_memory(self) -> None:
        parts = assemble(
            _agent(),
            workspace_memory_section="# Memory\nA",
            skills_summary="# Skill Routing\nB",
            **_PINNED,
        )
        idx_mem = parts.dynamic.index("# Memory")
        idx_skill = parts.dynamic.index("# Skill Routing")
        idx_env = parts.dynamic.index("# Environment")
        assert idx_mem < idx_skill < idx_env

    def test_environment_section_always_present(self) -> None:
        parts = assemble(_agent(), **_PINNED)
        assert "# Environment" in parts.dynamic
        assert "Working directory:" in parts.dynamic
        assert "Platform: Darwin" in parts.dynamic
        assert "Current date: 2026-05-04 (15:30 PDT)" in parts.dynamic
        assert "Current year: 2026" in parts.dynamic


class TestEnvironmentDeterminism:
    def test_pinned_now_produces_pinned_strings(self) -> None:
        pinned_now = datetime(2030, 1, 2, 9, 5, 0)
        parts = assemble(
            _agent(),
            now=pinned_now,
            tz_name="UTC",
            platform_name="Linux",
        )
        assert "Current date: 2030-01-02 (09:05 UTC)" in parts.dynamic
        assert "Current year: 2030" in parts.dynamic
        assert "Platform: Linux" in parts.dynamic

    def test_directory_falls_back_to_cwd_when_none(self) -> None:
        parts = assemble(_agent(), directory=None, **_PINNED)
        # cwd at test time — just assert the line is present and non-empty.
        assert "Working directory: " in parts.dynamic
        line = next(
            line for line in parts.dynamic.splitlines() if line.startswith("- Working directory: ")
        )
        assert len(line) > len("- Working directory: ")


class TestWorkspaceVsNoWorkspace:
    def test_workspace_set_emits_restriction(self) -> None:
        parts = assemble(_agent(), workspace="/srv/yak", **_PINNED)
        assert "# Workspace Restriction" in parts.dynamic
        assert "/srv/yak" in parts.dynamic
        assert "openyak_written" in parts.dynamic
        assert "# File Reference Format" not in parts.dynamic

    def test_no_workspace_emits_file_reference_format(self) -> None:
        parts = assemble(_agent(), workspace=None, directory="/home/u", **_PINNED)
        assert "# File Reference Format" in parts.dynamic
        assert "/home/u" in parts.dynamic
        assert "# Workspace Restriction" not in parts.dynamic


class TestFtsStatusBranches:
    def test_indexed_with_count(self) -> None:
        parts = assemble(
            _agent(),
            fts_status={"status": "indexed", "file_count": 1234},
            **_PINNED,
        )
        assert "# Full-Text Search" in parts.dynamic
        assert "indexed (1,234 files)" in parts.dynamic

    def test_indexed_without_count(self) -> None:
        parts = assemble(_agent(), fts_status={"status": "indexed"}, **_PINNED)
        assert "indexed" in parts.dynamic
        assert "files)" not in parts.dynamic.split("# Full-Text Search", 1)[1]

    def test_indexing_in_progress(self) -> None:
        parts = assemble(_agent(), fts_status={"status": "indexing"}, **_PINNED)
        assert "indexing in progress" in parts.dynamic

    def test_unknown_status_no_section(self) -> None:
        parts = assemble(_agent(), fts_status={"status": "unknown"}, **_PINNED)
        assert "# Full-Text Search" not in parts.dynamic

    def test_no_status_dict_no_section(self) -> None:
        parts = assemble(_agent(), fts_status=None, **_PINNED)
        assert "# Full-Text Search" not in parts.dynamic


class TestCachedBlocksFormat:
    def test_two_blocks_when_both_sections_populated(self) -> None:
        parts = assemble(_agent(system_prompt="STATIC"), **_PINNED)
        blocks = parts.as_cached_blocks()
        assert len(blocks) == 2
        assert blocks[0]["type"] == "text"
        assert blocks[0]["cache_control"] == {"type": "ephemeral"}
        assert blocks[1]["type"] == "text"
        assert "cache_control" not in blocks[1]

    def test_only_dynamic_block_when_no_agent_or_project_text(self) -> None:
        parts = assemble(_agent(system_prompt=None), **_PINNED)
        blocks = parts.as_cached_blocks()
        assert len(blocks) == 1
        assert "cache_control" not in blocks[0]

    def test_as_plain_text_concatenates_with_double_newline(self) -> None:
        parts = assemble(_agent(system_prompt="A"), **_PINNED)
        plain = parts.as_plain_text()
        assert plain.startswith("A")
        assert "\n\n# Environment" in plain


class TestLoadProjectInstructionsHelper:
    def test_returns_none_for_no_directory(self) -> None:
        assert load_project_instructions(None) is None

    def test_loads_agents_md(self, tmp_path) -> None:
        (tmp_path / "AGENTS.md").write_text("Custom rules here.")
        result = load_project_instructions(str(tmp_path))
        assert result is not None
        assert result.startswith("# Project Instructions")
        assert "Custom rules here." in result

    def test_first_match_wins(self, tmp_path) -> None:
        # AGENTS.md takes precedence over .openyak/instructions.md.
        (tmp_path / "AGENTS.md").write_text("from-agents-md")
        (tmp_path / ".openyak").mkdir()
        (tmp_path / ".openyak" / "instructions.md").write_text("from-instructions-md")
        result = load_project_instructions(str(tmp_path))
        assert "from-agents-md" in result
        assert "from-instructions-md" not in result

    def test_empty_file_treated_as_missing(self, tmp_path) -> None:
        (tmp_path / "AGENTS.md").write_text("   \n  ")
        assert load_project_instructions(str(tmp_path)) is None

    def test_no_instruction_file_returns_none(self, tmp_path) -> None:
        assert load_project_instructions(str(tmp_path)) is None


class TestRenderSkillsSectionHelper:
    @dataclass(frozen=True)
    class _FakeSkill:
        name: str
        description: str

    def test_empty_returns_none(self) -> None:
        assert render_skills_section([]) is None

    def test_single_skill_listed(self) -> None:
        skills = [self._FakeSkill("triage", "Triage incoming bugs.")]
        result = render_skills_section(skills)
        assert result is not None
        assert "# Skill Routing" in result
        assert "triage: Triage incoming bugs." in result
        assert "and " not in result.split("Currently available skills:", 1)[1]

    def test_truncates_long_descriptions(self) -> None:
        long_desc = "x" * 200
        skills = [self._FakeSkill("noisy", long_desc)]
        result = render_skills_section(skills)
        assert result is not None
        assert "..." in result
        # Truncated form: 87 chars + "..." per the source.
        assert "x" * 87 + "..." in result

    def test_caps_at_twelve_with_remainder_hint(self) -> None:
        skills = [self._FakeSkill(f"s{i:02d}", f"desc {i}") for i in range(15)]
        result = render_skills_section(skills)
        assert result is not None
        # First twelve listed.
        for i in range(12):
            assert f"s{i:02d}" in result
        # Remainder hint.
        assert "and 3 more" in result
