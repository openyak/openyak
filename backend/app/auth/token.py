"""Token generation, storage, and validation for OpenYak's local API.

Two tokens live here:

* **Session token** — generated on every backend startup, written to
  ``<data_dir>/session_token.json`` with mode 0600, handed to the desktop
  shell via the Tauri IPC bridge. Its purpose is to make the local HTTP
  API unreachable from processes that do not share the filesystem
  identity of the user who launched OpenYak. On a multi-user host, user
  Ana cannot read user Pepe's session token and therefore cannot call
  Pepe's backend even though both are on the same loopback interface.

* **Remote token** — long-lived (survives restarts), used for the remote
  access / phone-companion mode that tunnels the backend out. Continues
  to be managed by the user from the Remote Access settings.

Tokens are simple Bearer secrets (not JWT) — appropriate for a
single-user desktop app. The session token is rotated on every backend
start, which is a natural "logout" boundary.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path

logger = logging.getLogger(__name__)

_REMOTE_PREFIX = "openyak_rt_"
_SESSION_PREFIX = "openyak_st_"


def _generate(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def generate_token() -> str:
    """Generate a cryptographically random remote access token (256-bit)."""
    return _generate(_REMOTE_PREFIX)


def generate_session_token() -> str:
    """Generate a per-run session token distinguished by its prefix."""
    return _generate(_SESSION_PREFIX)


def _write_token_file(path: Path, token: str) -> None:
    """Atomically write the token file with user-only permissions.

    We create the file via ``os.open`` with mode 0600 (read/write for the
    owner, nothing for group/other). On POSIX this enforces same-user
    isolation on shared hosts — another local user cannot read the token
    and therefore cannot forge requests to our backend. On Windows the
    mode argument is ignored, but desktop users there are single-user in
    practice and NTFS ACLs inherit from the parent directory which Tauri
    places under ``%APPDATA%`` (per-user anyway).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a sibling temp file then rename — avoids the window where
    # the real file exists but is empty.
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps({"token": token}).encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(str(tmp), flags, 0o600)
    try:
        os.write(fd, payload)
    finally:
        os.close(fd)
    # Belt-and-braces: set mode again in case umask interfered.
    try:
        os.chmod(str(tmp), 0o600)
    except OSError:
        pass
    os.replace(str(tmp), str(path))


def save_token(token: str, path: Path) -> None:
    """Persist a token to disk with 0600 permissions."""
    _write_token_file(path, token)
    logger.info("Token saved to %s", path)


def load_token(path: Path) -> str | None:
    """Load a token from disk, or return None if not found / unreadable."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("token")
    except (json.JSONDecodeError, KeyError, OSError) as e:
        logger.warning("Failed to load token from %s: %s", path, e)
        return None


def delete_token(path: Path) -> None:
    """Delete a token file."""
    if path.exists():
        path.unlink()
        logger.info("Token file deleted: %s", path)


def rotate_token(path: Path) -> str:
    """Generate a new remote token, replacing the old one."""
    token = generate_token()
    save_token(token, path)
    return token


def ensure_session_token(path: Path) -> str:
    """Generate + persist a fresh session token on every call.

    Called from the app lifespan at startup. Each run gets a new token so
    a stale token cached somewhere (e.g. a terminated Tauri instance) is
    implicitly invalidated.
    """
    token = generate_session_token()
    _write_token_file(path, token)
    logger.info("Session token generated (0600): %s", path)
    return token


def validate_token(provided: str, expected: str) -> bool:
    """Constant-time token comparison to prevent timing attacks."""
    if not provided or not expected:
        return False
    return secrets.compare_digest(provided, expected)
