"""Workspace memory injection into system prompts.

Loads the per-workspace memory document from the database and wraps
it in a <workspace-memory> tag for inclusion in the system prompt.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.memory.config import get_memory_config
from app.memory.workspace_memory_storage import get_workspace_memory

logger = logging.getLogger(__name__)


async def build_workspace_memory_section(
    session_factory: async_sessionmaker[AsyncSession],
    workspace_path: str,
) -> str | None:
    """Build a workspace memory section for the system prompt.

    Returns a formatted string wrapped in <workspace-memory> tags,
    or None if memory is empty or disabled.
    """
    config = get_memory_config()
    if not config.enabled:
        return None

    if not workspace_path or workspace_path == ".":
        return None

    content = await get_workspace_memory(session_factory, workspace_path)
    if not content or not content.strip():
        return None

    return f"<workspace-memory>\n{content}\n</workspace-memory>"
