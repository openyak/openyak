"""Detect a user-installed Rapid-MLX CLI."""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_VERSION_TIMEOUT = 3.0
_DEFAULT_BASE_URL = "http://localhost:8000/v1"


@dataclass(slots=True)
class RapidMlxStatus:
    installed: bool
    binary_path: str = ""
    version: str = ""
    default_base_url: str = _DEFAULT_BASE_URL


async def _read_version(binary: str) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, PermissionError) as exc:
        logger.debug("rapid-mlx --version spawn failed: %s", exc)
        return ""

    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_VERSION_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ""

    if proc.returncode != 0:
        return ""
    return stdout.decode("utf-8", errors="replace").strip()


async def detect_rapid_mlx() -> RapidMlxStatus:
    """Probe PATH for the ``rapid-mlx`` CLI and capture its version."""
    binary = shutil.which("rapid-mlx")
    if not binary:
        return RapidMlxStatus(installed=False)
    version = await _read_version(binary)
    return RapidMlxStatus(installed=True, binary_path=binary, version=version)
