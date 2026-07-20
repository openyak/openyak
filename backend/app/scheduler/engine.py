"""Lightweight async task scheduler for OpenYak.

Runs a single background asyncio task that polls the database every 30 seconds
for tasks whose next_run_at has passed. Uses croniter for cron expression parsing.
Cross-platform: works on Windows, macOS, and Linux.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from croniter import croniter
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.scheduled_task import ScheduledTask
from app.scheduler.executor import execute_scheduled_task
from app.utils.id import generate_ulid
from app.utils.timezone import (
    get_local_timezone_name,
    resolve_timezone,
    to_naive_utc,
)

logger = logging.getLogger(__name__)


# Maximum age of a missed task trigger that will still be executed on startup.
# Beyond this window, missed triggers are skipped and rescheduled.
_MISSED_GRACE_HOURS = 24


class TaskScheduler:
    """Application-level task scheduler integrated with FastAPI lifespan."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        app_state: Any,
    ):
        from app.config import get_settings as _get_settings
        _s = _get_settings()
        self._session_factory = session_factory
        self._app_state = app_state
        self._poll_interval = _s.scheduler_poll_interval
        self._max_concurrent = _s.scheduler_max_concurrent
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._running_tasks: set[str] = set()  # task IDs currently executing

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the scheduler. Call during FastAPI lifespan startup."""
        await self._recompute_all_next_run()
        await self._catchup_missed()
        self._task = asyncio.create_task(self._poll_loop(), name="task-scheduler")
        logger.info("Task scheduler started (poll interval %ds)", self._poll_interval)

    async def stop(self) -> None:
        """Graceful shutdown."""
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Task scheduler stopped")

    # ------------------------------------------------------------------
    # Public API (called by API endpoints after CRUD)
    # ------------------------------------------------------------------

    async def sync_task(self, task_id: str) -> None:
        """Recompute next_run_at for a task after create/update/toggle."""
        async with self._session_factory() as db:
            async with db.begin():
                task = (
                    await db.execute(
                        select(ScheduledTask).where(ScheduledTask.id == task_id)
                    )
                ).scalar_one_or_none()
                if task is None:
                    return
                self._backfill_timezone(task)
                if task.enabled:
                    task.next_run_at = self._compute_next_run(task.schedule_config)
                else:
                    task.next_run_at = None

    async def run_now(self, task_id: str) -> str | None:
        """Manually trigger a task immediately. Returns session_id."""
        if task_id in self._running_tasks:
            logger.warning("Task %s is already running, skipping manual trigger", task_id)
            return None
        self._running_tasks.add(task_id)
        try:
            return await execute_scheduled_task(
                task_id,
                session_factory=self._session_factory,
                app_state=self._app_state,
                triggered_by="manual",
            )
        finally:
            self._running_tasks.discard(task_id)

    # ------------------------------------------------------------------
    # Internal: poll loop
    # ------------------------------------------------------------------

    async def _poll_loop(self) -> None:
        """Main scheduler loop: check for due tasks every self._poll_interval."""
        while not self._stop_event.is_set():
            try:
                await self._check_and_execute()
            except Exception as e:
                logger.error("Scheduler poll error: %s", e, exc_info=True)
            # Wait for stop event or timeout (normal path: timeout fires)
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self._poll_interval
                )
                break  # stop_event was set
            except asyncio.TimeoutError:
                pass  # Normal: poll interval elapsed, loop again

    async def _check_and_execute(self) -> None:
        """Find due tasks and launch execution for each."""
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        async with self._session_factory() as db:
            async with db.begin():
                result = await db.execute(
                    select(ScheduledTask).where(
                        and_(
                            ScheduledTask.enabled == True,  # noqa: E712
                            ScheduledTask.next_run_at <= now,
                        )
                    )
                )
                due_tasks = result.scalars().all()

        for task in due_tasks:
            if task.id in self._running_tasks:
                continue  # Skip if already executing
            if len(self._running_tasks) >= self._max_concurrent:
                logger.info(
                    "Concurrency limit (%d) reached, deferring task %s",
                    self._max_concurrent, task.name,
                )
                break
            asyncio.create_task(
                self._execute_and_reschedule(
                    task.id, task.name, fired_for=task.next_run_at
                ),
                name=f"sched-exec-{task.id[:12]}",
            )

    async def _execute_and_reschedule(
        self, task_id: str, task_name: str, *, fired_for: datetime | None = None
    ) -> None:
        """Execute a task and compute the next run time.

        ``fired_for`` is the occurrence being executed; it is fed back into the
        next computation so a DST fall-back repeat of the same wall-clock time
        is not executed twice.
        """
        self._running_tasks.add(task_id)
        try:
            await execute_scheduled_task(
                task_id,
                session_factory=self._session_factory,
                app_state=self._app_state,
                triggered_by="schedule",
            )
        except Exception as e:
            logger.error("Failed to execute scheduled task %s: %s", task_name, e)
        finally:
            self._running_tasks.discard(task_id)

        # Reschedule
        async with self._session_factory() as db:
            async with db.begin():
                task = (
                    await db.execute(
                        select(ScheduledTask).where(ScheduledTask.id == task_id)
                    )
                ).scalar_one_or_none()
                if task and task.enabled:
                    task.next_run_at = self._compute_next_run(
                        task.schedule_config, last_run=fired_for
                    )

    # ------------------------------------------------------------------
    # Internal: startup helpers
    # ------------------------------------------------------------------

    async def _recompute_all_next_run(self) -> None:
        """Recompute next_run_at for all enabled tasks (startup consistency)."""
        async with self._session_factory() as db:
            async with db.begin():
                result = await db.execute(
                    select(ScheduledTask).where(ScheduledTask.enabled == True)  # noqa: E712
                )
                tasks = result.scalars().all()
                now = datetime.now(timezone.utc).replace(tzinfo=None)
                for task in tasks:
                    # A legacy row whose zone we just stamped had its
                    # next_run_at computed under the old UTC interpretation, so
                    # it must be recomputed even when it looks "fresh" — else
                    # it fires once at the wrong wall-clock hour after upgrade.
                    backfilled = self._backfill_timezone(task)
                    next_run = self._compute_next_run(task.schedule_config)
                    # Update if the zone was just backfilled, or if next_run_at
                    # is stale or missing.
                    existing = task.next_run_at
                    if existing is not None and existing.tzinfo is not None:
                        existing = existing.replace(tzinfo=None)
                    if backfilled or existing is None or existing < now:
                        task.next_run_at = next_run

    async def _catchup_missed(self) -> None:
        """Execute tasks that were due while the app was closed (within grace)."""
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        grace_cutoff = now - timedelta(hours=_MISSED_GRACE_HOURS)
        async with self._session_factory() as db:
            async with db.begin():
                result = await db.execute(
                    select(ScheduledTask).where(
                        and_(
                            ScheduledTask.enabled == True,  # noqa: E712
                            ScheduledTask.next_run_at != None,  # noqa: E711
                            ScheduledTask.next_run_at < now,
                            ScheduledTask.next_run_at >= grace_cutoff,
                        )
                    )
                )
                missed = result.scalars().all()

        if not missed:
            return

        logger.info(
            "Catching up %d missed scheduled task(s) (within %dh grace)",
            len(missed), _MISSED_GRACE_HOURS,
        )
        for task in missed:
            asyncio.create_task(
                self._execute_and_reschedule(
                    task.id, task.name, fired_for=task.next_run_at
                ),
                name=f"sched-catchup-{task.id[:12]}",
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _backfill_timezone(task: ScheduledTask) -> bool:
        """Stamp the local zone onto legacy cron configs that predate the field.

        Returns True if the config was changed. Reassigns the dict so the JSON
        column change is detected.
        """
        config = task.schedule_config or {}
        if config.get("type") != "cron" or config.get("timezone"):
            return False
        task.schedule_config = {**config, "timezone": get_local_timezone_name()}
        return True

    @staticmethod
    def _compute_next_run(
        schedule_config: dict,
        *,
        after: datetime | None = None,
        last_run: datetime | None = None,
    ) -> datetime | None:
        """Compute the next run time from a schedule config.

        Cron expressions are interpreted in the task's ``timezone`` (an IANA
        name; the system local zone when absent, which covers rows written
        before the field existed). Occurrences are computed in that zone so a
        daily 08:00 task stays at 08:00 wall-clock across DST transitions, then
        converted back to a naive UTC datetime for SQLite compatibility.

        ``after`` (aware or naive-UTC) overrides "now"; used by tests.

        ``last_run`` (aware or naive-UTC) is the occurrence that just fired. On
        a DST fall-back the same local wall-clock time occurs twice, so croniter
        legitimately yields it twice; passing the previous fire suppresses the
        duplicate so a daily 02:30 job runs once, not twice.
        """
        now_utc = after or datetime.now(timezone.utc)
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)
        now = now_utc.replace(tzinfo=None)
        stype = schedule_config.get("type")
        if stype == "cron":
            cron_expr = schedule_config.get("cron")
            if not cron_expr:
                return None
            tz = resolve_timezone(schedule_config.get("timezone"))
            try:
                cron = croniter(cron_expr, now_utc.astimezone(tz))
                last_local = None
                if last_run is not None:
                    aware = (
                        last_run
                        if last_run.tzinfo is not None
                        else last_run.replace(tzinfo=timezone.utc)
                    )
                    last_local = aware.astimezone(tz).replace(tzinfo=None)
                occurrence = cron.get_next(datetime)
                # At most one repeat is possible (a single fold), but allow a
                # couple of hops so an ambiguous *range* cannot loop forever.
                for _ in range(2):
                    if occurrence.replace(tzinfo=None) != last_local:
                        break
                    occurrence = cron.get_next(datetime)
                return to_naive_utc(occurrence)
            except (ValueError, KeyError) as e:
                logger.warning("Invalid cron expression %r: %s", cron_expr, e)
                return None
        elif stype == "interval":
            hours = schedule_config.get("hours", 0)
            minutes = schedule_config.get("minutes", 0)
            total_minutes = hours * 60 + minutes
            if total_minutes <= 0:
                return None
            return now + timedelta(minutes=total_minutes)
        return None
