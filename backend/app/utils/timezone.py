"""IANA timezone helpers for scheduling.

Scheduled tasks store their cron expressions alongside an IANA timezone name
so that "0 8 * * *" means 08:00 *local* time, not 08:00 UTC. Occurrences are
computed in that zone (so DST transitions keep the wall-clock hour stable) and
persisted as UTC.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

UTC_NAME = "UTC"


def is_valid_timezone(name: str | None) -> bool:
    """True if ``name`` resolves to a known IANA zone."""
    if not name:
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return False
    return True


def _from_etc_localtime() -> str | None:
    """Resolve the zone name from the /etc/localtime symlink (POSIX)."""
    try:
        p = Path("/etc/localtime")
        if not p.is_symlink():
            return None
        parts = Path(os.readlink(p)).parts
        if "zoneinfo" not in parts:
            return None
        name = "/".join(parts[parts.index("zoneinfo") + 1:])
        return name if is_valid_timezone(name) else None
    except OSError:
        return None


def _from_tzlocal() -> str | None:
    """Resolve the zone name via tzlocal (the only probe that works on Windows).

    ``tzlocal`` is a declared dependency (see pyproject/requirements); it reads
    the Windows registry and maps the Windows zone id to an IANA name. The
    import is still guarded so a broken install degrades instead of crashing
    the scheduler.
    """
    try:
        import tzlocal  # type: ignore
    except ImportError:  # pragma: no cover - declared dependency
        logger.warning(
            "tzlocal is not installed; cannot determine the local timezone on "
            "this platform. Scheduled cron tasks will be interpreted as UTC. "
            "Install it (pip install tzlocal) or set the TZ environment variable."
        )
        return None
    try:
        name = str(tzlocal.get_localzone())
    except Exception:  # pragma: no cover - defensive
        logger.warning("tzlocal failed to resolve the local timezone", exc_info=True)
        return None
    return name if is_valid_timezone(name) else None


def get_local_timezone_name() -> str:
    """Best-effort IANA name of the system local timezone.

    Probe order: ``$TZ`` (explicit operator override) → ``/etc/localtime``
    (POSIX) → ``tzlocal`` (works everywhere, and is the *only* thing that
    works on Windows, where the first two probes always fail).

    Falls back to ``"UTC"`` when the platform gives us nothing usable (which
    preserves the historical behaviour rather than guessing wrong).
    """
    env_tz = os.environ.get("TZ")
    if is_valid_timezone(env_tz):
        return env_tz  # type: ignore[return-value]

    name = _from_etc_localtime()
    if name:
        return name

    name = _from_tzlocal()
    if name:
        return name

    logger.warning(
        "Could not determine the system timezone; falling back to UTC. "
        "Cron schedules will fire at UTC wall-clock times."
    )
    return UTC_NAME


def merge_schedule_timezone(
    new_config: dict, existing_config: dict | None = None
) -> dict:
    """Give a cron schedule config a concrete IANA timezone.

    An incoming config that omits ``timezone`` (e.g. a partial PATCH from an
    older client, or a built-in template) inherits the zone already stored on
    the task; only when there is nothing to inherit do we stamp the system
    local zone. Without this, a PATCH that omitted the field would silently
    reset the task to the *server's* zone — reintroducing the original bug on
    a UTC server.

    Interval configs never carry a timezone.
    """
    if new_config.get("type") != "cron":
        return {k: v for k, v in new_config.items() if k != "timezone"}
    if is_valid_timezone(new_config.get("timezone")):
        return dict(new_config)
    inherited = (existing_config or {}).get("timezone")
    resolved = inherited if is_valid_timezone(inherited) else get_local_timezone_name()
    return {**new_config, "timezone": resolved}


def resolve_timezone(name: str | None) -> ZoneInfo:
    """Return a ZoneInfo for ``name``, defaulting to the system local zone.

    Unknown/legacy values (e.g. rows written before the timezone field
    existed) degrade to the local zone instead of raising.
    """
    if is_valid_timezone(name):
        return ZoneInfo(name)  # type: ignore[arg-type]
    if name:
        logger.warning("Unknown timezone %r, falling back to local time", name)
    local = get_local_timezone_name()
    try:
        return ZoneInfo(local)
    except Exception:  # pragma: no cover - defensive
        return ZoneInfo(UTC_NAME)


def to_naive_utc(dt: datetime) -> datetime:
    """Normalise a datetime to naive UTC (the storage format)."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)
