"""Message and Part models — conversation content with structured parts."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.utils.id import generate_ulid

if TYPE_CHECKING:
    from app.models.session import Session


class Message(Base, TimestampMixin):
    """A single message in a session (user or assistant).

    The `data` JSON column stores the full MessageInfo payload:
    - User: {role, model:{provider_id, model_id}, agent, system?, variant?, tools?}
    - Assistant: {role, parent_id, agent, model_id, provider_id, cost, tokens, error?, finish?}
    """

    __tablename__ = "message"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("session.id", ondelete="CASCADE"), nullable=False
    )
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    # Set when context collapse dropped this message from the prompt. The row
    # stays in the transcript (viewable, exportable) but is skipped when the
    # history is rebuilt for the model — see
    # docs/adr/0005-compaction-is-a-persistent-part.md.
    collapsed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    # Relationships
    session: Mapped[Session] = relationship(back_populates="messages")
    parts: Mapped[list[Part]] = relationship(
        back_populates="message", cascade="all, delete-orphan", order_by="Part.time_created"
    )


class Part(Base, TimestampMixin):
    """A part of a message — text, reasoning, tool call, step marker, etc.

    The `data` JSON column stores the Part payload, discriminated by `type`:
    - TextPart: {type:"text", text, synthetic?}
    - ReasoningPart: {type:"reasoning", text}
    - ToolPart: {type:"tool", tool, call_id, state:{status, input, output?, ...}}
    - StepStartPart: {type:"step-start", snapshot?}
    - StepFinishPart: {type:"step-finish", reason, tokens, cost}
    - CompactionPart: {type:"compaction", auto}
    - SubtaskPart: {type:"subtask", session_id, title, description}
    """

    __tablename__ = "part"
    __table_args__ = (
        Index("ix_part_session_id", "session_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=generate_ulid)
    message_id: Mapped[str] = mapped_column(
        ForeignKey("message.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[str] = mapped_column(String, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)

    # Relationships
    message: Mapped[Message] = relationship(back_populates="parts")
