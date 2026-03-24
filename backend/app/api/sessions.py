"""Session CRUD endpoints."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.pdf import markdown_to_pdf
from app.dependencies import get_db
from app.models.session import Session
from app.schemas.session import SessionCreate, SessionResponse, SessionSearchResult, SessionUpdate
from app.session.manager import (
    create_session,
    delete_session_uploads,
    get_messages,
    get_session,
    list_sessions,
    search_sessions,
    update_session_title,
)
from app.storage.repository import delete_by_id

log = logging.getLogger(__name__)

router = APIRouter()


def _trigger_index(request: Request, directory: str | None, session_id: str | None = None) -> None:
    """Fire-and-forget: start FTS indexing for *directory* if enabled."""
    if not directory or not session_id:
        return
    manager = getattr(request.app.state, "index_manager", None)
    if manager is None:
        return
    import asyncio
    asyncio.create_task(
        manager.ensure_index(directory, session_id),
        name=f"fts-trigger-{session_id[:12]}",
    )


@router.get("/sessions", response_model=list[SessionResponse])
async def list_sessions_endpoint(
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
    offset: int = 0,
    project_id: str | None = None,
) -> list[SessionResponse]:
    """List sessions."""
    sessions = await list_sessions(db, limit=limit, offset=offset, project_id=project_id)
    return [SessionResponse.model_validate(s) for s in sessions]


@router.get("/sessions/search", response_model=list[SessionSearchResult])
async def search_sessions_endpoint(
    q: str,
    db: AsyncSession = Depends(get_db),
    limit: int = 20,
    offset: int = 0,
) -> list[SessionSearchResult]:
    """Search sessions by title and message content."""
    if not q.strip():
        return []
    results = await search_sessions(db, q.strip(), limit=limit, offset=offset)
    return [
        SessionSearchResult(
            session=SessionResponse.model_validate(r["session"]),
            snippet=r["snippet"],
        )
        for r in results
    ]


@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session_endpoint(
    request: Request,
    body: SessionCreate,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Create a new session."""
    session = await create_session(
        db,
        project_id=body.project_id,
        directory=body.directory,
        title=body.title,
    )
    _trigger_index(request, body.directory, session.id)
    return SessionResponse.model_validate(session)


@router.get("/sessions/{session_id}", response_model=SessionResponse)
async def get_session_endpoint(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Get session details."""
    session = await get_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionResponse.model_validate(session)


@router.patch("/sessions/{session_id}", response_model=SessionResponse)
async def update_session_endpoint(
    request: Request,
    session_id: str,
    body: SessionUpdate,
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Update session fields."""
    session = await get_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if body.title is not None:
        session.title = body.title
    if body.directory is not None:
        session.directory = body.directory
        _trigger_index(request, body.directory, session_id)
    if body.time_archived is not None:
        session.time_archived = body.time_archived
    if body.permission is not None:
        session.permission = body.permission

    await db.flush()
    await db.refresh(session)
    return SessionResponse.model_validate(session)


@router.get("/sessions/{session_id}/todos")
async def get_session_todos(
    session_id: str,
    request: Request,
) -> dict:
    """Get current todo list for a session."""
    from app.tool.builtin.todo import get_todos

    session_factory = getattr(request.app.state, "session_factory", None)
    if session_factory is None:
        return {"todos": []}
    todos = await get_todos(session_id, session_factory)
    return {"todos": todos}


@router.get("/sessions/{session_id}/files")
async def get_session_files(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Get workspace files for a session by scanning openyak_written/ directory."""
    import os
    from pathlib import Path

    session = await get_session(db, session_id)
    if session is None or not session.directory:
        return {"files": []}

    output_dir = Path(session.directory).resolve() / "openyak_written"
    if not output_dir.is_dir():
        return {"files": []}

    files = []
    for entry in sorted(output_dir.iterdir(), key=lambda e: e.stat().st_mtime):
        if entry.is_file():
            files.append({
                "name": entry.name,
                "path": str(entry),
                "type": "generated",
            })
    return {"files": files}


@router.delete("/sessions/{session_id}")
async def delete_session_endpoint(
    session_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete a session and its associated upload files."""
    # Abort any running generation streams for this session first
    # to prevent FK constraint errors from in-flight DB writes.
    from app.streaming.manager import StreamManager

    sm: StreamManager | None = getattr(request.app.state, "stream_manager", None)
    if sm is not None:
        sm.abort_session(session_id)

    await delete_session_uploads(db, session_id)
    deleted = await delete_by_id(db, Session, session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")

    # Clean up FTS resources for this session
    index_manager = getattr(request.app.state, "index_manager", None)
    if index_manager is not None:
        try:
            await index_manager.cleanup_session(session_id)
        except Exception:
            pass

    return {"deleted": True}


# ---------------------------------------------------------------------------
# Conversation export
# ---------------------------------------------------------------------------


def _messages_to_markdown(title: str, messages: list) -> str:
    """Convert a list of Message ORM objects into a formatted markdown string."""
    now_str = datetime.now(timezone.utc).strftime("%B %d, %Y at %I:%M %p UTC")
    lines = [f"# {title}", f"*Exported on {now_str}*", "", "---", ""]

    for msg in messages:
        data = msg.data or {}
        role = data.get("role", "user")
        label = "You" if role == "user" else "Assistant"

        # Collect text parts only — skip reasoning, tools, steps, etc.
        text_parts: list[str] = []
        for part in msg.parts:
            pd = part.data or {}
            if pd.get("type") == "text":
                text = pd.get("text", "").strip()
                if text:
                    text_parts.append(text)

        if not text_parts:
            continue

        lines.append(f"**{label}:**")
        lines.append("")
        lines.append("\n\n".join(text_parts))
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


@router.get("/sessions/{session_id}/export-pdf")
async def export_session_pdf(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Export an entire conversation as a formatted PDF."""
    session = await get_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    messages = await get_messages(db, session_id)
    title = session.title or "Conversation"

    try:
        md_content = _messages_to_markdown(title, messages)
        pdf_bytes = markdown_to_pdf(md_content)

        # RFC 5987: filename for ASCII fallback, filename* for UTF-8 (Unicode titles)
        from urllib.parse import quote
        safe_title = "".join(
            c if c.isascii() and (c.isalnum() or c in " _-") else "_" for c in title
        )
        utf8_title = quote(title, safe="")

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{safe_title}.pdf"; '
                    f"filename*=UTF-8''{utf8_title}.pdf"
                ),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Session PDF export failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
