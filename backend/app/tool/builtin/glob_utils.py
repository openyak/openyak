"""Shared glob utilities with bash-compatible brace expansion."""

from __future__ import annotations

from pathlib import Path

from wcmatch import glob as wc_glob

# Common flags: brace expansion + recursive ** + match dotfiles
_FLAGS = wc_glob.BRACE | wc_glob.GLOBSTAR | wc_glob.DOTGLOB


def wc_glob_files(base: Path, pattern: str, recursive: bool = False) -> list[Path]:
    """Run a bash-compatible glob and return matching *file* paths.

    Parameters
    ----------
    base:
        Root directory to search in.
    pattern:
        Glob pattern, may include ``{a,b,c}`` brace expansion.
    recursive:
        When *True* and the pattern does not already start with ``**/``,
        automatically prepend ``**/`` so it behaves like ``rglob``.
    """
    if recursive and not pattern.startswith("**"):
        pattern = f"**/{pattern}"

    raw = wc_glob.glob(pattern, root_dir=str(base), flags=_FLAGS)
    return [base / r for r in raw]
