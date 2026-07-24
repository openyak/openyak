"""Recover durable child-Agent lifecycle state after a process restart."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.message import Part

_ACTIVE_STATUSES = frozenset({"pending", "running", "waiting_input"})
_RESTART_ERROR = "Interrupted when OpenYak restarted"


def _next_revision(value: object) -> int:
    try:
        return max(0, int(value)) + 1
    except (TypeError, ValueError):
        return 1


def _settled_swarm_status(members: list[object]) -> str:
    statuses = [
        member.get("status")
        for member in members
        if isinstance(member, dict)
    ]
    completed = statuses.count("completed")
    if statuses and completed == len(statuses):
        return "completed"
    if completed:
        return "partial"
    if "failed" in statuses:
        return "failed"
    return "cancelled"


async def reconcile_interrupted_agent_runs(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    interrupted_at: datetime | None = None,
) -> int:
    """Mark in-memory-only child work as cancelled on a fresh backend.

    Agent execution is deliberately not resumed after a process restart. The
    persisted lifecycle snapshot must therefore move out of Active so the Work
    view never promises a child Agent that no longer exists.
    """
    finished_at = (interrupted_at or datetime.now(timezone.utc)).isoformat()
    changed = 0

    async with session_factory() as db:
        async with db.begin():
            parts = (await db.execute(select(Part))).scalars().all()
            for part in parts:
                data = dict(part.data or {})
                part_type = data.get("type")

                if (
                    part_type == "subtask"
                    and data.get("status") in _ACTIVE_STATUSES
                ):
                    data["status"] = "cancelled"
                    data["finished_at"] = data.get("finished_at") or finished_at
                    data["error"] = data.get("error") or _RESTART_ERROR
                    data["revision"] = _next_revision(data.get("revision"))
                    part.data = data
                    changed += 1
                    continue

                if part_type != "swarm":
                    continue
                members = data.get("members")
                if not isinstance(members, list):
                    continue

                recovered_members: list[object] = []
                member_changed = False
                for raw_member in members:
                    if not isinstance(raw_member, dict):
                        recovered_members.append(raw_member)
                        continue
                    member = dict(raw_member)
                    if member.get("status") in _ACTIVE_STATUSES:
                        member["status"] = "cancelled"
                        member["finished_at"] = (
                            member.get("finished_at") or finished_at
                        )
                        member["error"] = (
                            member.get("error") or _RESTART_ERROR
                        )
                        member_changed = True
                    recovered_members.append(member)

                if not member_changed and data.get("status") != "running":
                    continue

                data["members"] = recovered_members
                data["status"] = (
                    "cancelled"
                    if member_changed
                    else _settled_swarm_status(recovered_members)
                )
                data["finished_at"] = data.get("finished_at") or finished_at
                data["revision"] = _next_revision(data.get("revision"))
                data["completed"] = sum(
                    isinstance(member, dict)
                    and member.get("status") == "completed"
                    for member in recovered_members
                )
                data["failed"] = sum(
                    isinstance(member, dict)
                    and member.get("status") == "failed"
                    for member in recovered_members
                )
                data["cancelled"] = sum(
                    isinstance(member, dict)
                    and member.get("status") == "cancelled"
                    for member in recovered_members
                )
                part.data = data
                changed += 1

    return changed
