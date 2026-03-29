"""SQLAlchemy model for workspace-scoped memory."""

from __future__ import annotations

from sqlalchemy import Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.utils.id import generate_ulid


class WorkspaceMemory(Base, TimestampMixin):
    """Per-workspace memory stored as a Markdown document.

    Each workspace directory gets at most one row.  The content is a
    free-form Markdown string capped at 200 lines by the storage layer.
    """

    __tablename__ = "workspace_memory"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)
    workspace_path: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")

    __table_args__ = (
        Index("ix_workspace_memory_path", "workspace_path", unique=True),
    )
