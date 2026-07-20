"""Loop-mode automations must be able to detect their own completion.

The original bug: ``_extract_session_output`` read ``stream_mgr._completed``,
an attribute ``StreamManager`` does not define (it has ``_jobs`` and
``_semaphore`` only — see ``app/streaming/manager.py``), so the function
always returned "" and ``[LOOP_DONE]`` never matched.

These tests pin the *production* contract of ``_extract_session_output``:

  1. It reads the persisted Message/Part rows, in the exact shape the real
     pipeline writes them (``prompt.py::_create_assistant_message_shell``
     creates ``{"role": "assistant", ...}``; ``processor.py`` appends
     ``{"type": "text", "text": ...}`` parts).
  2. It returns the FINAL assistant message, not a concatenation of the whole
     session — so the stop-marker check and the progress log agree.
  3. It is not shortcut by any in-memory ``GenerationJob.events`` fast path.
     The fakes below publish text-delta events to the job exactly like a real
     run does, with content that *conflicts* with the DB. Any reintroduced
     buffer fast path changes the answer and fails these tests.
"""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.models.scheduled_task import ScheduledTask
from app.models.task_run import TaskRun
from app.scheduler.executor import _extract_session_output, execute_scheduled_task
from app.session.manager import create_message, create_part, create_session
from app.streaming.events import TEXT_DELTA, SSEEvent


async def _persist_assistant_turn(
    session_factory, session_id, texts, *, synthetic=False, role="assistant",
    ensure_session=True, user_text=None,
):
    """Write one message + its text parts in the production row shape."""
    async with session_factory() as db:
        async with db.begin():
            if ensure_session:
                await create_session(db, id=session_id)
            if user_text is not None:
                user_msg = await create_message(
                    db, session_id=session_id, data={"role": "user"}
                )
                await create_part(
                    db,
                    message_id=user_msg.id,
                    session_id=session_id,
                    data={"type": "text", "text": user_text},
                )
            msg = await create_message(
                db, session_id=session_id, data={"role": role}
            )
            for text in texts:
                data = {"type": "text", "text": text}
                if synthetic:
                    data["synthetic"] = True
                await create_part(
                    db, message_id=msg.id, session_id=session_id, data=data
                )


def _make_run_generation(session_factory, transcript_for):
    """Fake run_generation mimicking a real run.

    Streams text-delta events into ``job.events`` (as the real processor does)
    AND persists the transcript. The streamed narration deliberately differs
    from the final persisted message so that reading the buffer instead of the
    DB yields a detectably wrong answer.
    """
    calls: list[str] = []

    async def _fake_run_generation(job, request, **kwargs):
        calls.append(job.session_id)
        text = transcript_for(len(calls))
        # Preamble narration, exactly what a real stream looks like. Note it
        # never contains the stop marker.
        for chunk in (
            "Let me start by looking at the current state. ",
            "I will now work through the remaining items one at a time. ",
        ):
            job.publish(SSEEvent(TEXT_DELTA, {"text": chunk}))
        for chunk in text.split(" "):
            job.publish(SSEEvent(TEXT_DELTA, {"text": chunk + " "}))
        await _persist_assistant_turn(
            session_factory, job.session_id, [text], user_text=request.text,
        )

    return _fake_run_generation, calls


async def _add_task(session_factory, task_id, **overrides):
    fields = dict(
        id=task_id,
        name="Loop task",
        prompt="Process the next item. Output [LOOP_DONE] when finished.",
        schedule_config={"type": "interval", "hours": 6},
        model="test/model",
        loop_max_iterations=5,
    )
    fields.update(overrides)
    async with session_factory() as db:
        async with db.begin():
            db.add(ScheduledTask(**fields))


def _wait_for_with_short_timeout(seconds: float):
    """Wrap asyncio.wait_for, clamping the timeout so the test runs fast."""
    real = asyncio.wait_for

    async def _patched(aw, timeout):
        return await real(aw, seconds)

    return _patched


@pytest.fixture
def app_state():
    # No stream_manager at all — the in-memory path must not be required.
    return SimpleNamespace(
        provider_registry=None,
        agent_registry=None,
        tool_registry=None,
    )


# ---------------------------------------------------------------------------
# Unit-level contract of the extractor itself
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extract_returns_final_assistant_message_not_whole_session(
    session_factory,
):
    """Multi-turn session → only the LAST assistant message comes back.

    Guards finding [2]: concatenating every turn would also return
    "Working on it" and would make a stale marker from an early turn stop the
    loop forever after.
    """
    sid = "sess-multi-turn"
    await _persist_assistant_turn(
        session_factory, sid, ["Working on it, item 1."], user_text="go"
    )
    await _persist_assistant_turn(
        session_factory, sid, ["Item 2 handled."], ensure_session=False
    )
    await _persist_assistant_turn(
        session_factory, sid, ["All done. [LOOP_DONE]"], ensure_session=False
    )

    out = await _extract_session_output(sid, session_factory=session_factory)

    assert out == "All done. [LOOP_DONE]"
    assert "Working on it" not in out
    assert "Item 2 handled" not in out


@pytest.mark.asyncio
async def test_extract_ignores_trailing_user_message(session_factory):
    """A user turn after the assistant turn must not blank the result."""
    sid = "sess-trailing-user"
    await _persist_assistant_turn(
        session_factory, sid, ["Finished. [LOOP_DONE]"], user_text="go"
    )
    await _persist_assistant_turn(
        session_factory, sid, ["anything else?"], role="user", ensure_session=False
    )

    out = await _extract_session_output(sid, session_factory=session_factory)
    assert out == "Finished. [LOOP_DONE]"


@pytest.mark.asyncio
async def test_extract_skips_whitespace_only_assistant_message(session_factory):
    """Guards finding [6]: emptiness is judged by .strip(), consistently.

    A whitespace-only final turn must fall through to the previous real turn
    rather than being treated as output.
    """
    sid = "sess-whitespace"
    await _persist_assistant_turn(
        session_factory, sid, ["Real conclusion here."], user_text="go"
    )
    await _persist_assistant_turn(
        session_factory, sid, ["\n  \n"], ensure_session=False
    )

    out = await _extract_session_output(sid, session_factory=session_factory)
    assert out == "Real conclusion here."


@pytest.mark.asyncio
async def test_extract_returns_empty_for_session_with_no_assistant_text(
    session_factory,
):
    sid = "sess-no-assistant"
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id=sid)
    out = await _extract_session_output(sid, session_factory=session_factory)
    assert out == ""


@pytest.mark.asyncio
async def test_extract_ignores_synthetic_compaction_parts(session_factory):
    """Compaction summaries quote prior context; they are not model output."""
    sid = "sess-synthetic"
    await _persist_assistant_turn(
        session_factory, sid, ["Still working."], user_text="go"
    )
    await _persist_assistant_turn(
        session_factory,
        sid,
        ["[Context Summary] Agent was told to emit [LOOP_DONE]."],
        synthetic=True,
        ensure_session=False,
    )

    out = await _extract_session_output(sid, session_factory=session_factory)
    assert out == "Still working."
    assert "[LOOP_DONE]" not in out


@pytest.mark.asyncio
async def test_extract_is_not_shortcut_by_job_event_buffer(session_factory):
    """Guards findings [1] and [3]: there is no in-memory fast path.

    ``_extract_session_output`` takes no job argument at all, and a populated
    replay buffer cannot change its answer.
    """
    sig = inspect.signature(_extract_session_output)
    assert "job" not in sig.parameters, (
        "a GenerationJob fast path was reintroduced; it silently shadows the "
        "DB read because job.events is always populated for a real run"
    )

    sid = "sess-buffer-decoy"
    await _persist_assistant_turn(
        session_factory, sid, ["Persisted conclusion. [LOOP_DONE]"], user_text="go"
    )
    out = await _extract_session_output(sid, session_factory=session_factory)
    assert out == "Persisted conclusion. [LOOP_DONE]"


# ---------------------------------------------------------------------------
# End-to-end loop behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_loop_stops_on_marker_in_final_message(
    session_factory, app_state, monkeypatch
):
    """The marker in the final persisted message terminates the loop."""
    task_id = "task-loop-db"
    await _add_task(session_factory, task_id, loop_max_iterations=5)

    def transcript_for(n: int) -> str:
        return "All items processed. [LOOP_DONE]" if n >= 2 else f"Processed item {n}."

    fake, calls = _make_run_generation(session_factory, transcript_for)
    monkeypatch.setattr("app.scheduler.executor.run_generation", fake)
    monkeypatch.setattr("app.scheduler.executor.get_index_manager", lambda: None)

    await execute_scheduled_task(
        task_id, session_factory=session_factory, app_state=app_state,
    )

    assert len(calls) == 2, f"loop did not terminate on the stop marker: {calls}"

    async with session_factory() as db:
        runs = (await db.execute(
            select(TaskRun).where(TaskRun.task_id == task_id)
        )).scalars().all()
        task = (await db.execute(
            select(ScheduledTask).where(ScheduledTask.id == task_id)
        )).scalar_one()

    assert len(runs) == 2
    assert all(r.status == "success" for r in runs)
    assert task.last_run_status == "success"
    assert task.run_count == 2


@pytest.mark.asyncio
async def test_loop_runs_to_max_iterations_without_marker(
    session_factory, app_state, monkeypatch
):
    task_id = "task-loop-nomarker"
    await _add_task(
        session_factory, task_id, prompt="Keep going.", loop_max_iterations=3
    )

    fake, calls = _make_run_generation(
        session_factory, lambda n: f"Still working, item {n}."
    )
    monkeypatch.setattr("app.scheduler.executor.run_generation", fake)
    monkeypatch.setattr("app.scheduler.executor.get_index_manager", lambda: None)

    await execute_scheduled_task(
        task_id, session_factory=session_factory, app_state=app_state,
    )

    assert len(calls) == 3


@pytest.mark.asyncio
async def test_progress_log_carries_the_conclusion_not_the_preamble(
    session_factory, app_state, monkeypatch
):
    """Guards finding [4]: output[:500] must summarise the iteration's result.

    The fake streams a long preamble before the conclusion. Reading the event
    buffer would put that preamble (truncated at 500 chars) into the next
    prompt; reading the final message puts the conclusion there.
    """
    task_id = "task-loop-progress"
    await _add_task(
        session_factory, task_id, prompt="Do the work.", loop_max_iterations=2
    )

    prompts: list[str] = []

    async def _run(job, request, **kwargs):
        prompts.append(request.text)
        n = len(prompts)
        # A preamble longer than the 500-char progress budget.
        for _ in range(20):
            job.publish(SSEEvent(
                TEXT_DELTA,
                {"text": "First let me think about how to approach this. "},
            ))
        await _persist_assistant_turn(
            session_factory, job.session_id, [f"Finished chunk {n}."],
            user_text=request.text,
        )

    monkeypatch.setattr("app.scheduler.executor.run_generation", _run)
    monkeypatch.setattr("app.scheduler.executor.get_index_manager", lambda: None)

    await execute_scheduled_task(
        task_id, session_factory=session_factory, app_state=app_state,
    )

    assert len(prompts) == 2
    assert "Finished chunk 1." in prompts[1], prompts[1]
    assert "First let me think" not in prompts[1], (
        "progress log captured the streamed preamble instead of the conclusion"
    )


@pytest.mark.asyncio
async def test_timed_out_iteration_cannot_satisfy_the_stop_marker(
    session_factory, app_state, monkeypatch
):
    """Guards finding [5]: a killed run's partial text must not end the loop.

    Iteration 1 persists text containing the marker and then hangs until the
    timeout fires. The loop must keep going, because a timed-out iteration did
    not legitimately declare itself finished.
    """
    task_id = "task-loop-timeout"
    await _add_task(
        session_factory, task_id, prompt="Do the work.", loop_max_iterations=3
    )

    calls: list[str] = []

    async def _run(job, request, **kwargs):
        calls.append(job.session_id)
        # Partial output that happens to echo the marker, then hang.
        await _persist_assistant_turn(
            session_factory, job.session_id,
            ["Partial work, will emit [LOOP_DONE] when done"],
            user_text=request.text,
        )
        if len(calls) == 1:
            await asyncio.sleep(30)

    monkeypatch.setattr("app.scheduler.executor.run_generation", _run)
    monkeypatch.setattr("app.scheduler.executor.get_index_manager", lambda: None)
    # Force iteration 1 to time out quickly.
    monkeypatch.setattr(
        "app.scheduler.executor.asyncio.wait_for",
        _wait_for_with_short_timeout(0.05),
    )

    await execute_scheduled_task(
        task_id, session_factory=session_factory, app_state=app_state,
    )

    async with session_factory() as db:
        runs = (await db.execute(
            select(TaskRun).where(TaskRun.task_id == task_id)
        )).scalars().all()
    statuses = sorted(r.status for r in runs)

    assert "timeout" in statuses, f"iteration 1 should have timed out: {statuses}"
    assert len(calls) > 1, (
        "a timed-out iteration ended the loop via its partial [LOOP_DONE] text"
    )


@pytest.mark.asyncio
async def test_iteration_with_no_output_records_status_placeholder(
    session_factory, app_state, monkeypatch
):
    """Guards finding [6] end-to-end: whitespace-only output is treated as empty."""
    task_id = "task-loop-blank"
    await _add_task(
        session_factory, task_id, prompt="Do the work.", loop_max_iterations=2
    )

    prompts: list[str] = []

    async def _run(job, request, **kwargs):
        prompts.append(request.text)
        job.publish(SSEEvent(TEXT_DELTA, {"text": "\n"}))
        await _persist_assistant_turn(
            session_factory, job.session_id, ["   \n  "], user_text=request.text,
        )

    monkeypatch.setattr("app.scheduler.executor.run_generation", _run)
    monkeypatch.setattr("app.scheduler.executor.get_index_manager", lambda: None)

    await execute_scheduled_task(
        task_id, session_factory=session_factory, app_state=app_state,
    )

    assert len(prompts) == 2
    assert "[success]" in prompts[1], prompts[1]
