from __future__ import annotations

from sqlalchemy import select

from app.agent.run_recovery import reconcile_interrupted_agent_runs
from app.models.message import Part
from app.session.manager import create_message, create_part, create_session


async def test_restart_reconciles_active_task_and_swarm_snapshots(
    session_factory,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            parent = await create_session(db, title="Parent")
            task_child = await create_session(
                db,
                parent_id=parent.id,
                title="Task child",
            )
            swarm_child = await create_session(
                db,
                parent_id=parent.id,
                title="Swarm child",
            )
            message = await create_message(
                db,
                session_id=parent.id,
                data={"role": "assistant"},
            )
            await create_part(
                db,
                part_id="active-task",
                message_id=message.id,
                session_id=parent.id,
                data={
                    "type": "subtask",
                    "session_id": task_child.id,
                    "status": "waiting_input",
                    "revision": 3,
                },
            )
            await create_part(
                db,
                part_id="active-swarm",
                message_id=message.id,
                session_id=parent.id,
                data={
                    "type": "swarm",
                    "status": "running",
                    "revision": 7,
                    "members": [
                        {
                            "session_id": swarm_child.id,
                            "status": "running",
                        }
                    ],
                },
            )
            await create_part(
                db,
                part_id="settled-task",
                message_id=message.id,
                session_id=parent.id,
                data={
                    "type": "subtask",
                    "session_id": "already-done",
                    "status": "completed",
                    "revision": 2,
                },
            )
            await create_part(
                db,
                part_id="terminal-write-lost",
                message_id=message.id,
                session_id=parent.id,
                data={
                    "type": "swarm",
                    "status": "running",
                    "revision": 5,
                    "members": [
                        {
                            "session_id": "finished-child",
                            "status": "completed",
                            "finished_at": "2026-07-23T12:00:00+00:00",
                        }
                    ],
                },
            )

    changed = await reconcile_interrupted_agent_runs(session_factory)
    assert changed == 3

    async with session_factory() as db:
        rows = (
            await db.execute(select(Part).order_by(Part.id))
        ).scalars().all()
    by_id = {part.id: part.data for part in rows}

    assert by_id["active-task"]["status"] == "cancelled"
    assert by_id["active-task"]["revision"] == 4
    assert by_id["active-task"]["finished_at"]
    assert "restart" in by_id["active-task"]["error"].lower()

    swarm = by_id["active-swarm"]
    assert swarm["status"] == "cancelled"
    assert swarm["revision"] == 8
    assert swarm["finished_at"]
    assert swarm["members"][0]["status"] == "cancelled"
    assert swarm["members"][0]["finished_at"]
    assert swarm["cancelled"] == 1

    recovered_terminal = by_id["terminal-write-lost"]
    assert recovered_terminal["status"] == "completed"
    assert recovered_terminal["completed"] == 1
    assert recovered_terminal["cancelled"] == 0

    assert by_id["settled-task"] == {
        "type": "subtask",
        "session_id": "already-done",
        "status": "completed",
        "revision": 2,
    }
