"""Session CRUD endpoints — wired through the Route Module (ADR-0007).

The 11 endpoints split between:

- ``Route``-decorated CRUD: ``list / get / create / update / delete`` for
  ``/sessions`` and ``/sessions/{id}``, plus ``list`` for ``/sessions/search``.
  These call into ``app/session/manager.py`` cascades — ``create_session_and_index``,
  ``update_session``, ``delete_session_cascade`` — that own the multi-step
  orchestration (FTS reindex on directory change, stream abort + uploads
  cleanup on delete) per ADR-0007.
- ``Route.custom``: the four endpoints that are not CRUD — todos / files /
  compact / export-pdf / export-md. Each is a hand-written async handler
  that gets audit logging and ``DomainError`` mapping for free; their
  shapes (binary ``Response`` for exports, optional body for compact,
  in-line file-system probing for files) don't fit the typed-Manager
  contract and pretending otherwise would invent more decorator surface
  than warranted.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._route import Route
from app.api.pdf import markdown_to_pdf
from app.dependencies import (
    AgentRegistryDep,
    ProviderRegistryDep,
    SessionFactoryDep,
    StreamManagerDep,
    get_db,
    get_session_factory,
)
from app.errors import DomainError, InternalError, NotFound
from app.models.session_file import SessionFile
from app.schemas.session import (
    SessionCompactionRequest,
    SessionCreate,
    SessionResponse,
    SessionSearchResult,
    SessionUpdate,
)
from app.session.manager import (
    compact_session_cascade,
    create_session_and_index,
    delete_session_cascade,
    get_messages,
    get_session,
    list_sessions,
    search_sessions,
    update_session,
)

log = logging.getLogger(__name__)

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


# ---------------------------------------------------------------------------
# Route registrations — order matters for FastAPI: more specific paths
# (`/sessions/search`) must register before parameterised ones
# (`/sessions/{session_id}`) so the literal route wins.
# ---------------------------------------------------------------------------

route = Route(tags=["sessions"])

route.list(
    "/sessions",
    manager=list_sessions,
    response_model=list[SessionResponse],
)

route.list(
    "/sessions/search",
    manager=search_sessions,
    response_model=list[SessionSearchResult],
)

route.create(
    "/sessions",
    manager=create_session_and_index,
    body=SessionCreate,
    response_model=SessionResponse,
    status_code=201,
)

route.get(
    "/sessions/{session_id}",
    manager=get_session,
    response_model=SessionResponse,
    not_found_on_none=True,
    not_found_message="Session not found",
)

route.update(
    "/sessions/{session_id}",
    manager=update_session,
    body=SessionUpdate,
    response_model=SessionResponse,
)

route.delete(
    "/sessions/{session_id}",
    manager=delete_session_cascade,
)


# ---------------------------------------------------------------------------
# Hand-written custom handlers — non-CRUD shapes
# ---------------------------------------------------------------------------


async def _list_session_todos(
    session_id: str,
    request: Request,
) -> dict:
    """Return the in-memory todo list for ``session_id``.

    ``get_todos`` reads from a side-channel keyed off ``session_id`` rather
    than the DB, so we pass through to the existing helper.
    """
    from app.tool.builtin.todo import get_todos

    session_factory = get_session_factory()
    if session_factory is None:
        return {"todos": []}
    todos = await get_todos(session_id, session_factory)
    return {"todos": todos}


def _extract_file_paths_from_messages(
    messages: list,
    session_directory: str | None,
) -> list[str]:
    """Best-effort recovery of files created during older sessions.

    Conservative: recovers explicit creation outputs from ``code_execute``-
    style sessions but does not treat files merely *read* during analysis
    as generated workspace files.
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


async def _list_session_files(
    session_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return tracked workspace files for ``session_id``."""
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


async def _compact_session(
    session_id: str,
    session_factory: SessionFactoryDep,
    provider_registry: ProviderRegistryDep,
    agent_registry: AgentRegistryDep,
    stream_manager: StreamManagerDep,
    db: AsyncSession = Depends(get_db),
    body: SessionCompactionRequest | None = None,
) -> dict[str, object]:
    """Trigger manual context compaction.

    Custom (not ``route.create``) because the body is genuinely optional —
    clients may POST with no body. ``route.create`` would force a required
    ``SessionCompactionRequest`` body and break that contract.
    """
    return await compact_session_cascade(
        db,
        session_id,
        body,
        session_factory,
        provider_registry,
        agent_registry,
        stream_manager,
    )


def _messages_to_markdown(title: str, messages: list) -> str:
    """Format a list of Message ORM objects as a Markdown transcript."""
    now_str = datetime.now(timezone.utc).strftime("%B %d, %Y at %I:%M %p UTC")
    lines = [f"# {title}", f"*Exported on {now_str}*", "", "---", ""]

    for msg in messages:
        data = msg.data or {}
        role = data.get("role", "user")
        label = "You" if role == "user" else "Assistant"

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


def _content_disposition(title: str, ext: str) -> str:
    """RFC-5987 ``Content-Disposition`` for an export filename."""
    from urllib.parse import quote

    safe_title = "".join(
        c if c.isascii() and (c.isalnum() or c in " _-") else "_" for c in title
    )
    utf8_title = quote(title, safe="")
    return (
        f'attachment; filename="{safe_title}.{ext}"; '
        f"filename*=UTF-8''{utf8_title}.{ext}"
    )


async def _export_session_pdf(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Export a session as PDF."""
    session = await get_session(db, session_id)
    if session is None:
        raise NotFound("Session not found")

    messages = await get_messages(db, session_id)
    title = session.title or "Conversation"

    try:
        md_content = _messages_to_markdown(title, messages)
        pdf_bytes = markdown_to_pdf(md_content)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": _content_disposition(title, "pdf")},
        )
    except DomainError:
        raise
    except Exception as exc:
        log.exception("Session PDF export failed")
        raise InternalError(str(exc)) from exc


async def _export_session_markdown(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Export a session as Markdown."""
    session = await get_session(db, session_id)
    if session is None:
        raise NotFound("Session not found")

    messages = await get_messages(db, session_id)
    title = session.title or "Conversation"
    md_content = _messages_to_markdown(title, messages)

    return Response(
        content=md_content.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": _content_disposition(title, "md")},
    )


route.custom("GET", "/sessions/{session_id}/todos", handler=_list_session_todos)
route.custom("GET", "/sessions/{session_id}/files", handler=_list_session_files)
route.custom("POST", "/sessions/{session_id}/compact", handler=_compact_session)
route.custom("GET", "/sessions/{session_id}/export-pdf", handler=_export_session_pdf)
route.custom("GET", "/sessions/{session_id}/export-md", handler=_export_session_markdown)


# Exposed for app/api/router.py — preserves the existing
# `from app.api import sessions as sessions_api; include_router(sessions_api.router)`
# contract.
router = route.api_router
