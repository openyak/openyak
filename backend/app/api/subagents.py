"""Aggregate persisted Task and Swarm child-Agent runs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.evidence.source_evidence import (
    SOURCE_EVIDENCE_METADATA_KEY,
    SourceRecord,
    build_source_record,
    extract_source_evidence,
    has_source_evidence_coverage,
)
from app.models.message import Message, Part
from app.models.session import Session
from app.models.session_file import SessionFile
from app.schemas.subagent import (
    AgentRunCounts,
    AgentRunEvidenceOrigin,
    AgentRunListResponse,
    AgentRunOutput,
    AgentRunResponse,
    AgentRunSource,
    AgentRunStatus,
)

router = APIRouter()

_ACTIVE_STATUSES = frozenset({"pending", "running", "waiting_input"})
_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
_ALL_STATUSES = _ACTIVE_STATUSES | _TERMINAL_STATUSES
_SUMMARY_LIMIT = 280
_SOURCE_COUNT_LIMIT = 200
_LEGACY_SOURCE_TOOLS = frozenset({"web_search", "web_fetch"})
_MISSING = object()


@dataclass(frozen=True)
class _RunCandidate:
    agent_run_id: str
    session_id: str
    parent_session_id: str
    title: str
    agent: str
    status: AgentRunStatus
    source: Literal["task", "swarm"]
    swarm_id: str | None
    ordinal: int | None
    started_at: datetime | None
    finished_at: datetime | None
    time_updated: datetime
    time_created: datetime
    part_id: str
    revision: int
    error: str | None
    status_summary: str | None


def _as_utc(value: datetime) -> datetime:
    """Return an aware UTC datetime, including for SQLite's naive values."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _as_utc(value)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    try:
        return _as_utc(datetime.fromisoformat(raw))
    except ValueError:
        return None


def _utc_timestamp(value: datetime | None) -> float:
    if value is None:
        return float("-inf")
    return _as_utc(value).timestamp()


def _as_revision(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _as_ordinal(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clean_summary(value: Any) -> str:
    """Turn persisted markdown-ish output into a bounded one-line preview."""
    if not isinstance(value, str):
        return ""
    summary = re.sub(r"\s+", " ", value).strip()
    summary = re.sub(r"^(?:#{1,6}|[-*+])\s+", "", summary)
    if len(summary) <= _SUMMARY_LIMIT:
        return summary
    return f"{summary[: _SUMMARY_LIMIT - 1].rstrip()}…"


def _clean_evidence_text(value: Any, *, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def _source_from_values(
    *,
    url: Any,
    title: Any,
    snippet: Any,
    tool: str,
) -> AgentRunSource | None:
    record = build_source_record(
        url=url,
        title=title,
        snippet=snippet,
    )
    if record is None:
        return None
    return _source_from_record(record, tool=tool)


def _source_from_record(
    record: SourceRecord,
    *,
    tool: str,
) -> AgentRunSource:
    return AgentRunSource(
        url=record["url"],
        title=record["title"],
        domain=record["domain"],
        snippet=record["snippet"],
        tool=tool,
    )


def _collect_child_outputs(
    files: list[SessionFile],
) -> dict[str, list[AgentRunOutput]]:
    outputs: dict[str, list[AgentRunOutput]] = {}
    seen: set[tuple[str, str, str]] = set()
    for file in files:
        path = str(file.file_path or "").strip()
        tool = str(file.tool_id or "").strip()
        if not path or not tool:
            continue
        key = (file.session_id, path, tool)
        if key in seen:
            continue
        seen.add(key)
        outputs.setdefault(file.session_id, []).append(
            AgentRunOutput(
                name=str(file.file_name or "").strip() or path.rsplit("/", 1)[-1],
                path=path,
                type=str(file.file_type or "").strip() or "generated",
                tool=tool,
            )
        )
    return outputs


def _collect_child_sources(
    rows: list[tuple[Part, Message]],
) -> dict[str, list[AgentRunSource]]:
    sources: dict[str, list[AgentRunSource]] = {}
    seen: set[tuple[str, str, str]] = set()

    def remember(session_id: str, source: AgentRunSource | None) -> None:
        if source is None:
            return
        key = (session_id, source.url, source.tool)
        if key in seen:
            return
        if len(sources.get(session_id, [])) >= _SOURCE_COUNT_LIMIT:
            return
        seen.add(key)
        sources.setdefault(session_id, []).append(source)

    for part, message in rows:
        if (message.data or {}).get("role") != "assistant":
            continue
        if part.session_id != message.session_id:
            continue
        data = part.data or {}
        if data.get("type") != "tool":
            continue
        tool = _clean_evidence_text(
            data.get("tool"),
            limit=160,
        )
        state = data.get("state")
        if not tool or not isinstance(state, dict):
            continue
        if state.get("status") != "completed":
            continue
        metadata = state.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}

        has_coverage = has_source_evidence_coverage(metadata)
        if has_coverage:
            envelope = metadata[SOURCE_EVIDENCE_METADATA_KEY]
            for item in envelope["items"][:_SOURCE_COUNT_LIMIT]:
                if not isinstance(item, dict):
                    continue
                remember(
                    part.session_id,
                    _source_from_values(
                        url=item.get("url"),
                        title=item.get("title"),
                        snippet=item.get("snippet"),
                        tool=tool,
                    ),
                )
            continue

        if tool == "web_search":
            results = metadata.get("results")
            if isinstance(results, list):
                for result in results:
                    if not isinstance(result, dict):
                        continue
                    remember(
                        part.session_id,
                        _source_from_values(
                            url=result.get("url"),
                            title=result.get("title"),
                            snippet=result.get("snippet")
                            or result.get("quote"),
                            tool=tool,
                        ),
                    )
        elif tool == "web_fetch":
            title = state.get("title")
            if isinstance(title, str):
                title = re.sub(
                    r"^Fetched\s+",
                    "",
                    title,
                    flags=re.IGNORECASE,
                )
            remember(
                part.session_id,
                _source_from_values(
                    url=metadata.get("url")
                    or (
                        state.get("input", {}).get("url")
                        if isinstance(state.get("input"), dict)
                        else None
                    ),
                    title=metadata.get("title") or title,
                    snippet=metadata.get("snippet"),
                    tool=tool,
                ),
            )
        allows_legacy_sources = (
            tool in _LEGACY_SOURCE_TOOLS
            or tool.startswith("mcp_")
        )
        if not allows_legacy_sources:
            continue
        for record in extract_source_evidence(metadata).items:
            remember(
                part.session_id,
                _source_from_record(record, tool=tool),
            )
        output = state.get("output")
        if isinstance(output, str):
            for record in extract_source_evidence(output).items:
                remember(
                    part.session_id,
                    _source_from_record(record, tool=tool),
                )
    return sources


def _evidence_origin(
    *,
    candidate: _RunCandidate,
    title: str,
    tool: str,
) -> AgentRunEvidenceOrigin:
    return AgentRunEvidenceOrigin(
        session_id=candidate.session_id,
        agent_run_id=candidate.agent_run_id,
        agent_title=title,
        status=candidate.status,
        tool=tool,
    )


def _outputs_with_origins(
    items: list[AgentRunOutput],
    *,
    candidate: _RunCandidate,
    title: str,
) -> list[AgentRunOutput]:
    merged: dict[str, AgentRunOutput] = {}
    for item in items:
        origin = _evidence_origin(
            candidate=candidate,
            title=title,
            tool=item.tool,
        )
        current = merged.get(item.path)
        if current is None:
            merged[item.path] = item.model_copy(
                update={"origins": [origin]}
            )
            continue
        if all(existing.tool != origin.tool for existing in current.origins):
            current.origins.append(origin)
    return list(merged.values())


def _sources_with_origins(
    items: list[AgentRunSource],
    *,
    candidate: _RunCandidate,
    title: str,
) -> list[AgentRunSource]:
    merged: dict[str, AgentRunSource] = {}
    for item in items:
        origin = _evidence_origin(
            candidate=candidate,
            title=title,
            tool=item.tool,
        )
        current = merged.get(item.url)
        if current is None:
            merged[item.url] = item.model_copy(
                update={"origins": [origin]}
            )
            continue
        if all(existing.tool != origin.tool for existing in current.origins):
            current.origins.append(origin)
        if current.title == current.domain and item.title != item.domain:
            current.title = item.title
        if current.snippet is None and item.snippet is not None:
            current.snippet = item.snippet
    return list(merged.values())


def _normalise_status(
    value: Any = _MISSING,
    *,
    default: AgentRunStatus,
) -> AgentRunStatus | None:
    if value is _MISSING:
        return default
    if isinstance(value, str) and value in _ALL_STATUSES:
        return value  # type: ignore[return-value]
    return None


def _candidate_is_newer(candidate: _RunCandidate, current: _RunCandidate) -> bool:
    """Prefer the latest persisted invocation, then its highest revision."""
    return (
        _utc_timestamp(candidate.time_updated),
        candidate.revision,
        _utc_timestamp(candidate.time_created),
        candidate.part_id,
    ) > (
        _utc_timestamp(current.time_updated),
        current.revision,
        _utc_timestamp(current.time_created),
        current.part_id,
    )


def _collect_candidates(parts: list[Part]) -> dict[str, _RunCandidate]:
    """Collect one latest run snapshot per child Session in Python.

    JSON predicates differ between SQLite and PostgreSQL, so the endpoint
    intentionally reads Part payloads and discriminates them here.
    """
    candidates: dict[str, _RunCandidate] = {}

    def remember(candidate: _RunCandidate) -> None:
        current = candidates.get(candidate.session_id)
        if current is None or _candidate_is_newer(candidate, current):
            candidates[candidate.session_id] = candidate

    for part in parts:
        data = part.data or {}
        part_type = data.get("type")
        canonical_parent_id = str(part.session_id or "").strip()
        if not canonical_parent_id:
            continue
        time_created = _as_utc(part.time_created)
        time_updated = _as_utc(part.time_updated or part.time_created)
        revision = _as_revision(data.get("revision"))

        if part_type == "subtask":
            session_id = str(data.get("session_id") or "").strip()
            if not session_id:
                continue
            if "parent_id" in data:
                payload_parent_id = str(data.get("parent_id") or "").strip()
                if payload_parent_id != canonical_parent_id:
                    continue
            status = _normalise_status(
                data.get("status", _MISSING),
                default="completed",
            )
            if status is None:
                continue
            title = str(data.get("title") or "").strip()
            error = _clean_summary(data.get("error")) or None
            remember(
                _RunCandidate(
                    agent_run_id=str(
                        data.get("task_id") or session_id
                    ).strip(),
                    session_id=session_id,
                    parent_session_id=canonical_parent_id,
                    title=title,
                    agent=str(data.get("agent") or "subagent").strip(),
                    status=status,
                    source="task",
                    swarm_id=None,
                    ordinal=None,
                    started_at=_as_datetime(data.get("started_at")),
                    finished_at=_as_datetime(data.get("finished_at")),
                    time_updated=time_updated,
                    time_created=time_created,
                    part_id=part.id,
                    revision=revision,
                    error=error,
                    status_summary=error,
                )
            )
            continue

        if part_type != "swarm":
            continue
        if "parent_session_id" in data:
            payload_parent_id = str(
                data.get("parent_session_id") or ""
            ).strip()
            if payload_parent_id != canonical_parent_id:
                continue
        swarm_id = str(data.get("swarm_id") or "").strip() or None
        members = data.get("members")
        if not isinstance(members, list):
            continue
        for member in members:
            if not isinstance(member, dict):
                continue
            session_id = str(member.get("session_id") or "").strip()
            if not session_id:
                continue
            status = _normalise_status(
                member.get("status", _MISSING),
                default="pending",
            )
            if status is None:
                continue
            title = str(member.get("title") or "").strip()
            error = _clean_summary(member.get("error")) or None
            agent_run_id = str(
                member.get("agent_run_id") or session_id
            ).strip()
            remember(
                _RunCandidate(
                    agent_run_id=agent_run_id,
                    session_id=session_id,
                    parent_session_id=canonical_parent_id,
                    title=title,
                    agent=str(member.get("agent") or "subagent").strip(),
                    status=status,
                    source="swarm",
                    swarm_id=swarm_id,
                    ordinal=_as_ordinal(member.get("ordinal")),
                    started_at=_as_datetime(member.get("started_at")),
                    finished_at=_as_datetime(member.get("finished_at")),
                    time_updated=time_updated,
                    time_created=time_created,
                    part_id=part.id,
                    revision=revision,
                    error=error,
                    status_summary=error,
                )
            )

    return candidates


def _latest_assistant_summaries(
    rows: list[tuple[Part, Message]],
) -> dict[str, tuple[str, datetime]]:
    """Build latest assistant previews from child-scoped text Part rows."""
    grouped: dict[
        tuple[str, str],
        tuple[list[str], datetime, datetime, str],
    ] = {}
    for part, message in rows:
        if (message.data or {}).get("role") != "assistant":
            continue
        if part.session_id != message.session_id:
            continue
        data = part.data or {}
        if data.get("type") != "text":
            continue
        key = (part.session_id, message.id)
        text_parts, message_time, latest_part_time, latest_part_id = (
            grouped.setdefault(
                key,
                (
                    [],
                    _as_utc(message.time_created),
                    _as_utc(part.time_created),
                    part.id,
                ),
            )
        )
        text_parts.append(str(data.get("text") or ""))
        part_order = (_utc_timestamp(part.time_created), part.id)
        latest_part_order = (
            _utc_timestamp(latest_part_time),
            latest_part_id,
        )
        if part_order > latest_part_order:
            grouped[key] = (
                text_parts,
                message_time,
                _as_utc(part.time_created),
                part.id,
            )

    summaries_with_order: dict[
        str,
        tuple[str, datetime, tuple[float, float, str, str]],
    ] = {}
    for (session_id, message_id), (
        text_parts,
        message_time,
        latest_part_time,
        latest_part_id,
    ) in grouped.items():
        summary = _clean_summary(" ".join(text_parts))
        if not summary:
            continue
        order = (
            _utc_timestamp(message_time),
            _utc_timestamp(latest_part_time),
            message_id,
            latest_part_id,
        )
        current = summaries_with_order.get(session_id)
        if current is None or order > current[2]:
            summaries_with_order[session_id] = (
                summary,
                message_time,
                order,
            )
    return {
        session_id: (summary, message_time)
        for session_id, (summary, message_time, _) in (
            summaries_with_order.items()
        )
    }


async def _collect_descendant_candidates(
    db: AsyncSession,
    root_session_id: str,
) -> tuple[dict[str, _RunCandidate], dict[str, Session]]:
    """Walk valid child-Agent state level by level from one root Session.

    The Part's indexed ``session_id`` determines which parent's state is being
    inspected. The persisted child Session's ``parent_id`` is authoritative:
    stale, deleted, cross-parent, and cyclic references are rejected before
    their branch can enter the next frontier.
    """
    root = (
        await db.execute(
            select(Session).where(Session.id == root_session_id)
        )
    ).scalar_one_or_none()
    if root is None:
        return {}, {}

    candidates: dict[str, _RunCandidate] = {}
    sessions: dict[str, Session] = {root.id: root}
    visited_parents: set[str] = set()
    frontier: set[str] = {root.id}

    while frontier:
        frontier -= visited_parents
        if not frontier:
            break
        visited_parents.update(frontier)

        part_rows = (
            await db.execute(
                select(Part).where(Part.session_id.in_(frontier))
            )
        ).scalars().all()
        parts_by_parent: dict[str, list[Part]] = {}
        for part in part_rows:
            parts_by_parent.setdefault(part.session_id, []).append(part)
        level_candidates = [
            candidate
            for parent_parts in parts_by_parent.values()
            for candidate in _collect_candidates(parent_parts).values()
        ]
        if not level_candidates:
            break

        child_ids = {
            candidate.session_id for candidate in level_candidates
        }
        child_rows = (
            await db.execute(
                select(Session).where(Session.id.in_(child_ids))
            )
        ).scalars().all()
        children = {session.id: session for session in child_rows}
        next_frontier: set[str] = set()
        for candidate in level_candidates:
            child = children.get(candidate.session_id)
            if (
                child is None
                or candidate.session_id in visited_parents
                or candidate.parent_session_id not in frontier
                or child.parent_id != candidate.parent_session_id
            ):
                continue
            candidates[candidate.session_id] = candidate
            sessions[candidate.session_id] = child
            next_frontier.add(candidate.session_id)
        frontier = next_frontier

    return candidates, sessions


@router.get("/subagents", response_model=AgentRunListResponse)
async def list_subagents(
    parent_session_id: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
) -> AgentRunListResponse:
    """List one parent's durable child-Agent runs by lifecycle section."""
    parent_session_id = parent_session_id.strip()
    if not parent_session_id:
        return AgentRunListResponse(
            active=[],
            done=[],
            counts=AgentRunCounts(active=0, done=0, total=0),
        )
    candidate_map, sessions = await _collect_descendant_candidates(
        db,
        parent_session_id,
    )
    if not candidate_map:
        return AgentRunListResponse(
            active=[],
            done=[],
            counts=AgentRunCounts(active=0, done=0, total=0),
        )

    # Start from the existing Part.session_id index, then join each Part to its
    # Message primary key. Avoid scanning the unindexed Message.session_id
    # column merely to build the compact assistant preview.
    message_part_rows = (
        await db.execute(
            select(Part, Message)
            .join(Message, Message.id == Part.message_id)
            .where(Part.session_id.in_(set(candidate_map)))
            .order_by(
                Message.time_created,
                Message.id,
                Part.time_created,
                Part.id,
            )
        )
    ).all()
    summaries = _latest_assistant_summaries(list(message_part_rows))
    sources = _collect_child_sources(list(message_part_rows))
    session_file_rows = (
        await db.execute(
            select(SessionFile)
            .where(SessionFile.session_id.in_(set(candidate_map)))
            .order_by(SessionFile.time_created, SessionFile.id)
        )
    ).scalars().all()
    outputs = _collect_child_outputs(list(session_file_rows))

    runs: list[AgentRunResponse] = []
    for candidate in candidate_map.values():
        child = sessions[candidate.session_id]
        parent = sessions.get(candidate.parent_session_id)
        latest_message = summaries.get(candidate.session_id)
        summary = (
            _clean_summary(latest_message[0])
            if latest_message is not None
            else candidate.status_summary
        ) or None
        title = candidate.title or child.title or "Subagent"
        runs.append(
            AgentRunResponse(
                id=candidate.agent_run_id,
                agent_run_id=candidate.agent_run_id,
                session_id=candidate.session_id,
                parent_session_id=candidate.parent_session_id,
                parent_title=parent.title if parent else "Parent session",
                title=title,
                summary=summary,
                agent=candidate.agent,
                status=candidate.status,
                source=candidate.source,
                swarm_id=candidate.swarm_id,
                ordinal=candidate.ordinal,
                started_at=candidate.started_at,
                finished_at=candidate.finished_at,
                last_message_at=(
                    _as_utc(latest_message[1])
                    if latest_message is not None
                    else None
                ),
                time_updated=_as_utc(candidate.time_updated),
                error=candidate.error,
                outputs=_outputs_with_origins(
                    outputs.get(candidate.session_id, []),
                    candidate=candidate,
                    title=title,
                ),
                sources=_sources_with_origins(
                    sources.get(candidate.session_id, []),
                    candidate=candidate,
                    title=title,
                ),
            )
        )

    active = [run for run in runs if run.status in _ACTIVE_STATUSES]
    done = [run for run in runs if run.status in _TERMINAL_STATUSES]
    active.sort(
        key=lambda run: (
            _utc_timestamp(run.started_at or run.time_updated),
            run.id,
        ),
        reverse=True,
    )
    done.sort(
        key=lambda run: (
            _utc_timestamp(run.finished_at or run.time_updated),
            run.id,
        ),
        reverse=True,
    )
    return AgentRunListResponse(
        active=active,
        done=done,
        counts=AgentRunCounts(
            active=len(active),
            done=len(done),
            total=len(active) + len(done),
        ),
    )
