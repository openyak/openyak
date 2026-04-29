"""SSE event schemas."""

from __future__ import annotations

from typing import Any

from app.schemas.message import StepFinishReason

from pydantic import BaseModel


class SSEEventData(BaseModel):
    """Typed SSE event payload."""

    # Common
    session_id: str | None = None
    message_id: str | None = None

    # text_delta / reasoning_delta
    text: str | None = None

    # tool_start / tool_result / tool_error
    tool: str | None = None
    call_id: str | None = None
    arguments: dict[str, Any] | None = None
    output: str | None = None
    title: str | None = None
    metadata: dict[str, Any] | None = None

    # step_finish
    tokens: dict[str, int] | None = None
    cost: float | None = None
    total_cost: float | None = None
    reason: StepFinishReason | None = None

    # permission_request
    permission: str | None = None
    patterns: list[str] | None = None
    tool_call_id: str | None = None
    message: str | None = None
    arguments_truncated: bool | None = None

    # error
    error_type: str | None = None
    error_message: str | None = None

    # done
    finish_reason: str | None = None

    # step_start
    step: int | None = None
