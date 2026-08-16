"""Credential files must survive a crash and a concurrent writer."""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

import pytest

from app.utils.atomic_write import SECRET_FILE_MODE, atomic_write_text, file_lock


def test_write_creates_the_file_owner_only(tmp_path: Path) -> None:
    target = tmp_path / "nested" / ".env"

    atomic_write_text(target, "OPENYAK_API_KEY='sk-secret'\n")

    assert target.read_text() == "OPENYAK_API_KEY='sk-secret'\n"
    if sys.platform != "win32":
        assert os.stat(target).st_mode & 0o777 == SECRET_FILE_MODE


def test_a_secret_is_never_briefly_world_readable(tmp_path: Path) -> None:
    """The mode is applied at open(), before any bytes are written."""
    target = tmp_path / ".env"
    atomic_write_text(target, "first")
    if sys.platform != "win32":
        os.chmod(target, 0o644)

    atomic_write_text(target, "OPENYAK_API_KEY='sk-second'\n")

    if sys.platform != "win32":
        assert os.stat(target).st_mode & 0o777 == SECRET_FILE_MODE


@pytest.mark.parametrize("failing_call", ["fsync", "replace"])
def test_a_failed_write_leaves_the_previous_file_intact(
    tmp_path: Path, monkeypatch, failing_call: str
) -> None:
    """A partial write must never be observable — this is the whole point.

    Both halves are covered: the disk filling up while the new content is
    flushed, and the rename itself failing.
    """
    target = tmp_path / ".env"
    atomic_write_text(target, "OPENYAK_API_KEY='sk-original'\n")

    def explode(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, failing_call, explode)

    with pytest.raises(OSError):
        atomic_write_text(target, "OPENYAK_API_KEY='sk-replacement'\n")

    monkeypatch.undo()
    assert target.read_text() == "OPENYAK_API_KEY='sk-original'\n"
    assert [p.name for p in tmp_path.iterdir()] == [".env"]


def test_no_temporary_files_are_left_behind(tmp_path: Path) -> None:
    target = tmp_path / ".env"
    atomic_write_text(target, "a=1\n")
    atomic_write_text(target, "a=2\n")

    assert [p.name for p in tmp_path.iterdir()] == [".env"]


def test_concurrent_read_modify_writes_do_not_lose_keys(tmp_path: Path) -> None:
    """Two threads adding different keys must both survive.

    An unlocked read → splice → write loses whichever write lands second.
    """
    target = tmp_path / ".env"
    atomic_write_text(target, "")
    barrier = threading.Barrier(8)

    def add_key(index: int) -> None:
        barrier.wait()
        for _ in range(20):
            with file_lock(target):
                lines = [
                    line for line in target.read_text().splitlines() if line.strip()
                ]
                lines.append(f"KEY_{index}='v'")
                # De-duplicate the way the real writer does.
                seen: dict[str, str] = {}
                for line in lines:
                    seen[line.split("=", 1)[0]] = line
                atomic_write_text(target, "\n".join(seen.values()) + "\n")

    threads = [threading.Thread(target=add_key, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    written = {
        line.split("=", 1)[0] for line in target.read_text().splitlines() if line.strip()
    }
    assert written == {f"KEY_{i}" for i in range(8)}


def test_json_stores_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "mcp-tokens.json"
    payload = {"slack": {"access_token": "xoxb-1", "expires_at": 1.5}}

    atomic_write_text(target, json.dumps(payload, indent=2))

    assert json.loads(target.read_text()) == payload
