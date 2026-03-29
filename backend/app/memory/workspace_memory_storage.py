"""CRUD operations for workspace-scoped memory."""

from __future__ import annotations

import logging
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.memory.workspace_memory_model import WorkspaceMemory
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)

MAX_WORKSPACE_MEMORY_LINES = 200


def _normalize_path(path: str) -> str:
    """Normalize a workspace path for consistent DB lookups.

    Converts backslashes to forward slashes, resolves '.' and '..',
    and strips trailing slashes so that the same physical directory
    always maps to the same key regardless of how the caller specified it.
    """
    # Use PureWindowsPath to handle both / and \ then convert to posix
    p = PureWindowsPath(path)
    # Normalize .. and . components via PurePosixPath
    normalized = PurePosixPath(p.as_posix())
    return str(normalized).rstrip("/")


def _enforce_line_cap(content: str, max_lines: int = MAX_WORKSPACE_MEMORY_LINES) -> str:
    """Truncate content to at most *max_lines* lines."""
    lines = content.split("\n")
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    return "\n".join(lines)


async def get_workspace_memory(
    session_factory: async_sessionmaker[AsyncSession],
    workspace_path: str,
) -> str | None:
    """Load the memory content for a workspace. Returns None if not found."""
    key = _normalize_path(workspace_path)
    async with session_factory() as db:
        async with db.begin():
            stmt = select(WorkspaceMemory.content).where(
                WorkspaceMemory.workspace_path == key
            )
            return (await db.execute(stmt)).scalar_one_or_none()


async def get_workspace_memory_with_timestamp(
    session_factory: async_sessionmaker[AsyncSession],
    workspace_path: str,
) -> tuple[str | None, str | None]:
    """Load memory content and time_updated. Returns (content, time_updated_iso)."""
    key = _normalize_path(workspace_path)
    async with session_factory() as db:
        async with db.begin():
            stmt = select(WorkspaceMemory).where(
                WorkspaceMemory.workspace_path == key
            )
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None, None
            ts = row.time_updated.isoformat() if row.time_updated else None
            return row.content, ts


async def upsert_workspace_memory(
    session_factory: async_sessionmaker[AsyncSession],
    workspace_path: str,
    content: str,
) -> None:
    """Insert or update the memory for a workspace.

    Content is truncated to MAX_WORKSPACE_MEMORY_LINES before writing.
    """
    key = _normalize_path(workspace_path)
    content = _enforce_line_cap(content.strip())

    async with session_factory() as db:
        async with db.begin():
            stmt = select(WorkspaceMemory).where(
                WorkspaceMemory.workspace_path == key
            )
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row:
                row.content = content
            else:
                db.add(WorkspaceMemory(
                    id=generate_ulid(),
                    workspace_path=key,
                    content=content,
                ))


async def list_workspace_memories(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[dict[str, Any]]:
    """List all workspace memories with path, preview, and timestamps."""
    async with session_factory() as db:
        async with db.begin():
            stmt = select(WorkspaceMemory).order_by(
                WorkspaceMemory.time_updated.desc()
            )
            rows = (await db.execute(stmt)).scalars().all()
            return [
                {
                    "workspace_path": r.workspace_path,
                    "content": r.content,
                    "line_count": len(r.content.split("\n")) if r.content else 0,
                    "time_updated": r.time_updated.isoformat() if r.time_updated else None,
                }
                for r in rows
            ]


async def delete_workspace_memory(
    session_factory: async_sessionmaker[AsyncSession],
    workspace_path: str,
) -> bool:
    """Delete the memory for a workspace. Returns True if a row was removed."""
    key = _normalize_path(workspace_path)
    async with session_factory() as db:
        async with db.begin():
            result = await db.execute(
                delete(WorkspaceMemory).where(
                    WorkspaceMemory.workspace_path == key
                )
            )
            return result.rowcount > 0
