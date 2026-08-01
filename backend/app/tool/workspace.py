"""Workspace directory restriction — path validation utilities.

When a workspace is configured, all file-access tools must operate
within that directory.  This module provides the validation logic.
"""

from __future__ import annotations

from pathlib import Path


class WorkspaceViolation(Exception):
    """Raised when a path is outside the allowed workspace."""

    def __init__(self, path: str, workspace: str):
        self.path = path
        self.workspace = workspace
        super().__init__(
            f"Access denied: '{path}' is outside the workspace directory '{workspace}'"
        )


def resolve_and_validate(file_path: str, workspace: str | None) -> str:
    """Resolve *file_path* to an absolute path and verify it lives inside *workspace*.

    - Resolves relative paths against the workspace directory (not cwd).
    - Follows symlinks via Path.resolve() to defeat symlink escapes.
    - Normalises case on Windows (Path.resolve() does this).
    - If *workspace* is ``None`` or empty, returns the resolved path with
      no restriction (backward-compatible).

    Returns the resolved absolute path string.
    Raises :class:`WorkspaceViolation` if the path escapes the workspace.
    """
    if not workspace:
        return str(Path(file_path).resolve())

    p = Path(file_path)
    if not p.is_absolute():
        resolved = (Path(workspace) / file_path).resolve()
    else:
        resolved = p.resolve()
    ws = Path(workspace).resolve()

    try:
        resolved.relative_to(ws)
    except ValueError:
        raise WorkspaceViolation(str(resolved), str(ws))

    return str(resolved)


def get_default_output_dir(workspace: str | None) -> str | None:
    """Return the ``openyak_written`` subdirectory of *workspace*, or ``None``."""
    if not workspace:
        return None
    return str(Path(workspace).resolve() / "openyak_written")


def resolve_for_write(file_path: str, workspace: str | None) -> str:
    """Resolve a file path for write operations.

    If *workspace* is set and *file_path* is relative (not absolute), resolve it
    against ``{workspace}/openyak_written/`` instead of cwd. A relative path
    already beginning with ``openyak_written/`` is treated idempotently rather
    than duplicating the output-directory prefix. Workspace restriction is
    still enforced afterwards.

    Returns the resolved absolute path string.
    Raises :class:`WorkspaceViolation` if the path escapes the workspace.
    """
    p = Path(file_path)
    if workspace and not p.is_absolute():
        workspace_dir = Path(workspace).resolve()
        if p.parts and p.parts[0] == "openyak_written":
            resolved = (workspace_dir / p).resolve()
        else:
            resolved = (workspace_dir / "openyak_written" / p).resolve()
    else:
        resolved = p.resolve()

    # Enforce workspace restriction
    if workspace:
        ws = Path(workspace).resolve()
        try:
            resolved.relative_to(ws)
        except ValueError:
            raise WorkspaceViolation(str(resolved), str(ws))

    return str(resolved)


def validate_cwd(cwd: str | None, workspace: str | None) -> str | None:
    """Validate that a requested working directory is inside the workspace.

    If *cwd* is ``None``, returns the workspace itself (so bash defaults
    to workspace).  If *workspace* is ``None``, returns *cwd* unchanged.

    Raises :class:`WorkspaceViolation` if *cwd* escapes the workspace.
    """
    if not workspace:
        return cwd

    if not cwd:
        return workspace  # default cwd → workspace

    resolved = Path(cwd).resolve()
    ws = Path(workspace).resolve()

    try:
        resolved.relative_to(ws)
    except ValueError:
        raise WorkspaceViolation(str(resolved), str(ws))

    return str(resolved)
