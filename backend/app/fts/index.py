"""IndexManager — built-in full-text search using SQLite FTS5.

Each workspace gets its own SQLite database stored centrally at
``data/fts/<hash>.db`` to avoid polluting the user's project directory.
Text is extracted from files using the built-in extractors and stored in an
FTS5 virtual table for fast keyword search.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Any

import aiosqlite

logger = logging.getLogger(__name__)

# Directories to skip during indexing
_SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__",
    ".venv", "venv", ".openyakdb", ".tox", "dist",
    "build", ".next", ".nuxt", "target", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "env",
}

# File extensions to skip (binary / media / archives)
_SKIP_EXTENSIONS = {
    ".pyc", ".pyo", ".so", ".dll", ".exe", ".bin", ".o", ".a",
    ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2", ".xz",
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac", ".ogg",
    ".woff", ".woff2", ".ttf", ".eot",
    ".db", ".sqlite", ".sqlite3",
}

def _max_text_size() -> int:
    from app.config import get_settings
    return get_settings().fts_max_file_size

_SCHEMA = """
CREATE TABLE IF NOT EXISTS fts_files (
    path    TEXT PRIMARY KEY,
    mtime   REAL NOT NULL,
    size    INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
    path,
    content,
    tokenize='unicode61 remove_diacritics 2'
);
"""


class IndexManager:
    """Manages per-workspace FTS5 indexes."""

    def __init__(self) -> None:
        self._dbs: dict[str, aiosqlite.Connection] = {}
        self._indexed: set[str] = set()
        self._file_counts: dict[str, int] = {}
        self._index_tasks: dict[str, asyncio.Task[None]] = {}
        self._watchers: dict[str, Any] = {}
        self._sessions: dict[str, str] = {}  # session_id -> workspace
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def ensure_index(self, workspace: str, session_id: str) -> None:
        """Ensure an index exists for *workspace*. Starts background indexing if needed."""
        async with self._lock:
            self._sessions[session_id] = workspace

            if workspace not in self._dbs:
                db = await self._open_db(workspace)
                self._dbs[workspace] = db

            if (
                workspace not in self._indexed
                and workspace not in self._index_tasks
            ):
                task = asyncio.create_task(
                    self._index_workspace(workspace),
                    name=f"fts-index-{Path(workspace).name}",
                )
                self._index_tasks[workspace] = task

    def index_status(self, session_id: str) -> dict[str, Any]:
        """Return indexing status for the workspace associated with *session_id*."""
        workspace = self._sessions.get(session_id)
        if not workspace:
            return {"status": "not_indexed"}

        file_count = self._file_counts.get(workspace)

        if workspace in self._indexed:
            result: dict[str, Any] = {"status": "indexed"}
            if file_count is not None:
                result["file_count"] = file_count
            return result

        task = self._index_tasks.get(workspace)
        if task is None:
            return {"status": "not_indexed"}
        if task.done():
            if task.exception():
                return {"status": "error", "error": str(task.exception())}
            result = {"status": "indexed"}
            if file_count is not None:
                result["file_count"] = file_count
            return result
        return {"status": "indexing"}

    async def search(
        self,
        workspace: str,
        query: str,
        *,
        path_filter: str | None = None,
        file_types: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Full-text search across indexed workspace files."""
        db = self._dbs.get(workspace)
        if db is None:
            return {"total": 0, "results": []}

        # Sanitize query for FTS5: quote each token to prevent syntax errors
        fts_query = _build_fts_query(query)
        if not fts_query:
            return {"total": 0, "results": []}

        sql = (
            "SELECT fc.path, "
            "snippet(fts_content, 1, '>>>', '<<<', '...', 64) AS highlight, "
            "rank "
            "FROM fts_content fc "
            "WHERE fts_content MATCH ?"
        )
        params: list[Any] = [fts_query]

        # Path filter
        if path_filter:
            sql += " AND fc.path LIKE ?"
            # Normalise to forward slashes for LIKE matching
            params.append(path_filter.replace("\\", "/") + "%")

        # File type filter
        if file_types:
            exts = [e.strip().lstrip(".") for e in file_types.split(",") if e.strip()]
            if exts:
                clauses = " OR ".join(["fc.path LIKE ?" for _ in exts])
                sql += f" AND ({clauses})"
                params.extend([f"%.{ext}" for ext in exts])

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        results: list[dict[str, Any]] = []
        try:
            async with db.execute(sql, params) as cursor:
                async for row in cursor:
                    file_path, highlight, rank = row
                    results.append({
                        "filename": file_path,
                        "highlight": highlight,
                        "relevance_score": -rank,  # FTS5 rank is negative (higher = better)
                    })
        except Exception as e:
            logger.error("FTS search failed: %s", e)
            return {"total": 0, "results": []}

        return {"total": len(results), "results": results}

    async def ingest_file(self, workspace: str, path: str) -> None:
        """Index a single file into the workspace FTS index."""
        db = self._dbs.get(workspace)
        if db is None:
            return
        await self._index_single_file(db, workspace, path)
        await db.commit()

    async def trigger_reindex(self, session_id: str) -> None:
        """Cancel any running index task and start a fresh one."""
        workspace = self._sessions.get(session_id)
        if not workspace:
            return

        old_task = self._index_tasks.get(workspace)
        if old_task and not old_task.done():
            old_task.cancel()
            try:
                await old_task
            except (asyncio.CancelledError, Exception):
                pass

        self._indexed.discard(workspace)
        self._index_tasks.pop(workspace, None)

        if workspace not in self._dbs:
            return

        task = asyncio.create_task(
            self._index_workspace(workspace),
            name=f"fts-reindex-{Path(workspace).name}",
        )
        self._index_tasks[workspace] = task

    async def cleanup_session(self, session_id: str) -> None:
        """Remove session tracking. The workspace index persists."""
        self._sessions.pop(session_id, None)

    async def shutdown(self) -> None:
        """Stop watchers, cancel tasks, close all DB connections."""
        for watcher in self._watchers.values():
            try:
                await watcher.stop()
            except Exception as e:
                logger.warning("Error stopping watcher: %s", e)
        self._watchers.clear()

        for task in self._index_tasks.values():
            if not task.done():
                task.cancel()
        if self._index_tasks:
            await asyncio.gather(*self._index_tasks.values(), return_exceptions=True)

        for ws, db in list(self._dbs.items()):
            try:
                await db.close()
            except Exception as e:
                logger.warning("Error closing FTS DB for %s: %s", ws, e)
        self._dbs.clear()
        self._sessions.clear()
        logger.info("IndexManager shut down")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _db_path(workspace: str) -> Path:
        """Return the centralized DB path for a workspace: ``data/fts/<hash>.db``."""
        ws_hash = hashlib.sha256(os.path.normpath(workspace).encode()).hexdigest()[:16]
        fts_dir = Path("data") / "fts"
        fts_dir.mkdir(parents=True, exist_ok=True)
        return fts_dir / f"{ws_hash}.db"

    async def _open_db(self, workspace: str) -> aiosqlite.Connection:
        """Open (or create) the FTS database for a workspace."""
        db_path = self._db_path(workspace)

        db = await aiosqlite.connect(str(db_path))
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")
        await db.executescript(_SCHEMA)
        await db.commit()
        return db

    async def _index_workspace(self, workspace: str) -> None:
        """Background task: index all workspace files, then start a watcher."""
        try:
            db = self._dbs.get(workspace)
            if db is None:
                return

            logger.info("FTS: starting background index (workspace: %s)", workspace)
            file_count = await self._reindex_workspace(workspace)
            self._indexed.add(workspace)
            self._file_counts[workspace] = file_count
            logger.info("FTS: indexing complete (%d files, workspace: %s)", file_count, workspace)

            # Start file watcher
            await self._start_watcher(workspace)

        except asyncio.CancelledError:
            logger.info("FTS: indexing cancelled (workspace: %s)", workspace)
            raise
        except Exception as e:
            logger.error("FTS: indexing failed (workspace: %s): %s", workspace, e)

    async def _reindex_workspace(self, workspace: str) -> int:
        """Scan workspace, index new/changed files, remove stale entries."""
        db = self._dbs.get(workspace)
        if db is None:
            return 0

        # Collect current files on disk
        disk_files: dict[str, tuple[float, int]] = {}  # path -> (mtime, size)
        ws_path = Path(workspace)

        for dirpath, dirnames, filenames in os.walk(workspace):
            # Prune skip directories in-place
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]

            for fname in filenames:
                ext = os.path.splitext(fname)[1].lower()
                if ext in _SKIP_EXTENSIONS:
                    continue

                full_path = os.path.join(dirpath, fname)
                try:
                    stat = os.stat(full_path)
                    # Use forward-slash relative path as key
                    rel = Path(full_path).relative_to(ws_path).as_posix()
                    disk_files[rel] = (stat.st_mtime, stat.st_size)
                except OSError:
                    continue

        # Load existing index state
        indexed_files: dict[str, float] = {}  # path -> mtime
        async with db.execute("SELECT path, mtime FROM fts_files") as cursor:
            async for row in cursor:
                indexed_files[row[0]] = row[1]

        # Determine changes
        to_add = []
        for rel, (mtime, size) in disk_files.items():
            old_mtime = indexed_files.get(rel)
            if old_mtime is None or abs(mtime - old_mtime) > 0.01:
                to_add.append((rel, mtime, size))

        to_remove = [p for p in indexed_files if p not in disk_files]

        # Remove stale entries
        for rel in to_remove:
            await db.execute("DELETE FROM fts_content WHERE path = ?", (rel,))
            await db.execute("DELETE FROM fts_files WHERE path = ?", (rel,))

        # Index new / changed files
        for rel, mtime, size in to_add:
            full_path = str(ws_path / rel)
            await self._index_single_file(db, workspace, full_path, rel_path=rel, mtime=mtime, size=size)

        await db.commit()
        return len(disk_files)

    async def _index_single_file(
        self,
        db: aiosqlite.Connection,
        workspace: str,
        full_path: str,
        *,
        rel_path: str | None = None,
        mtime: float | None = None,
        size: int | None = None,
    ) -> None:
        """Extract text from a file and upsert into FTS."""
        try:
            if rel_path is None:
                rel_path = Path(full_path).relative_to(Path(workspace)).as_posix()
            if mtime is None or size is None:
                stat = os.stat(full_path)
                mtime = stat.st_mtime
                size = stat.st_size

            text = await self._extract_text(full_path)
            if text is None:
                return

            # Truncate very large text
            if len(text) > _max_text_size():
                text = text[:_max_text_size()]

            # Upsert: delete old entry first (FTS5 doesn't support UPDATE)
            await db.execute("DELETE FROM fts_content WHERE path = ?", (rel_path,))
            await db.execute("DELETE FROM fts_files WHERE path = ?", (rel_path,))

            await db.execute(
                "INSERT INTO fts_content(path, content) VALUES (?, ?)",
                (rel_path, text),
            )
            await db.execute(
                "INSERT INTO fts_files(path, mtime, size) VALUES (?, ?, ?)",
                (rel_path, mtime, size),
            )
        except Exception as e:
            logger.debug("FTS: failed to index %s: %s", full_path, e)

    async def _extract_text(self, file_path: str) -> str | None:
        """Extract text content from a file."""
        from app.tool.extractors import extract_document, is_supported_binary

        ext = os.path.splitext(file_path)[1].lower()

        # Binary document formats (PDF, DOCX, XLSX, PPTX)
        if is_supported_binary(file_path):
            try:
                # Run in thread since extractors use synchronous I/O
                loop = asyncio.get_event_loop()
                return await loop.run_in_executor(None, extract_document, file_path)
            except Exception as e:
                logger.debug("FTS: extractor failed for %s: %s", file_path, e)
                return None

        # Text files
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                # Quick binary check on first chunk
                head = f.read(8192)
                if "\x00" in head:
                    return None  # likely binary
                rest = f.read()
                return head + rest
        except (OSError, PermissionError):
            return None

    async def _start_watcher(self, workspace: str) -> None:
        """Start a FileWatcher for *workspace* if not already running."""
        if workspace in self._watchers:
            return
        try:
            from app.fts.watcher import FileWatcher

            watcher = FileWatcher(workspace, self)
            await watcher.start()
            self._watchers[workspace] = watcher
        except Exception as e:
            logger.warning("FTS: failed to start watcher for %s: %s", workspace, e)


def _build_fts_query(query: str) -> str:
    """Convert a user query string into a safe FTS5 MATCH expression.

    Each word is double-quoted (preventing syntax errors from special chars)
    and joined with spaces (implicit AND).
    """
    # Split on whitespace, strip punctuation that isn't useful
    tokens = re.findall(r'[^\s"]+', query)
    if not tokens:
        return ""
    # Quote each token, escaping internal double-quotes
    quoted = ['"' + t.replace('"', '""') + '"' for t in tokens]
    return " ".join(quoted)
