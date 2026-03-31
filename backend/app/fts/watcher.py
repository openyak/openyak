"""File watcher for incremental FTS index updates.

Polls workspace directories every 30 seconds and triggers incremental
re-indexing so the FTS index stays in sync with the filesystem.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.fts.index import IndexManager

logger = logging.getLogger(__name__)

def _poll_interval() -> float:
    from app.config import get_settings
    return get_settings().fts_poll_interval


class FileWatcher:
    """Watches a workspace directory and incrementally updates the FTS index."""

    def __init__(self, workspace: str, index_manager: IndexManager) -> None:
        self._workspace = workspace
        self._index_manager = index_manager
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(
            self._poll_loop(),
            name=f"fts-watch-{self._workspace}",
        )
        logger.info("FileWatcher started for %s", self._workspace)

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        logger.info("FileWatcher stopped for %s", self._workspace)

    async def _poll_loop(self) -> None:
        """Re-index every 30 seconds until stopped."""
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=_poll_interval())
                break
            except asyncio.TimeoutError:
                pass

            try:
                await self._index_manager._reindex_workspace(self._workspace)
                logger.debug("FTS: incremental re-index complete for %s", self._workspace)
            except Exception as e:
                logger.warning("FTS: incremental re-index failed for %s: %s", self._workspace, e)
