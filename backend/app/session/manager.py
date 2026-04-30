"""Session CRUD and message persistence."""

from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.message import Message, Part
from app.models.session import Session
from app.storage.repository import create, get_all, get_by_id
from app.utils.id import generate_ulid

logger = logging.getLogger(__name__)


async def create_session(
    db: AsyncSession,
    *,
    id: str | None = None,
    project_id: str | None = None,
    directory: str | None = None,
    title: str | None = None,
    parent_id: str | None = None,
) -> Session:
    """Create a new session."""
    session = Session(
        id=id or generate_ulid(),
        project_id=project_id,
        parent_id=parent_id,
        directory=directory,
        title=title,
    )
    return await create(db, session)


async def get_session(db: AsyncSession, session_id: str) -> Session | None:
    """Get a session by ID."""
    return await get_by_id(db, Session, session_id)


async def list_sessions(
    db: AsyncSession,
    *,
    limit: int = 50,
    offset: int = 0,
    project_id: str | None = None,
) -> list[Session]:
    """List sessions with optional project filter. Pinned sessions first."""
    stmt = select(Session).where(Session.parent_id.is_(None))
    if project_id:
        stmt = stmt.where(Session.project_id == project_id)
    stmt = stmt.order_by(
        Session.is_pinned.desc(),
        Session.time_created.desc(),
    ).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def search_sessions(
    db: AsyncSession,
    query: str,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Search sessions by title and message text content.

    Returns a list of dicts with 'session' (Session) and 'snippet' (str|None).
    Content matches include a text excerpt; title-only matches have snippet=None.
    """
    # Single query that returns all session columns + snippet,
    # avoiding the N+1 problem of looping get_by_id per result.
    stmt = text("""
        SELECT s.id, s.project_id, s.parent_id, s.slug, s.directory,
               s.title, s.version,
               s.summary_additions, s.summary_deletions,
               s.summary_files, s.summary_diffs, s.permission,
               s.time_created, s.time_updated,
               s.time_compacting, s.time_archived,
               snippet
        FROM (
            SELECT DISTINCT s.*, SUBSTR(
                json_extract(p.data, '$.text'),
                MAX(1, INSTR(LOWER(json_extract(p.data, '$.text')), LOWER(:query)) - 40),
                120
            ) as snippet
            FROM session s
            JOIN message m ON m.session_id = s.id
            JOIN part p ON p.message_id = m.id
            WHERE json_extract(p.data, '$.type') = 'text'
              AND LOWER(json_extract(p.data, '$.text')) LIKE LOWER(:pattern)
              AND s.time_archived IS NULL
              AND s.parent_id IS NULL

            UNION

            SELECT DISTINCT s.*, NULL as snippet
            FROM session s
            WHERE LOWER(s.title) LIKE LOWER(:pattern)
              AND s.time_archived IS NULL
              AND s.parent_id IS NULL
        ) s
        GROUP BY s.id
        ORDER BY s.time_updated DESC
        LIMIT :limit OFFSET :offset
    """)

    result = await db.execute(
        stmt, {"query": query, "pattern": f"%{query}%", "limit": limit, "offset": offset}
    )
    rows = result.mappings().all()

    # Hydrate Session ORM objects from the raw rows in a single pass
    session_ids = [row["id"] for row in rows]
    if not session_ids:
        return []
    sessions_stmt = (
        select(Session)
        .where(Session.id.in_(session_ids))
    )
    sessions_result = await db.execute(sessions_stmt)
    session_map = {s.id: s for s in sessions_result.scalars().all()}

    results: list[dict[str, Any]] = []
    for row in rows:
        session = session_map.get(row["id"])
        if session:
            results.append({
                "session": session,
                "snippet": row["snippet"],
            })
    return results


async def update_session_title(
    db: AsyncSession, session_id: str, title: str,
) -> None:
    """Update session title."""
    session = await get_by_id(db, Session, session_id)
    if session:
        session.title = title
        await db.flush()


# --- Messages ---

async def create_message(
    db: AsyncSession,
    *,
    session_id: str,
    data: dict[str, Any],
) -> Message:
    """Create a new message."""
    msg = Message(
        id=generate_ulid(),
        session_id=session_id,
        data=data,
    )
    return await create(db, msg)


async def create_part(
    db: AsyncSession,
    *,
    message_id: str,
    session_id: str,
    data: dict[str, Any],
    part_id: str | None = None,
) -> Part:
    """Create a new message part.

    Pass *part_id* to pre-assign an ID (used by the ToolPart state machine so the
    pending Part can be updated to running → completed in subsequent transactions).
    """
    part = Part(
        id=part_id or generate_ulid(),
        message_id=message_id,
        session_id=session_id,
        data=data,
    )
    return await create(db, part)


async def update_part_data(
    db: AsyncSession,
    part_id: str,
    data: dict[str, Any],
) -> Part | None:
    """Replace the data dict of an existing part.

    Used by the ToolPart state machine to advance pending→running→completed/error.
    """
    from app.models.message import Part as PartModel  # local import avoids top-level cycle

    part = await db.get(PartModel, part_id)
    if part:
        # Reassign the entire dict to trigger SQLAlchemy's JSON mutation tracking
        part.data = data
    return part


def _delete_upload_files(parts: list[Part]) -> None:
    """Delete physical upload files referenced by the given parts.

    Only deletes files with source == "uploaded" (or missing source field,
    for backward compat).  Referenced files are NEVER deleted.
    """
    from app.api.files import remove_from_hash_index

    for part in parts:
        data = part.data or {}
        if data.get("type") == "file":
            source = data.get("source", "uploaded")
            if source != "uploaded":
                continue  # Never delete referenced files
            file_path = data.get("path")
            if file_path:
                try:
                    Path(file_path).unlink(missing_ok=True)
                    remove_from_hash_index(data.get("content_hash"))
                except OSError:
                    logger.warning("Failed to delete upload file: %s", file_path)


async def delete_session_uploads(db: AsyncSession, session_id: str) -> None:
    """Delete all physical upload files associated with a session."""
    stmt = select(Part).where(Part.session_id == session_id)
    result = await db.execute(stmt)
    _delete_upload_files(list(result.scalars().all()))


async def delete_messages_after(
    db: AsyncSession,
    session_id: str,
    after_message_id: str,
) -> int:
    """Delete all messages in a session created after the given message.

    Parts cascade-delete automatically via the ORM relationship.
    Upload files are cleaned up from disk before deletion.
    Returns the number of messages deleted.
    """
    target = await get_by_id(db, Message, after_message_id)
    if target is None or target.session_id != session_id:
        raise ValueError(f"Message {after_message_id} not found in session {session_id}")

    stmt = (
        select(Message)
        .where(
            Message.session_id == session_id,
            Message.time_created > target.time_created,
        )
        .options(selectinload(Message.parts))
    )
    result = await db.execute(stmt)
    messages_to_delete = list(result.scalars().all())

    # Clean up upload files before deleting DB records
    for msg in messages_to_delete:
        _delete_upload_files(msg.parts)

    for msg in messages_to_delete:
        await db.delete(msg)

    await db.flush()
    return len(messages_to_delete)


async def update_message_text(
    db: AsyncSession,
    message_id: str,
    new_text: str,
) -> None:
    """Update the text content of a user message's text part."""
    stmt = select(Part).where(Part.message_id == message_id)
    result = await db.execute(stmt)
    parts = list(result.scalars().all())

    for part in parts:
        if part.data and part.data.get("type") == "text":
            part.data = {"type": "text", "text": new_text}
            await db.flush()
            return

    # No text part found — create one
    msg = await get_by_id(db, Message, message_id)
    if msg is None:
        raise ValueError(f"Message {message_id} not found")
    await create_part(
        db,
        message_id=message_id,
        session_id=msg.session_id,
        data={"type": "text", "text": new_text},
    )


async def update_message_file_parts(
    db: AsyncSession,
    message_id: str,
    session_id: str,
    attachments: list[dict],
) -> None:
    """Replace all file parts on a message with new attachments."""
    # Delete existing file parts
    stmt = select(Part).where(Part.message_id == message_id)
    result = await db.execute(stmt)
    parts = list(result.scalars().all())
    for part in parts:
        if part.data and part.data.get("type") == "file":
            await db.delete(part)

    # Create new file parts
    for att in attachments:
        await create_part(
            db,
            message_id=message_id,
            session_id=session_id,
            data={
                "type": "file",
                "file_id": att.get("file_id", ""),
                "name": att.get("name", ""),
                "path": att.get("path", ""),
                "size": att.get("size", 0),
                "mime_type": att.get("mime_type", ""),
                "source": att.get("source", "uploaded"),
                "content_hash": att.get("content_hash"),
            },
        )


async def count_messages(db: AsyncSession, session_id: str) -> int:
    """Count messages in a session."""
    stmt = select(func.count()).select_from(Message).where(Message.session_id == session_id)
    result = await db.execute(stmt)
    return result.scalar_one()


async def get_messages(
    db: AsyncSession,
    session_id: str,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> list[Message]:
    """Get messages for a session with their parts.

    When limit is None, returns all messages (backwards-compatible).
    When offset is negative, it is treated as "latest page":
    the actual offset is calculated as max(0, total - limit).
    """
    stmt = (
        select(Message)
        .where(Message.session_id == session_id)
        .options(selectinload(Message.parts))
        .order_by(Message.time_created.asc())
    )
    if limit is not None:
        if offset < 0:
            total = await count_messages(db, session_id)
            offset = max(0, total - limit)
        stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_message_history_for_llm(
    db: AsyncSession,
    session_id: str,
) -> list[dict[str, Any]]:
    """Load message history formatted for LLM consumption.

    Converts stored messages/parts into the OpenAI message format:
    [{role: "user", content: "..."}, {role: "assistant", content: "..."}, ...]
    """
    messages = await get_messages(db, session_id)
    llm_messages = []

    # After a compaction summary is written, that summary becomes the new
    # history anchor. Everything before it has already been summarized and
    # should not be fed back to the model again.
    compaction_anchor = 0
    for i, msg in enumerate(messages):
        has_compaction_part = any(
            p.data and p.data.get("type") == "compaction"
            for p in msg.parts
        )
        has_summary_text = any(
            p.data
            and p.data.get("type") == "text"
            and str(p.data.get("text", "")).startswith("[Context Summary]")
            for p in msg.parts
        )
        if has_compaction_part and has_summary_text:
            compaction_anchor = i

    if compaction_anchor:
        messages = messages[compaction_anchor:]

    max_assistant_text_chars = 40_000
    max_tool_output_chars = 20_000

    def trim_for_context(text: str, limit: int, kind: str) -> str:
        if len(text) <= limit:
            return text
        head_len = int(limit * 0.75)
        tail_len = max(0, limit - head_len)
        head = text[:head_len]
        tail = text[-tail_len:] if tail_len > 0 else ""
        return (
            f"{head}\n\n"
            f"[{kind} truncated for context: original {len(text)} chars, kept {limit}]\n\n"
            f"{tail}"
        )

    for msg in messages:
        data = msg.data or {}
        role = data.get("role", "user")

        if role == "user":
            # Find text parts for user message
            text_parts = [
                p.data.get("text", "") for p in msg.parts
                if p.data and p.data.get("type") == "text"
            ]
            content = "\n".join(text_parts) if text_parts else ""

            # Find file parts
            file_parts = [
                p.data for p in msg.parts
                if p.data and p.data.get("type") == "file"
            ]

            if file_parts:
                content_array = _build_user_content_with_files(content, file_parts)
                if content_array:
                    llm_messages.append({"role": "user", "content": content_array})
            elif content:
                llm_messages.append({"role": "user", "content": content})

        elif role == "assistant":
            # Collect assistant text and tool calls
            text_parts = []
            tool_calls = []
            tool_results = []

            for part in msg.parts:
                part_data = part.data or {}
                part_type = part_data.get("type")

                if part_type == "text":
                    text_parts.append(part_data.get("text", ""))
                elif part_type == "tool":
                    tool_name = part_data.get("tool", "")
                    call_id = part_data.get("call_id", "")
                    state = part_data.get("state", {})

                    # Tool call from assistant
                    tool_calls.append({
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": _serialize_args(state.get("input", {})),
                        },
                    })

                    # Tool result
                    output = state.get("output", "")
                    if state.get("time_compacted"):
                        output = "[truncated]"
                    output = trim_for_context(output or "", max_tool_output_chars, "tool output")

                    # Check for image data in tool metadata (from read tool)
                    metadata = state.get("metadata") or {}
                    image_data_url = metadata.get("image_data_url")

                    if image_data_url:
                        # Multimodal tool result: text + image
                        tool_results.append({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": [
                                {"type": "text", "text": output or "(image)"},
                                {"type": "image_url", "image_url": {"url": image_data_url}},
                            ],
                        })
                    else:
                        tool_results.append({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": output or "(no output)",
                        })

            # Build assistant message
            if text_parts or tool_calls:
                assistant_content = "\n".join(text_parts) if text_parts else ""
                if assistant_content:
                    assistant_content = trim_for_context(
                        assistant_content,
                        max_assistant_text_chars,
                        "assistant message",
                    )
                assistant_msg: dict[str, Any] = {
                    "role": "assistant",
                    "content": assistant_content,
                }
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls
                llm_messages.append(assistant_msg)

            # Append tool results
            llm_messages.extend(tool_results)

    return llm_messages


def _serialize_args(args: dict[str, Any]) -> str:
    """Serialize tool arguments to JSON string."""
    import json
    return json.dumps(args)


# ---------------------------------------------------------------------------
# File attachment helpers
# ---------------------------------------------------------------------------

_TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
    ".toml", ".md", ".txt", ".csv", ".html", ".css", ".scss",
    ".xml", ".sql", ".sh", ".bash", ".rs", ".go", ".java", ".c",
    ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt", ".r",
    ".env", ".gitignore", ".cfg", ".ini", ".log", ".conf",
}

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

# Data files: show only preview + nudge to code_execute for full analysis
_DATA_EXTENSIONS = {".csv", ".tsv"}

_SMALL_FILE_LINES = 200
_PREVIEW_LINES = 100
_DATA_PREVIEW_LINES = 11  # Header + 10 data rows


def _build_user_content_with_files(
    text: str,
    file_parts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build a multimodal content array with text + file contents.

    Strategy:
      - Small text files (< 200 lines): inline full content in XML tags
      - Large text files: first 100 lines + "use Read tool for full content"
      - Images: base64 image_url for vision models
      - Binary files: path reference + note to use Read tool
    """
    content: list[dict[str, Any]] = []

    if text:
        content.append({"type": "text", "text": text})

    for fp in file_parts:
        name = fp.get("name", "")
        path = fp.get("path", "")
        mime = fp.get("mime_type", "")
        size = fp.get("size", 0)
        ext = Path(name).suffix.lower()

        if mime == "inode/directory" or (path and Path(path).is_dir()):
            content.append({
                "type": "text",
                "text": (
                    f'\n<directory name="{name}" path="{path}">\n'
                    f'[Directory attached. Use the Read, Glob, Grep, or code_execute tools with this path to inspect its contents.]\n'
                    f"</directory>\n"
                ),
            })

        elif ext in _IMAGE_EXTENSIONS or mime.startswith("image/"):
            # Image: base64 encode for vision
            try:
                raw = Path(path).read_bytes()
                b64 = base64.b64encode(raw).decode("utf-8")
                img_mime = mime if mime.startswith("image/") else f"image/{ext.lstrip('.')}"
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{img_mime};base64,{b64}",
                    },
                })
            except Exception:
                logger.warning("Failed to read image file: %s", path)
                content.append({
                    "type": "text",
                    "text": (
                        f'\n<file name="{name}" path="{path}">\n'
                        f"[Image file — could not read. Use the Read tool to view it.]\n"
                        f"</file>\n"
                    ),
                })

        elif ext in _DATA_EXTENSIONS:
            # Data file (CSV/TSV): show preview only, nudge to code_execute
            try:
                file_text = Path(path).read_text(encoding="utf-8", errors="replace")
                lines = file_text.splitlines()
                total_lines = len(lines)
                preview = "\n".join(lines[:_DATA_PREVIEW_LINES])
                content.append({
                    "type": "text",
                    "text": (
                        f'\n<file name="{name}" path="{path}" lines="{total_lines}" showing="1-{min(total_lines, _DATA_PREVIEW_LINES)}">\n'
                        f"{preview}\n"
                        f"</file>\n"
                        f"[Data file with {total_lines} rows. "
                        f'Use code_execute with `pd.read_csv("{path}")` to analyze the full dataset. '
                        f"Do NOT calculate from this preview.]\n"
                    ),
                })
            except Exception:
                logger.warning("Failed to read data file: %s", path)
                content.append({
                    "type": "text",
                    "text": (
                        f'\n<file name="{name}" path="{path}">\n'
                        f'[Data file. Use code_execute with pd.read_csv("{path}") to analyze it.]\n'
                        f"</file>\n"
                    ),
                })

        elif ext in _TEXT_EXTENSIONS or mime.startswith("text/"):
            # Text file: read and inline
            try:
                file_text = Path(path).read_text(encoding="utf-8", errors="replace")
                lines = file_text.splitlines()

                if len(lines) <= _SMALL_FILE_LINES:
                    content.append({
                        "type": "text",
                        "text": (
                            f'\n<file name="{name}" path="{path}" lines="{len(lines)}">\n'
                            f"{file_text}\n"
                            f"</file>\n"
                        ),
                    })
                else:
                    preview = "\n".join(lines[:_PREVIEW_LINES])
                    content.append({
                        "type": "text",
                        "text": (
                            f'\n<file name="{name}" path="{path}" lines="{len(lines)}" showing="1-{_PREVIEW_LINES}">\n'
                            f"{preview}\n"
                            f"</file>\n"
                            f'[File has {len(lines)} total lines. Use the Read tool with file_path="{path}" to see the full content.]\n'
                        ),
                    })
            except Exception:
                logger.warning("Failed to read text file: %s", path)
                content.append({
                    "type": "text",
                    "text": (
                        f'\n<file name="{name}" path="{path}">\n'
                        f'[Could not read file. Use the Read tool with file_path="{path}" to access it.]\n'
                        f"</file>\n"
                    ),
                })
        else:
            # Binary / unknown: path reference only
            content.append({
                "type": "text",
                "text": (
                    f'\n<file name="{name}" path="{path}" size="{size}" mime="{mime}">\n'
                    f'[Binary file. Use the Read tool with file_path="{path}" to access it.]\n'
                    f"</file>\n"
                ),
            })

    return content
