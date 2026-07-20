"""Automation (scheduled task) request/response schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, model_validator


class ScheduleConfig(BaseModel):
    type: Literal["cron", "interval"]
    cron: str | None = None  # e.g. "0 8 * * 1"
    hours: int | None = None
    minutes: int | None = None
    # IANA zone the cron expression is interpreted in (e.g. "Europe/Berlin").
    # Defaults to the system local zone; ignored for interval schedules.
    timezone: str | None = None

    @model_validator(mode="after")
    def validate_schedule(self) -> "ScheduleConfig":
        if self.type == "cron":
            if not self.cron:
                raise ValueError("cron expression is required for cron schedule type")
            try:
                from croniter import croniter
                if not croniter.is_valid(self.cron):
                    raise ValueError(f"Invalid cron expression: {self.cron}")
            except ImportError:
                pass  # croniter not available, skip validation
            # NOTE: deliberately *not* defaulted here. A partial PATCH that
            # omits `timezone` must inherit the task's stored zone, not the
            # server's local zone — see merge_schedule_timezone(), which the
            # API layer applies against the existing row. Defaulting at
            # validation time would make that inheritance impossible to
            # distinguish from an explicit choice.
            from app.utils.timezone import is_valid_timezone
            if self.timezone is not None and not is_valid_timezone(self.timezone):
                raise ValueError(f"Unknown timezone: {self.timezone}")
        elif self.type == "interval":
            hours = self.hours or 0
            minutes = self.minutes or 0
            if hours < 0 or minutes < 0:
                raise ValueError("Interval hours and minutes must be non-negative")
            if hours == 0 and minutes == 0:
                raise ValueError("Interval must have at least hours or minutes > 0")
        return self


class AutomationCreate(BaseModel):
    name: str
    description: str = ""
    prompt: str
    schedule_config: ScheduleConfig | None = None  # None for loop-only tasks
    agent: str = "build"
    model: str | None = None
    workspace: str | None = None
    template_id: str | None = None
    timeout_seconds: int = 1800  # 30 minutes default
    # Loop fields (None = single-shot automation)
    loop_max_iterations: int | None = None
    loop_preset: str | None = None


class AutomationUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    schedule_config: ScheduleConfig | None = None
    agent: str | None = None
    model: str | None = None
    workspace: str | None = None
    enabled: bool | None = None
    timeout_seconds: int | None = None
    loop_max_iterations: int | None = None
    loop_preset: str | None = None


class AutomationResponse(BaseModel):
    id: str
    name: str
    description: str
    prompt: str
    schedule_config: dict[str, Any]
    agent: str
    model: str | None
    workspace: str | None
    enabled: bool
    template_id: str | None
    last_run_at: datetime | None
    last_run_status: str | None
    last_session_id: str | None
    next_run_at: datetime | None
    run_count: int
    timeout_seconds: int
    loop_max_iterations: int | None = None
    loop_preset: str | None = None
    loop_stop_marker: str | None = None
    time_created: datetime
    time_updated: datetime

    model_config = {"from_attributes": True}


class TaskRunResponse(BaseModel):
    id: str
    task_id: str
    session_id: str | None
    status: str
    error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    triggered_by: str
    time_created: datetime

    model_config = {"from_attributes": True}


class RecentRunResponse(BaseModel):
    """A task run enriched with its parent task's name, for the global inbox
    feed across all automations."""

    id: str
    task_id: str
    task_name: str
    session_id: str | None
    status: str
    error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    triggered_by: str
    time_created: datetime


class TemplateResponse(BaseModel):
    id: str
    name: str
    description: str
    prompt: str
    schedule_config: dict[str, Any] | None = None
    category: str
    icon: str
    loop_max_iterations: int | None = None
    loop_preset: str | None = None
