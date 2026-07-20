"""Tests for the cross-task recent-runs inbox feed."""

from __future__ import annotations

import pytest

from app.models.scheduled_task import ScheduledTask
from app.models.task_run import TaskRun

pytestmark = pytest.mark.asyncio


async def _mk_task(session_factory, name: str) -> str:
    async with session_factory() as s:
        task = ScheduledTask(
            name=name,
            prompt=f"do {name}",
            schedule_config={"type": "manual"},
            enabled=True,
        )
        s.add(task)
        await s.commit()
        return task.id


async def _mk_run(
    session_factory, task_id: str, status: str, triggered_by: str = "schedule"
) -> str:
    async with session_factory() as s:
        run = TaskRun(task_id=task_id, status=status, triggered_by=triggered_by)
        s.add(run)
        await s.commit()
        return run.id


async def test_recent_runs_are_cross_task_newest_first_with_task_name(
    app_client, session_factory
):
    a = await _mk_task(session_factory, "Morning brief")
    b = await _mk_task(session_factory, "Invoice sweep")
    await _mk_run(session_factory, a, "success")
    await _mk_run(session_factory, b, "error", triggered_by="manual")

    resp = await app_client.get("/api/automations/runs/recent")
    assert resp.status_code == 200
    runs = resp.json()
    assert len(runs) == 2
    # Newest first: the error run (created last) leads.
    assert runs[0]["status"] == "error"
    assert runs[0]["task_name"] == "Invoice sweep"
    assert runs[0]["triggered_by"] == "manual"
    assert runs[1]["task_name"] == "Morning brief"
    # The feed spans multiple tasks.
    assert {r["task_name"] for r in runs} == {"Morning brief", "Invoice sweep"}


async def test_recent_runs_excludes_runs_whose_task_was_deleted(app_client, session_factory):
    from sqlalchemy import delete

    a = await _mk_task(session_factory, "Keeper")
    b = await _mk_task(session_factory, "Doomed")
    await _mk_run(session_factory, a, "success")
    await _mk_run(session_factory, b, "success")

    # Deleting the task cascades to its runs; the inner join also drops any orphan.
    async with session_factory() as s:
        await s.execute(delete(ScheduledTask).where(ScheduledTask.id == b))
        await s.commit()

    resp = await app_client.get("/api/automations/runs/recent")
    assert resp.status_code == 200
    names = [r["task_name"] for r in resp.json()]
    assert names == ["Keeper"]


async def test_recent_runs_limit_is_clamped(app_client, session_factory):
    a = await _mk_task(session_factory, "Busy")
    for _ in range(5):
        await _mk_run(session_factory, a, "success")

    resp = await app_client.get("/api/automations/runs/recent?limit=2")
    assert resp.status_code == 200
    assert len(resp.json()) == 2

    # Over-large limits are clamped, not honored blindly.
    resp = await app_client.get("/api/automations/runs/recent?limit=9999")
    assert resp.status_code == 200
    assert len(resp.json()) == 5
