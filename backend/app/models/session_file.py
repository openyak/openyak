"""SessionFile model — tracks files created/modified within a session."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.utils.id import generate_ulid

if TYPE_CHECKING:
    from app.models.session import Session


class SessionFile(Base, TimestampMixin):
    __tablename__ = "session_file"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("session.id", ondelete="CASCADE"), nullable=False
    )
    file_path: Mapped[str] = mapped_column(String, nullable=False)
    file_name: Mapped[str] = mapped_column(String, nullable=False)
    tool_id: Mapped[str] = mapped_column(String, nullable=False)
    file_type: Mapped[str] = mapped_column(String, nullable=False, default="generated")

    session: Mapped[Session] = relationship()
