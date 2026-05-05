"""Session CRUD endpoints."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.api.pdf import markdown_to_pdf
from app.errors import Conflict, DomainError, InternalError, NotFound, UpstreamError
from app.dependencies import (
    AgentRegistryDep,
    ProviderRegistryDep,
    SessionFactoryDep,
    StreamManagerDep,
    get_db,
    get_index_manager,
)
from app.models.session import Session
from app.models.session_file import SessionFile
from app.schemas.session import SessionCreate, SessionResponse, SessionSearchResult, SessionUpdate
from app.session.compaction import run_compaction
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
from app.streaming.manager import GenerationJob
from app.utils.id import generate_ulid

log = logging.getLogger(__name__)

router = APIRouter()
_PATH_PATTERN = re.compile(r"(/[^\s`]+?\.[A-Za-z0-9]{1,10})")
_CREATION_HINT_PATTERN = re.compile(
    r"\b(created?|written|saved|generated|exported|output)\b",
    re.IGNORECASE,
)
_CREATED_IN_PATTERN = re.compile(
    r"created in\s+([^\s`]+)",
    re.IGNORECASE,
)
_BULLET_FILENAME_PATTERN = re.compile(
    r"^\s*[-*•]\s+([A-Za-z0-9_\- .]+\.[A-Za-z0-9]{1,10})\s*$"
)


class SessionCompactionRequest(BaseModel):
    model_id: str | None = None


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


def _extract_file_paths_from_messages(messages: list, session_directory: str | None) -> list[str]:
    """Best-effort recovery of files that were created during older sessions.

    This is intentionally conservative: it should recover explicit creation
    outputs from older code_execute-style sessions, but it must not treat files
    merely *read* during analysis as generated workspace files.
    """
    if not session_directory:
        return []

    base_dir = str(Path(session_directory).resolve())
    found: list[str] = []
    seen: set[str] = set()

    for msg in messages:
        for part in getattr(msg, "parts", []):
            data = getattr(part, "data", {}) or {}
            payload = ""

            if data.get("type") == "tool":
                tool_name = str(data.get("tool", ""))
                if tool_name not in {"code_execute", "write", "edit", "artifact", "bash"}:
                    continue
                state = data.get("state") or {}
                payload = str(state.get("output", ""))
            elif data.get("type") == "text":
                payload = str(data.get("text", ""))
                if not _CREATION_HINT_PATTERN.search(payload):
                    continue
            else:
                continue

            # Case 1: direct absolute paths in explicit creation/writing context.
            for raw_match in _PATH_PATTERN.findall(payload):
                candidate = str(Path(raw_match).resolve())
                if not Path(candidate).is_file():
                    continue
                if not candidate.startswith(base_dir):
                    continue
                if candidate in seen:
                    continue
                seen.add(candidate)
                found.append(candidate)

            # Case 2: assistant summaries like:
            # "Created in /path/to/dir:" + bullet list of filenames
            created_in_match = _CREATED_IN_PATTERN.search(payload)
            if created_in_match:
                target_dir = str(Path(created_in_match.group(1)).resolve())
                if target_dir.startswith(base_dir) and Path(target_dir).is_dir():
                    for line in payload.splitlines():
                        bullet_match = _BULLET_FILENAME_PATTERN.match(line)
                        if not bullet_match:
                            continue
                        candidate = str((Path(target_dir) / bullet_match.group(1)).resolve())
                        if not Path(candidate).is_file():
                            continue
                        if candidate in seen:
                            continue
                        seen.add(candidate)
                        found.append(candidate)

    return found


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
        raise NotFound("Session not found")
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
        raise NotFound("Session not found")

    original_time_updated = session.time_updated
    metadata_only_fields = {"is_pinned", "time_archived"}
    preserve_time_updated = bool(body.model_fields_set) and body.model_fields_set <= metadata_only_fields

    if body.title is not None:
        session.title = body.title
    if body.directory is not None:
        session.directory = body.directory
        _trigger_index(request, body.directory, session_id)
    if "time_archived" in body.model_fields_set:
        session.time_archived = body.time_archived
    if body.is_pinned is not None:
        session.is_pinned = body.is_pinned
    if body.permission is not None:
        session.permission = body.permission
    if preserve_time_updated:
        session.time_updated = original_time_updated
        flag_modified(session, "time_updated")

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
    """Get tracked workspace files for a session."""

    session = await get_session(db, session_id)
    if session is None or not session.directory:
        return {"files": []}

    tracked = await db.execute(
        select(SessionFile)
        .where(SessionFile.session_id == session_id)
        .order_by(SessionFile.time_created.asc())
    )
    tracked_files = tracked.scalars().all()
    files: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    for entry in tracked_files:
        resolved = str(Path(entry.file_path).resolve())
        if resolved in seen_paths or not Path(resolved).is_file():
            continue
        seen_paths.add(resolved)
        files.append({
            "name": entry.file_name,
            "path": resolved,
            "type": entry.file_type,
            "tool": entry.tool_id,
        })

    # Backward-compatible fallback for older sessions that were never tracked.
    output_dir = Path(session.directory).resolve() / "openyak_written"
    if output_dir.is_dir():
        for entry in sorted(output_dir.iterdir(), key=lambda e: e.stat().st_mtime):
            resolved = str(entry.resolve())
            if not entry.is_file() or resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            files.append({
                "name": entry.name,
                "path": resolved,
                "type": "generated",
                "tool": "artifact",
            })

    # Legacy fallback for older code_execute-created files: recover paths from
    # persisted tool outputs and assistant text when SessionFile tracking did
    # not yet record them.
    if not files:
        messages = await get_messages(db, session_id, limit=500, offset=0)
        recovered_paths = _extract_file_paths_from_messages(messages, session.directory)
        for resolved in recovered_paths:
            if resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            files.append({
                "name": Path(resolved).name,
                "path": resolved,
                "type": "generated",
                "tool": "code_execute",
            })

    return {"files": files}


@router.post("/sessions/{session_id}/compact")
async def compact_session_endpoint(
    session_id: str,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
    stream_manager: StreamManagerDep,
    db: AsyncSession = Depends(get_db),
    body: SessionCompactionRequest | None = None,
) -> dict[str, object]:
    """Trigger manual context compaction for a session."""
    
    session = await get_session(db, session_id)
    if session is None:
        raise NotFound("Session not found")

    if stream_manager and any(job.session_id == session_id and not job.completed for job in stream_manager._jobs.values()):
        raise Conflict("Session is currently generating")

    job = GenerationJob(stream_id=f"manual-compact-{generate_ulid()}", session_id=session_id)
    result_payload: dict[str, object] = {"ok": False}

    async def _run() -> None:
        nonlocal result_payload
        async with session_factory() as s:
            async with s.begin():
                live = await get_session(s, session_id)
                if live is not None:
                    live.time_compacting = datetime.now(timezone.utc)

        try:
            result = await run_compaction(
                session_id,
                job=job,
                session_factory=session_factory,
                provider_registry=provider_registry,
                agent_registry=agent_registry,
                model_id=body.model_id if body else None,
                visible_summary=True,
            )
            if not result.summary and result.pruned_parts == 0:
                raise Conflict("Nothing to compact yet")
            if not result.summary:
                raise UpstreamError("Compaction pruned context but did not produce an AI summary")
            result_payload = {
                "ok": True,
                "summary_created": True,
                "pruned_parts": result.pruned_parts,
                "visible_summary": True,
            }
        finally:
            async with session_factory() as s:
                async with s.begin():
                    live = await get_session(s, session_id)
                    if live is not None:
                        live.time_compacting = None
            job.complete()

    await _run()
    return result_payload


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
        raise NotFound("Session not found")

    # Clean up FTS resources for this session
    index_manager = get_index_manager()
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
        raise NotFound("Session not found")

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
    except DomainError:
        raise
    except Exception as exc:
        log.exception("Session PDF export failed")
        raise InternalError(str(exc)) from exc


@router.get("/sessions/{session_id}/export-md")
async def export_session_markdown(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Export an entire conversation as a Markdown file."""
    session = await get_session(db, session_id)
    if session is None:
        raise NotFound("Session not found")

    messages = await get_messages(db, session_id)
    title = session.title or "Conversation"
    md_content = _messages_to_markdown(title, messages)

    from urllib.parse import quote
    safe_title = "".join(
        c if c.isascii() and (c.isalnum() or c in " _-") else "_" for c in title
    )
    utf8_title = quote(title, safe="")

    return Response(
        content=md_content.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{safe_title}.md"; '
                f"filename*=UTF-8''{utf8_title}.md"
            ),
        },
    )
