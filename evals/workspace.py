"""Isolated workspace fixtures and deterministic filesystem snapshots."""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FileState:
    size: int
    sha256: str


@dataclass(frozen=True)
class WorkspaceSnapshot:
    files: dict[str, FileState]

    @classmethod
    def capture(cls, root: Path) -> "WorkspaceSnapshot":
        files: dict[str, FileState] = {}
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            content = path.read_bytes()
            relative = path.relative_to(root).as_posix()
            files[relative] = FileState(
                size=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
            )
        return cls(files=files)


@dataclass(frozen=True)
class WorkspaceDiff:
    changes: dict[str, str]


@dataclass
class EvaluationWorkspace:
    path: Path
    before: WorkspaceSnapshot

    def diff(self) -> WorkspaceDiff:
        after = WorkspaceSnapshot.capture(self.path)
        changes: dict[str, str] = {}
        for path in sorted(self.before.files.keys() | after.files.keys()):
            if path not in self.before.files:
                changes[path] = "created"
            elif path not in after.files:
                changes[path] = "deleted"
            elif self.before.files[path] != after.files[path]:
                changes[path] = "modified"
        return WorkspaceDiff(changes=changes)


def prepare_workspace(fixture: str | Path, destination: str | Path) -> EvaluationWorkspace:
    """Copy a fixture into an isolated destination and capture its initial state."""
    fixture_path = Path(fixture)
    destination_path = Path(destination)
    shutil.copytree(fixture_path, destination_path)
    return EvaluationWorkspace(
        path=destination_path,
        before=WorkspaceSnapshot.capture(destination_path),
    )
