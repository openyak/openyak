"""Cross-platform subprocess helpers.

Centralises platform detection, shell selection, encoding handling,
and creationflags so individual tools don't duplicate this logic.
"""

from __future__ import annotations

import locale
import shutil
import subprocess
import sys
from typing import Any

IS_WINDOWS = sys.platform == "win32"


def get_subprocess_kwargs() -> dict[str, Any]:
    """Return platform-specific kwargs for subprocess.run().

    On Windows: includes ``creationflags=CREATE_NO_WINDOW``.
    On other platforms: returns an empty dict (no ``creationflags`` kwarg).
    """
    if IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def find_shell() -> list[str]:
    """Return the command prefix for running a shell command on this platform.

    On Windows: ``["powershell.exe", "-NoProfile", "-Command"]``
    On other platforms: ``["bash", "-c"]`` (or ``["sh", "-c"]`` as fallback).
    """
    if IS_WINDOWS:
        # Prefer PowerShell 7+ (pwsh) if installed, fall back to built-in 5.1
        pwsh = shutil.which("pwsh")
        exe = pwsh if pwsh else "powershell.exe"
        return [exe, "-NoProfile", "-Command"]

    bash = shutil.which("bash")
    if bash:
        return [bash, "-c"]
    return ["sh", "-c"]


def decode_subprocess_output(data: bytes) -> str:
    """Decode subprocess stdout/stderr with platform-aware fallback.

    Strategy:
      1. Try UTF-8 (strict) — works for bash / modern tools.
      2. On Windows only: try the system code page (e.g. CP936, CP1252).
      3. Fall back to UTF-8 with ``errors='replace'``.
    """
    # Try UTF-8 first (most common for modern tools)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass

    # On Windows, try system code page
    if IS_WINDOWS:
        try:
            system_encoding = locale.getpreferredencoding(False)
            if system_encoding and system_encoding.lower().replace("-", "") != "utf8":
                return data.decode(system_encoding)
        except (UnicodeDecodeError, LookupError):
            pass

    # Final fallback
    return data.decode("utf-8", errors="replace")
