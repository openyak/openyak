"""Skip markers for tests that depend on POSIX-only filesystem semantics.

These guard behaviour the operating system either provides or does not, rather
than behaviour OpenYak controls, so the assertions are kept and skipped where
they cannot hold instead of being weakened everywhere.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

IS_WINDOWS = sys.platform == "win32"


def _symlinks_available() -> bool:
    """Whether this process may create a symlink.

    Windows requires Developer Mode or SeCreateSymbolicLinkPrivilege, so this
    probes rather than assuming: a developer with Developer Mode enabled still
    gets the coverage.
    """
    if not IS_WINDOWS:
        return True
    with tempfile.TemporaryDirectory() as directory:
        link = Path(directory) / "probe-link"
        try:
            os.symlink(Path(directory), link, target_is_directory=True)
        except (OSError, NotImplementedError, AttributeError):
            return False
        return True


SYMLINKS_AVAILABLE = _symlinks_available()

requires_symlinks = pytest.mark.skipif(
    not SYMLINKS_AVAILABLE,
    reason=(
        "creating symlinks needs Developer Mode or SeCreateSymbolicLinkPrivilege "
        "on Windows"
    ),
)

requires_posix_permissions = pytest.mark.skipif(
    IS_WINDOWS,
    reason="NTFS has no execute bit; os.chmod only toggles the read-only flag",
)

requires_posix_shebang = pytest.mark.skipif(
    IS_WINDOWS,
    reason="Windows cannot execute a '#!/bin/sh' script as a program",
)
