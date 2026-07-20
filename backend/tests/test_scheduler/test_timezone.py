"""Tests for timezone-aware cron scheduling (app.scheduler.engine)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from app.scheduler.engine import TaskScheduler
from app.schemas.automation import ScheduleConfig
from app.utils.timezone import (
    get_local_timezone_name,
    is_valid_timezone,
    merge_schedule_timezone,
    resolve_timezone,
    to_naive_utc,
)

UTC = ZoneInfo("UTC")
NY = "America/New_York"
BERLIN = "Europe/Berlin"
TOKYO = "Asia/Tokyo"


def _next(config: dict, after: datetime) -> datetime:
    result = TaskScheduler._compute_next_run(config, after=after)
    assert result is not None
    return result


class TestCronTimezone:
    def test_daily_8am_fires_at_local_8am_not_utc(self):
        """"0 8 * * *" in New York = 13:00 UTC (EST), not 08:00 UTC."""
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next({"type": "cron", "cron": "0 8 * * *", "timezone": NY}, after)
        assert nxt == datetime(2026, 1, 15, 13, 0)
        # And in the task's own zone it really is 08:00 local.
        assert nxt.replace(tzinfo=UTC).astimezone(ZoneInfo(NY)).hour == 8

    def test_explicit_utc_timezone_matches_old_behaviour(self):
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next({"type": "cron", "cron": "0 8 * * *", "timezone": "UTC"}, after)
        assert nxt == datetime(2026, 1, 15, 8, 0)

    def test_zone_ahead_of_utc_rolls_to_previous_utc_day(self):
        """Tokyo 08:00 on the 15th is 23:00 UTC on the 14th."""
        after = datetime(2026, 1, 14, 12, 0, tzinfo=UTC)
        nxt = _next({"type": "cron", "cron": "0 8 * * *", "timezone": TOKYO}, after)
        assert nxt == datetime(2026, 1, 14, 23, 0)

    def test_weekday_cron_uses_local_day_of_week(self):
        """Monday 08:00 Tokyo = Sunday 23:00 UTC — the local DOW must win."""
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)  # Thursday
        nxt = _next({"type": "cron", "cron": "0 8 * * 1", "timezone": TOKYO}, after)
        assert nxt == datetime(2026, 1, 18, 23, 0)  # Sunday UTC
        assert nxt.replace(tzinfo=UTC).astimezone(ZoneInfo(TOKYO)).weekday() == 0

    def test_result_is_naive_utc(self):
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next({"type": "cron", "cron": "0 8 * * *", "timezone": BERLIN}, after)
        assert nxt.tzinfo is None


class TestDstTransitions:
    def test_daily_8am_stays_8am_across_spring_forward(self):
        """US DST starts 2026-03-08. 08:00 local = 13:00 UTC before, 12:00 after."""
        config = {"type": "cron", "cron": "0 8 * * *", "timezone": NY}
        before = _next(config, datetime(2026, 3, 7, 0, 0, tzinfo=UTC))
        assert before == datetime(2026, 3, 7, 13, 0)  # EST, UTC-5

        after = _next(config, datetime(2026, 3, 8, 14, 0, tzinfo=UTC))
        assert after == datetime(2026, 3, 9, 12, 0)  # EDT, UTC-4

        ny = ZoneInfo(NY)
        for run in (before, after):
            local = run.replace(tzinfo=UTC).astimezone(ny)
            assert (local.hour, local.minute) == (8, 0)

    def test_daily_8am_stays_8am_across_fall_back(self):
        """US DST ends 2026-11-01."""
        config = {"type": "cron", "cron": "0 8 * * *", "timezone": NY}
        before = _next(config, datetime(2026, 10, 31, 0, 0, tzinfo=UTC))
        assert before == datetime(2026, 10, 31, 12, 0)  # EDT

        after = _next(config, datetime(2026, 11, 1, 14, 0, tzinfo=UTC))
        assert after == datetime(2026, 11, 2, 13, 0)  # EST

        ny = ZoneInfo(NY)
        for run in (before, after):
            assert run.replace(tzinfo=UTC).astimezone(ny).hour == 8

    def test_southern_hemisphere_dst(self):
        """Australia moves the other way; 08:00 Sydney must still be 08:00."""
        config = {"type": "cron", "cron": "0 8 * * *", "timezone": "Australia/Sydney"}
        syd = ZoneInfo("Australia/Sydney")
        for moment in (
            datetime(2026, 4, 4, 0, 0, tzinfo=UTC),   # before DST ends
            datetime(2026, 4, 6, 0, 0, tzinfo=UTC),   # after DST ends
        ):
            nxt = _next(config, moment)
            assert nxt.replace(tzinfo=UTC).astimezone(syd).hour == 8

    # -- Transition-hour cases (finding 5): the schedule fires AT the fold. --

    def test_nonexistent_spring_forward_hour_is_shifted_not_dropped(self):
        """US spring-forward 2026-03-08 skips 02:00→03:00, so 02:30 never exists.

        A '30 2 * * *' job must still fire that day — croniter shifts it onto
        the far side of the gap (03:xx EDT) rather than dropping it or crashing.
        The result must be a real instant that round-trips through the zone.
        """
        ny = ZoneInfo(NY)
        config = {"type": "cron", "cron": "30 2 * * *", "timezone": NY}
        nxt = _next(config, datetime(2026, 3, 8, 0, 0, tzinfo=UTC))
        assert nxt.date() == date(2026, 3, 8)
        local = nxt.replace(tzinfo=UTC).astimezone(ny)
        # The wall-clock 02:30 does not exist; the fire lands past the gap.
        assert (local.hour, local.minute) == (3, 0)
        # And it is unambiguously EDT (UTC-4), i.e. after the transition.
        assert local.utcoffset().total_seconds() == -4 * 3600

    def test_ambiguous_fall_back_hour_fires_once_not_twice(self):
        """US fall-back 2026-11-01: 01:00→01:59 happens twice (EDT then EST).

        A '30 1 * * *' job must fire ONCE, not twice. croniter legitimately
        yields both folds; feeding the just-fired occurrence back into the next
        computation (as the reschedule path does) must skip the duplicate and
        advance to the next day.
        """
        ny = ZoneInfo(NY)
        config = {"type": "cron", "cron": "30 1 * * *", "timezone": NY}

        first = _next(config, datetime(2026, 10, 31, 12, 0, tzinfo=UTC))
        assert first == datetime(2026, 11, 1, 5, 30)  # 01:30 EDT (UTC-4)
        assert first.replace(tzinfo=UTC).astimezone(ny).utcoffset().total_seconds() == -4 * 3600

        # Without dedup, the naive reschedule re-emits the SAME wall clock in
        # EST — a second fire on the same calendar day. Prove that is what we
        # are guarding against.
        dup = TaskScheduler._compute_next_run(config, after=first)
        assert dup == datetime(2026, 11, 1, 6, 30)  # 01:30 EST, same day
        assert dup.replace(tzinfo=UTC).astimezone(ny).date() == first.replace(tzinfo=UTC).astimezone(ny).date()

        # With the just-fired occurrence passed as last_run, we skip that
        # duplicate fold and land on the next day's 01:30 EST instead.
        deduped = TaskScheduler._compute_next_run(config, after=first, last_run=first)
        assert deduped == datetime(2026, 11, 2, 6, 30)
        nxt_local = deduped.replace(tzinfo=UTC).astimezone(ny)
        assert (nxt_local.hour, nxt_local.minute) == (1, 30)
        assert nxt_local.date() == date(2026, 11, 2)


class TestLegacyRowsWithoutTimezone:
    def test_missing_timezone_falls_back_to_local_zone(self, monkeypatch):
        """Rows written before the field existed must keep working."""
        monkeypatch.setenv("TZ", NY)
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next({"type": "cron", "cron": "0 8 * * *"}, after)
        assert nxt == datetime(2026, 1, 15, 13, 0)

    def test_unknown_timezone_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("TZ", "UTC")
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next(
            {"type": "cron", "cron": "0 8 * * *", "timezone": "Mars/Olympus_Mons"},
            after,
        )
        assert nxt == datetime(2026, 1, 15, 8, 0)

    def test_backfill_stamps_local_zone_on_legacy_cron_config(self, monkeypatch):
        monkeypatch.setenv("TZ", BERLIN)

        class _Row:
            schedule_config = {"type": "cron", "cron": "0 8 * * *"}

        row = _Row()
        assert TaskScheduler._backfill_timezone(row) is True
        assert row.schedule_config["timezone"] == BERLIN
        # Idempotent, and the dict is replaced (JSON change detection).
        assert TaskScheduler._backfill_timezone(row) is False

    def test_backfill_ignores_interval_configs(self):
        class _Row:
            schedule_config = {"type": "interval", "hours": 6}

        row = _Row()
        assert TaskScheduler._backfill_timezone(row) is False
        assert "timezone" not in row.schedule_config


class TestIntervalUnaffected:
    def test_interval_still_relative_to_now(self):
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        nxt = _next({"type": "interval", "hours": 2, "minutes": 30}, after)
        assert nxt == datetime(2026, 1, 15, 2, 30)


class TestScheduleConfigSchema:
    def test_cron_timezone_not_defaulted_at_validation(self, monkeypatch):
        """The schema must NOT stamp a default zone.

        Defaulting here would make a partial PATCH that omits ``timezone``
        indistinguishable from one that explicitly chose the server's zone,
        which is exactly how the original bug crept back in (finding 1). The
        default is resolved by ``merge_schedule_timezone`` at the API layer,
        against the task's stored config — see TestMergeScheduleTimezone.
        """
        monkeypatch.setenv("TZ", TOKYO)
        cfg = ScheduleConfig(type="cron", cron="0 8 * * *")
        assert cfg.timezone is None

    def test_explicit_timezone_preserved(self):
        cfg = ScheduleConfig(type="cron", cron="0 8 * * *", timezone=BERLIN)
        assert cfg.timezone == BERLIN

    def test_invalid_timezone_rejected(self):
        with pytest.raises(ValueError):
            ScheduleConfig(type="cron", cron="0 8 * * *", timezone="Not/AZone")

    def test_interval_has_no_timezone(self):
        cfg = ScheduleConfig(type="interval", hours=6)
        assert cfg.timezone is None
        assert "timezone" not in cfg.model_dump(exclude_none=True)


class TestTimezoneUtils:
    def test_is_valid_timezone(self):
        assert is_valid_timezone("UTC")
        assert is_valid_timezone(NY)
        assert not is_valid_timezone("")
        assert not is_valid_timezone(None)
        assert not is_valid_timezone("Nope/Nope")

    def test_get_local_timezone_name_honours_tz_env(self, monkeypatch):
        monkeypatch.setenv("TZ", BERLIN)
        assert get_local_timezone_name() == BERLIN

    def test_get_local_timezone_name_ignores_garbage_tz(self, monkeypatch):
        monkeypatch.setenv("TZ", "garbage")
        assert is_valid_timezone(get_local_timezone_name())

    def test_falls_back_to_tzlocal_when_posix_probes_fail(self, monkeypatch):
        """Finding 2: on Windows, $TZ and /etc/localtime both fail.

        The only thing that resolves a real zone there is tzlocal, which is now
        a declared dependency. Simulate that platform by removing TZ and
        forcing the /etc/localtime probe to miss; the result must still be a
        valid IANA zone (not the UTC fallback), proving tzlocal is consulted.
        """
        import app.utils.timezone as tzmod

        monkeypatch.delenv("TZ", raising=False)
        monkeypatch.setattr(tzmod, "_from_etc_localtime", lambda: None)
        monkeypatch.setattr(tzmod, "_from_tzlocal", lambda: "America/New_York")
        assert tzmod.get_local_timezone_name() == "America/New_York"

    def test_tzlocal_is_a_declared_dependency(self):
        """tzlocal must be importable — it is the Windows-correct probe."""
        import importlib.metadata as md

        # Raises PackageNotFoundError if it is not actually installed/declared.
        assert md.version("tzlocal")

    def test_tzlocal_resolves_a_valid_zone_on_this_platform(self):
        """The real tzlocal probe returns a usable IANA name here."""
        from app.utils.timezone import _from_tzlocal

        name = _from_tzlocal()
        assert name is not None and is_valid_timezone(name)

    def test_resolve_timezone_defaults_to_local(self, monkeypatch):
        monkeypatch.setenv("TZ", TOKYO)
        assert str(resolve_timezone(None)) == TOKYO

    def test_to_naive_utc(self):
        aware = datetime(2026, 1, 15, 8, 0, tzinfo=ZoneInfo(NY))
        assert to_naive_utc(aware) == datetime(2026, 1, 15, 13, 0)
        naive = datetime(2026, 1, 15, 8, 0)
        assert to_naive_utc(naive) == naive

    def test_naive_after_is_treated_as_utc(self):
        nxt = TaskScheduler._compute_next_run(
            {"type": "cron", "cron": "0 8 * * *", "timezone": "UTC"},
            after=datetime(2026, 1, 15, 0, 0),
        )
        assert nxt == datetime(2026, 1, 15, 8, 0)


class TestRegressionUtcBug:
    def test_cron_no_longer_interpreted_as_utc(self):
        """The original bug: "0 8 * * *" fired at 08:00 UTC regardless of zone."""
        after = datetime(2026, 1, 15, 0, 0, tzinfo=UTC)
        for tz_name in (NY, BERLIN, TOKYO):
            nxt = _next({"type": "cron", "cron": "0 8 * * *", "timezone": tz_name}, after)
            assert nxt != datetime(2026, 1, 15, 8, 0), (
                f"{tz_name} cron still resolving to naive UTC 08:00"
            )


class TestMergeScheduleTimezone:
    """The server-side merge that keeps a partial PATCH from dropping the zone.

    This is the fix for finding 1: ``ScheduleConfig`` no longer defaults the
    zone at validation time, so the *only* place a default is chosen is here,
    against the task's stored config.
    """

    def test_explicit_timezone_kept(self):
        merged = merge_schedule_timezone(
            {"type": "cron", "cron": "0 8 * * *", "timezone": BERLIN}
        )
        assert merged["timezone"] == BERLIN

    def test_missing_timezone_inherits_stored_zone_not_server_zone(self, monkeypatch):
        """A partial PATCH omitting `timezone` must keep the task's OWN zone.

        This is the exact regression: on a UTC server, a PATCH that only
        changed the cron string used to reset the task to the server's zone,
        reintroducing the 08:00-UTC bug. The stored Tokyo zone must survive.
        """
        monkeypatch.setenv("TZ", "UTC")  # simulate a UTC server
        existing = {"type": "cron", "cron": "0 8 * * *", "timezone": TOKYO}
        merged = merge_schedule_timezone(
            {"type": "cron", "cron": "0 9 * * *"}, existing
        )
        assert merged["timezone"] == TOKYO  # inherited, NOT reset to UTC
        assert merged["cron"] == "0 9 * * *"

    def test_missing_timezone_and_no_stored_zone_uses_server_zone(self, monkeypatch):
        monkeypatch.setenv("TZ", BERLIN)
        merged = merge_schedule_timezone({"type": "cron", "cron": "0 8 * * *"}, None)
        assert merged["timezone"] == BERLIN

    def test_stored_config_without_zone_falls_back_to_server_zone(self, monkeypatch):
        monkeypatch.setenv("TZ", BERLIN)
        existing = {"type": "cron", "cron": "0 8 * * *"}  # legacy, no zone
        merged = merge_schedule_timezone(
            {"type": "cron", "cron": "0 9 * * *"}, existing
        )
        assert merged["timezone"] == BERLIN

    def test_invalid_incoming_timezone_falls_back_to_inherited(self, monkeypatch):
        monkeypatch.setenv("TZ", "UTC")
        existing = {"type": "cron", "cron": "0 8 * * *", "timezone": NY}
        merged = merge_schedule_timezone(
            {"type": "cron", "cron": "0 8 * * *", "timezone": "Bogus/Zone"}, existing
        )
        assert merged["timezone"] == NY

    def test_interval_never_carries_timezone(self):
        merged = merge_schedule_timezone(
            {"type": "interval", "hours": 6, "timezone": NY}
        )
        assert "timezone" not in merged


class TestBackfillOrmPersistence:
    """Finding 4: prove the backfill actually persists to the JSON column.

    ``schedule_config`` is a plain ``JSON`` column (no MutableDict), so an
    in-place mutation is NOT tracked by SQLAlchemy and would silently fail to
    persist. These tests exercise real ORM round-trips through the scheduler's
    own session factory — not a hand-rolled fake row — to prove the production
    reassignment survives a fresh session, and finding 3: that the stale
    next_run_at is recomputed rather than kept.
    """

    def _scheduler(self, session_factory):
        return TaskScheduler(session_factory, app_state=None)

    async def _insert_legacy_task(self, session_factory, *, next_run_at, config):
        from app.models.scheduled_task import ScheduledTask
        from app.utils.id import generate_ulid

        task_id = generate_ulid()
        async with session_factory() as db:
            async with db.begin():
                db.add(
                    ScheduledTask(
                        id=task_id,
                        name="legacy",
                        description="",
                        prompt="do a thing",
                        schedule_config=config,
                        enabled=True,
                        next_run_at=next_run_at,
                    )
                )
        return task_id

    async def _read_config_and_next(self, session_factory, task_id):
        from app.models.scheduled_task import ScheduledTask
        from sqlalchemy import select

        async with session_factory() as db:
            task = (
                await db.execute(
                    select(ScheduledTask).where(ScheduledTask.id == task_id)
                )
            ).scalar_one()
            return dict(task.schedule_config), task.next_run_at

    async def test_recompute_persists_backfilled_zone_and_recomputes_next_run(
        self, session_factory, monkeypatch
    ):
        monkeypatch.setenv("TZ", NY)
        # A stale next_run_at written under the OLD UTC interpretation: 08:00
        # UTC, well in the future so the pre-fix "only if stale" guard would
        # have KEPT it (that is the finding-3 bug).
        stale = datetime(2999, 1, 1, 8, 0)
        task_id = await self._insert_legacy_task(
            session_factory,
            next_run_at=stale,
            config={"type": "cron", "cron": "0 8 * * *"},  # no timezone
        )

        await self._scheduler(session_factory)._recompute_all_next_run()

        config, next_run = await self._read_config_and_next(session_factory, task_id)
        # Zone was stamped AND persisted across a fresh session.
        assert config["timezone"] == NY
        # next_run_at was recomputed from the zone, not left at 08:00 UTC.
        assert next_run != stale
        local = next_run.replace(tzinfo=UTC).astimezone(ZoneInfo(NY))
        assert (local.hour, local.minute) == (8, 0)  # 08:00 New York, not UTC

    async def test_sync_task_persists_backfilled_zone(
        self, session_factory, monkeypatch
    ):
        monkeypatch.setenv("TZ", BERLIN)
        task_id = await self._insert_legacy_task(
            session_factory,
            next_run_at=None,
            config={"type": "cron", "cron": "0 8 * * *"},
        )

        await self._scheduler(session_factory).sync_task(task_id)

        config, next_run = await self._read_config_and_next(session_factory, task_id)
        assert config["timezone"] == BERLIN
        assert next_run is not None
        assert next_run.replace(tzinfo=UTC).astimezone(ZoneInfo(BERLIN)).hour == 8

    async def test_inplace_mutation_would_not_persist(self, session_factory):
        """Guard the invariant the production code relies on.

        If someone "simplified" ``_backfill_timezone`` to mutate the dict in
        place instead of reassigning it, the change would be lost — this test
        demonstrates that on the very same column, so the reassignment in the
        production code is load-bearing, not stylistic.
        """
        from app.models.scheduled_task import ScheduledTask
        from sqlalchemy import select

        task_id = await self._insert_legacy_task(
            session_factory,
            next_run_at=None,
            config={"type": "cron", "cron": "0 8 * * *"},
        )

        # In-place mutation + flush, WITHOUT reassignment.
        async with session_factory() as db:
            async with db.begin():
                task = (
                    await db.execute(
                        select(ScheduledTask).where(ScheduledTask.id == task_id)
                    )
                ).scalar_one()
                task.schedule_config["timezone"] = NY  # in place, not reassigned

        config, _ = await self._read_config_and_next(session_factory, task_id)
        assert "timezone" not in config  # the in-place change was NOT persisted
