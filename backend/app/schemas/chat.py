"""Chat request/response schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class PromptRequest(BaseModel):
    """Start a new generation."""

    session_id: str | None = None
    text: str
    model: str | None = None  # e.g. "claude-sonnet-4-20250514"
    provider_id: str | None = None  # e.g. "anthropic" — which provider to use for the model
    agent: str = "build"
    attachments: list[dict[str, Any]] = []
    permission_presets: dict[str, bool] | None = None
    permission_rules: list[dict[str, Any]] | None = None
    reasoning: bool | None = None  # Explicitly enable/disable reasoning
    workspace: str | None = None  # Workspace directory restriction
    format: dict[str, Any] | None = None  # e.g. {"type": "json_schema", "json_schema": {...}}


class PromptResponse(BaseModel):
    """Response after starting generation."""

    stream_id: str
    session_id: str


class CompactRequest(BaseModel):
    """Start a manual compaction stream for an existing session."""

    session_id: str
    model_id: str | None = None


class EditAndResendRequest(BaseModel):
    """Edit a user message and re-generate from that point."""

    session_id: str
    message_id: str  # The user message to edit
    text: str  # New text content
    model: str | None = None
    agent: str = "build"
    attachments: list[dict[str, Any]] = []
    permission_presets: dict[str, bool] | None = None
    permission_rules: list[dict[str, Any]] | None = None
    reasoning: bool | None = None
    workspace: str | None = None  # Workspace directory restriction
    format: dict[str, Any] | None = None  # e.g. {"type": "json_schema", "json_schema": {...}}


class AbortRequest(BaseModel):
    """Abort an active generation."""

    stream_id: str


class RespondRequest(BaseModel):
    """User responds to a question tool or permission request."""

    stream_id: str
    call_id: str
    response: Any  # depends on context — string for question, bool for permission
