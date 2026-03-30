"""ScheduledTask model — persistent scheduled/recurring automation."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.utils.id import generate_ulid


class ScheduledTask(Base, TimestampMixin):
    __tablename__ = "scheduled_task"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)

    # Task definition
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    prompt: Mapped[str] = mapped_column(String, nullable=False)

    # Schedule configuration (JSON)
    # {"type": "cron", "cron": "0 8 * * 1"}
    # {"type": "interval", "hours": 6}
    schedule_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    # Execution configuration
    agent: Mapped[str] = mapped_column(String, nullable=False, default="build")
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    workspace: Mapped[str | None] = mapped_column(String, nullable=True)

    # State
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Template tracking
    template_id: Mapped[str | None] = mapped_column(String, nullable=True)

    # Execution stats
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_run_status: Mapped[str | None] = mapped_column(String, nullable=True)
    last_session_id: Mapped[str | None] = mapped_column(String, nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    run_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Execution limits
    timeout_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1800  # 30 minutes
    )

    # Loop configuration (nullable = not a loop task, just a regular automation)
    loop_max_iterations: Mapped[int | None] = mapped_column(Integer, nullable=True)
    loop_preset: Mapped[str | None] = mapped_column(String, nullable=True)
    loop_stop_marker: Mapped[str | None] = mapped_column(
        String, nullable=True, default="[LOOP_DONE]"
    )
