"""Tests for app.tool.workspace — path validation security boundary."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.tool.workspace import (
    WorkspaceViolation,
    resolve_and_validate,
    resolve_for_write,
    validate_cwd,
)


class TestResolveAndValidate:
    def test_absolute_path_within_workspace(self, tmp_path: Path):
        f = tmp_path / "file.txt"
        f.touch()
        result = resolve_and_validate(str(f), str(tmp_path))
        assert result == str(f.resolve())

    def test_relative_path_resolved_against_workspace(self, tmp_path: Path):
        (tmp_path / "foo.txt").touch()
        result = resolve_and_validate("foo.txt", str(tmp_path))
        assert result == str((tmp_path / "foo.txt").resolve())

    def test_path_outside_workspace_raises(self, tmp_path: Path):
        with pytest.raises(WorkspaceViolation):
            resolve_and_validate("/etc/passwd", str(tmp_path))

    def test_dot_dot_traversal_raises(self, tmp_path: Path):
        with pytest.raises(WorkspaceViolation):
            resolve_and_validate("../../etc/passwd", str(tmp_path))

    def test_no_workspace_returns_resolved(self):
        result = resolve_and_validate("/tmp/test.txt", None)
        assert result == str(Path("/tmp/test.txt").resolve())

    def test_symlink_escape_raises(self, tmp_path: Path):
        target = Path("/tmp")
        link = tmp_path / "escape"
        link.symlink_to(target)
        with pytest.raises(WorkspaceViolation):
            resolve_and_validate(str(link / "outside.txt"), str(tmp_path))


class TestResolveForWrite:
    def test_relative_path_to_openyak_written(self, tmp_path: Path):
        result = resolve_for_write("output.txt", str(tmp_path))
        expected = str((tmp_path / "openyak_written" / "output.txt").resolve())
        assert result == expected

    def test_explicit_output_prefix_is_not_duplicated(self, tmp_path: Path):
        result = resolve_for_write("openyak_written/output.txt", str(tmp_path))
        expected = str((tmp_path / "openyak_written" / "output.txt").resolve())
        assert result == expected

    def test_absolute_within_workspace(self, tmp_path: Path):
        f = tmp_path / "file.txt"
        result = resolve_for_write(str(f), str(tmp_path))
        assert result == str(f.resolve())

    def test_absolute_outside_raises(self, tmp_path: Path):
        with pytest.raises(WorkspaceViolation):
            resolve_for_write("/etc/passwd", str(tmp_path))

    def test_no_workspace(self):
        result = resolve_for_write("/tmp/out.txt", None)
        assert result == str(Path("/tmp/out.txt").resolve())


class TestValidateCwd:
    def test_none_cwd_returns_workspace(self, tmp_path: Path):
        assert validate_cwd(None, str(tmp_path)) == str(tmp_path)

    def test_valid_cwd_within_workspace(self, tmp_path: Path):
        sub = tmp_path / "sub"
        sub.mkdir()
        result = validate_cwd(str(sub), str(tmp_path))
        assert result == str(sub.resolve())

    def test_cwd_outside_raises(self, tmp_path: Path):
        with pytest.raises(WorkspaceViolation):
            validate_cwd("/etc", str(tmp_path))

    def test_no_workspace_returns_cwd(self):
        assert validate_cwd("/some/dir", None) == "/some/dir"
