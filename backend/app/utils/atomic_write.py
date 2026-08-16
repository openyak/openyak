"""Crash-safe, owner-only writes for local credential and config files.

These files hold the user's BYOK API keys, OAuth refresh tokens, and channel
credentials. They are rewritten whole on every change — including on hot paths
like an Ollama generation recording its model — so a plain ``write_text`` puts
the entire set at risk on any interrupted write, and two concurrent writers
silently lose one another's changes.

:func:`atomic_write_text` replaces the file in one step and never leaves a
partial one behind, and :func:`file_lock` serialises the read-modify-write
sequences that surround it.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

# One lock per resolved path, shared process-wide. Callers hold it across the
# whole read-modify-write, not just the write, because the read is what a
# concurrent writer invalidates.
_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()

SECRET_FILE_MODE = 0o600
SECRET_DIR_MODE = 0o700


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Serialise read-modify-write cycles against one path within this process."""
    key = str(Path(path).expanduser().resolve(strict=False))
    with _locks_guard:
        lock = _locks.setdefault(key, threading.RLock())
    with lock:
        yield


def atomic_write_text(
    path: Path,
    content: str,
    *,
    encoding: str = "utf-8",
    mode: int = SECRET_FILE_MODE,
) -> None:
    """Write *content* to *path* as one indivisible replacement.

    Writes a sibling temporary file, flushes it to disk, renames it over the
    target, then flushes the directory entry. A reader either sees the previous
    file or the new one, never a truncated mix, and a crash mid-write leaves the
    previous file intact.

    The file is created with *mode* before any content reaches it, so a secret
    is never briefly world-readable. The parent directory is created with
    ``0o700`` when missing.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=SECRET_DIR_MODE)

    tmp_path = path.with_name(f".{path.name}.tmp{os.getpid()}")
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            handle = os.fdopen(fd, "w", encoding=encoding)
        except BaseException:
            os.close(fd)  # fdopen did not take ownership
            raise
        with handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
        _fsync_dir(path.parent)
    finally:
        # os.replace consumed the temp file on success; clean up on any failure
        # so a full disk does not accumulate droppings next to the real file.
        try:
            tmp_path.unlink()
        except OSError:
            pass


def _fsync_dir(directory: Path) -> None:
    """Persist the rename itself, not just the new file's contents."""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return  # Windows cannot open a directory; the rename is atomic regardless
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
