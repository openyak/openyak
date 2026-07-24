"""Task tool (SubAgent) tests — recursion guard, validation."""

import asyncio

import pytest

from app.schemas.agent import AgentInfo
from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_messages,
    get_session,
)
from app.streaming.events import (
    PERMISSION_REQUEST,
    PERMISSION_RESOLVED,
    PLAN_REVIEW,
    QUESTION,
    QUESTION_RESOLVED,
    SSEEvent,
    SUBTASK_STATE,
)
from app.streaming.manager import GenerationJob
from app.tool.builtin.task import (
    MAX_SUBTASK_DEPTH,
    TaskTool,
    _resolve_child_session,
    _update_subtask_part_with_retry,
)
from app.tool.context import ToolContext


def _make_ctx(depth: int = 0) -> ToolContext:
    ctx = ToolContext(
        session_id="test-session",
        message_id="test-msg",
        agent=AgentInfo(name="test", description="", mode="primary"),
        call_id="test-call",
    )
    ctx._depth = depth  # type: ignore[attr-defined]
    return ctx


class TestTaskValidation:
    def test_valid_args(self):
        tool = TaskTool()
        assert tool.validate_args({
            "description": "Search code",
            "prompt": "Find all Python files",
        }) is None

    def test_missing_description(self):
        tool = TaskTool()
        error = tool.validate_args({"prompt": "do something"})
        assert error is not None
        assert "description" in error

    def test_missing_prompt(self):
        tool = TaskTool()
        error = tool.validate_args({"description": "test"})
        assert error is not None
        assert "prompt" in error

    def test_invalid_agent_enum(self):
        tool = TaskTool()
        error = tool.validate_args({
            "description": "test",
            "prompt": "do something",
            "agent": "nonexistent",
        })
        assert error is not None
        assert "enum" in error.lower() or "must be one of" in error.lower()


class TestRecursionGuard:
    @pytest.mark.asyncio
    async def test_depth_0_allowed(self):
        """Depth 0 should not trigger recursion guard."""
        tool = TaskTool()
        ctx = _make_ctx(depth=0)
        # Will fail because no _app_state, but should NOT fail due to depth
        result = await tool.execute({
            "description": "test",
            "prompt": "test",
        }, ctx)
        assert "nesting depth" not in (result.error or "")

    @pytest.mark.asyncio
    async def test_max_depth_blocked(self):
        """At max depth, should be blocked."""
        tool = TaskTool()
        ctx = _make_ctx(depth=MAX_SUBTASK_DEPTH)
        result = await tool.execute({
            "description": "test",
            "prompt": "test",
        }, ctx)
        assert result.error is not None
        assert "nesting depth" in result.error

    @pytest.mark.asyncio
    async def test_over_max_depth_blocked(self):
        """Over max depth, should also be blocked."""
        tool = TaskTool()
        ctx = _make_ctx(depth=MAX_SUBTASK_DEPTH + 5)
        result = await tool.execute({
            "description": "test",
            "prompt": "test",
        }, ctx)
        assert result.error is not None
        assert "nesting depth" in result.error

    @pytest.mark.asyncio
    async def test_no_app_state_error(self):
        """Without app_state, should return error (not crash)."""
        tool = TaskTool()
        ctx = _make_ctx(depth=0)
        result = await tool.execute({
            "description": "test",
            "prompt": "test",
        }, ctx)
        assert result.error is not None
        assert "app state" in result.error


@pytest.mark.asyncio
async def test_resumed_subtask_refreshes_parent_workspace_scope(
    session_factory,
    tmp_path,
) -> None:
    old_workspace = tmp_path / "old"
    current_workspace = tmp_path / "current"
    async with session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="parent-session",
                directory=str(old_workspace),
            )
            await create_session(
                db,
                id="child-session",
                parent_id="parent-session",
                directory=str(old_workspace),
            )

    child_session_id, resumed = await _resolve_child_session(
        session_factory=session_factory,
        parent_session_id="parent-session",
        task_id="child-session",
        workspace=str(current_workspace),
        title="Resume child",
    )

    async with session_factory() as db:
        child = await get_session(db, child_session_id)
    assert resumed is True
    assert child is not None
    assert child.parent_id == "parent-session"
    assert child.directory == str(current_workspace)


@pytest.mark.asyncio
async def test_subtask_terminal_snapshot_retries_transient_write(
    session_factory,
    monkeypatch,
) -> None:
    import app.tool.builtin.task as task_module

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="retry-subtask-parent")
            message = await create_message(
                db,
                session_id="retry-subtask-parent",
                data={"role": "assistant", "agent": "build"},
            )
            part = await create_part(
                db,
                message_id=message.id,
                session_id="retry-subtask-parent",
                data={
                    "type": "subtask",
                    "session_id": "child",
                    "title": "Retry",
                    "status": "running",
                },
            )

    real_update = task_module.update_part_data
    attempts = 0

    async def flaky_update(db, part_id, data):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient SubtaskPart write")
        return await real_update(db, part_id, data)

    monkeypatch.setattr(task_module, "update_part_data", flaky_update)
    await _update_subtask_part_with_retry(
        session_factory=session_factory,
        part_id=part.id,
        data={
            "type": "subtask",
            "session_id": "child",
            "title": "Retry",
            "status": "completed",
        },
    )

    assert attempts == 2
    async with session_factory() as db:
        messages = await get_messages(db, "retry-subtask-parent")
    persisted = next(
        persisted_part.data
        for persisted_message in messages
        for persisted_part in persisted_message.parts
        if persisted_part.id == part.id
    )
    assert persisted["status"] == "completed"


@pytest.mark.asyncio
async def test_subtask_terminal_write_survives_repeated_cancellation(
    session_factory,
    monkeypatch,
) -> None:
    import app.tool.builtin.task as task_module

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="cancel-subtask-parent")
            message = await create_message(
                db,
                session_id="cancel-subtask-parent",
                data={"role": "assistant", "agent": "build"},
            )
            part = await create_part(
                db,
                message_id=message.id,
                session_id="cancel-subtask-parent",
                data={
                    "type": "subtask",
                    "session_id": "child",
                    "title": "Cancel safely",
                    "status": "running",
                },
            )

    real_update = task_module.update_part_data
    write_started = asyncio.Event()
    release_write = asyncio.Event()

    async def blocked_update(db, part_id, data):
        write_started.set()
        await release_write.wait()
        return await real_update(db, part_id, data)

    monkeypatch.setattr(task_module, "update_part_data", blocked_update)
    terminal_write = asyncio.create_task(
        _update_subtask_part_with_retry(
            session_factory=session_factory,
            part_id=part.id,
            data={
                "type": "subtask",
                "session_id": "child",
                "title": "Cancel safely",
                "status": "cancelled",
            },
        )
    )
    await write_started.wait()
    terminal_write.cancel()
    await asyncio.sleep(0)
    terminal_write.cancel()
    release_write.set()

    with pytest.raises(asyncio.CancelledError):
        await terminal_write

    async with session_factory() as db:
        messages = await get_messages(db, "cancel-subtask-parent")
    persisted = next(
        persisted_part.data
        for persisted_message in messages
        for persisted_part in persisted_message.parts
        if persisted_part.id == part.id
    )
    assert persisted["status"] == "cancelled"


@pytest.mark.asyncio
async def test_task_tool_cancellation_during_result_read_persists_terminal_part(
    session_factory,
    tmp_path,
    monkeypatch,
) -> None:
    import app.session.processor as processor_module
    import app.tool.builtin.task as task_module

    async with session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="finalize-parent-session",
                directory=str(tmp_path),
            )
            message = await create_message(
                db,
                session_id="finalize-parent-session",
                data={"role": "assistant", "agent": "build"},
            )

    async def completed_generation(job, _request, **_kwargs) -> None:
        job.complete()

    result_read_started = asyncio.Event()
    release_result_read = asyncio.Event()

    async def blocked_result_read(_session_factory, _session_id):
        result_read_started.set()
        await release_result_read.wait()
        return "child output", 0.0, {}

    monkeypatch.setattr(
        processor_module,
        "run_generation",
        completed_generation,
    )
    monkeypatch.setattr(
        task_module,
        "read_agent_result",
        blocked_result_read,
    )
    ctx = ToolContext(
        session_id="finalize-parent-session",
        message_id=message.id,
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="finalize-task-call",
        workspace=str(tmp_path),
        app_state={
            "session_factory": session_factory,
            "provider_registry": object(),
            "agent_registry": object(),
            "tool_registry": object(),
        },
    )
    execution = asyncio.create_task(
        TaskTool().execute(
            {
                "description": "Finalize safely",
                "prompt": "Complete immediately",
            },
            ctx,
        )
    )
    await asyncio.wait_for(result_read_started.wait(), timeout=1)
    execution.cancel()
    await asyncio.sleep(0)
    execution.cancel()
    release_result_read.set()

    with pytest.raises(asyncio.CancelledError):
        await execution

    async with session_factory() as db:
        messages = await get_messages(db, "finalize-parent-session")
    persisted = next(
        part.data
        for persisted_message in messages
        for part in persisted_message.parts
        if part.data.get("type") == "subtask"
    )
    assert persisted["status"] == "cancelled"
    assert persisted["revision"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("request_event", "resolved_event"),
    [
        pytest.param(
            PERMISSION_REQUEST,
            PERMISSION_RESOLVED,
            id="permission",
        ),
        pytest.param(QUESTION, QUESTION_RESOLVED, id="question"),
        pytest.param(PLAN_REVIEW, QUESTION_RESOLVED, id="plan-review"),
    ],
)
async def test_task_tool_persists_waiting_input_then_resumes_running(
    session_factory,
    tmp_path,
    monkeypatch,
    request_event: str,
    resolved_event: str,
) -> None:
    import app.session.processor as processor_module
    import app.tool.builtin.task as task_module

    async with session_factory() as db:
        async with db.begin():
            await create_session(
                db,
                id="interactive-task-parent",
                directory=str(tmp_path),
            )
            message = await create_message(
                db,
                session_id="interactive-task-parent",
                data={"role": "assistant", "agent": "build"},
            )

    child_started = asyncio.Event()
    finish_child = asyncio.Event()
    child_job_ref: dict[str, GenerationJob] = {}

    async def interactive_generation(job, _request, **_kwargs) -> None:
        child_job_ref["job"] = job
        job.publish(
            SSEEvent(
                request_event,
                {
                    "call_id": "interaction-call",
                    "tool": "bash",
                },
            )
        )
        child_started.set()
        await finish_child.wait()
        job.complete()

    async def completed_result(_session_factory, _session_id):
        return "child output", 0.0, {}

    monkeypatch.setattr(
        processor_module,
        "run_generation",
        interactive_generation,
    )
    monkeypatch.setattr(
        task_module,
        "read_agent_result",
        completed_result,
    )

    parent_job = GenerationJob(
        stream_id="interactive-parent-stream",
        session_id="interactive-task-parent",
    )
    parent_job.interactive = True
    published: list[dict] = []
    ctx = ToolContext(
        session_id="interactive-task-parent",
        message_id=message.id,
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="interactive-task-call",
        workspace=str(tmp_path),
        job=parent_job,
        app_state={
            "session_factory": session_factory,
            "provider_registry": object(),
            "agent_registry": object(),
            "tool_registry": object(),
        },
    )
    ctx._publish_fn = lambda event, data: (
        published.append(dict(data)) if event == SUBTASK_STATE else None
    )

    execution = asyncio.create_task(
        TaskTool().execute(
            {
                "description": "Interactive child",
                "prompt": "Ask before changing files",
            },
            ctx,
        )
    )
    await asyncio.wait_for(child_started.wait(), timeout=1)

    async def wait_for_status(status: str, *, after_revision: int = 0) -> dict:
        async with asyncio.timeout(1):
            while True:
                matches = [
                    snapshot
                    for snapshot in published
                    if snapshot.get("status") == status
                    and int(snapshot.get("revision") or 0) > after_revision
                ]
                if matches:
                    return matches[-1]
                await asyncio.sleep(0)

    waiting = await wait_for_status("waiting_input")
    assert waiting["revision"] == 2

    async with session_factory() as db:
        messages = await get_messages(db, "interactive-task-parent")
    persisted_waiting = next(
        part.data
        for persisted_message in messages
        for part in persisted_message.parts
        if part.data.get("type") == "subtask"
    )
    assert persisted_waiting["status"] == "waiting_input"
    assert persisted_waiting["revision"] == 2

    child_job_ref["job"].publish(
        SSEEvent(
            resolved_event,
            {
                "call_id": "interaction-call",
                "allowed": True,
            },
        )
    )
    running = await wait_for_status("running", after_revision=2)
    assert running["revision"] == 3

    finish_child.set()
    result = await asyncio.wait_for(execution, timeout=1)
    assert result.error is None
    assert [snapshot["status"] for snapshot in published] == [
        "running",
        "waiting_input",
        "running",
        "completed",
    ]
    assert [snapshot["revision"] for snapshot in published] == [1, 2, 3, 4]
    terminal_event_count = len(published)
    child_job_ref["job"].publish(
        SSEEvent(
            request_event,
            {
                "call_id": "late-interaction",
                "tool": "bash",
            },
        )
    )
    await asyncio.sleep(0)
    assert len(published) == terminal_event_count

    async with session_factory() as db:
        messages = await get_messages(db, "interactive-task-parent")
    persisted_terminal = next(
        part.data
        for persisted_message in messages
        for part in persisted_message.parts
        if part.data.get("type") == "subtask"
    )
    assert persisted_terminal["status"] == "completed"
    assert persisted_terminal["revision"] == 4
