"""Session model — a conversation with an agent."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.utils.id import generate_ulid

if TYPE_CHECKING:
    from app.models.message import Message
    from app.models.project import Project


class Session(Base, TimestampMixin):
    __tablename__ = "session"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("project.id", ondelete="CASCADE"), nullable=True
    )
    parent_id: Mapped[str | None] = mapped_column(String, nullable=True)  # SubAgent parent
    slug: Mapped[str] = mapped_column(String, nullable=False, default="")
    directory: Mapped[str] = mapped_column(String, nullable=False, default=".")
    title: Mapped[str] = mapped_column(String, nullable=False, default="New Session")
    version: Mapped[str] = mapped_column(String, nullable=False, default="0.0.1")

    # Last-used model + provider for this session. Persisted on every prompt so
    # the model selector can be restored when the user returns to the session
    # (per-session model memory). Nullable: legacy sessions and sessions with no
    # prompt yet fall back to the global default.
    model_id: Mapped[str | None] = mapped_column(String, nullable=True)
    provider_id: Mapped[str | None] = mapped_column(String, nullable=True)

    # Summary stats (updated after each LLM step)
    summary_additions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary_deletions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary_files: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary_diffs: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    # Pin to top of session list
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")

    # Permission override at session level
    permission: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)

    # Lifecycle timestamps
    time_compacting: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    time_archived: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    project: Mapped[Project | None] = relationship(back_populates="sessions")
    messages: Mapped[list[Message]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.time_created"
    )
