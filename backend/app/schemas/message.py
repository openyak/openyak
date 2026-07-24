"""Message and Part schemas.

Message data is stored as JSON. These schemas define the structure
of the JSON payloads, not the ORM models themselves.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, TypeAlias

from pydantic import BaseModel


# --- Part types (discriminated union via 'type' field) ---

StepFinishReason: TypeAlias = Literal["stop", "tool_use", "length", "error"]


class TextPart(BaseModel):
    type: Literal["text"] = "text"
    text: str
    synthetic: bool = False


class ReasoningPart(BaseModel):
    type: Literal["reasoning"] = "reasoning"
    text: str


class ToolState(BaseModel):
    status: str  # "pending" | "running" | "completed" | "error"
    input: dict[str, Any] = {}
    output: str | None = None
    metadata: dict[str, Any] | None = None
    title: str | None = None
    time_start: datetime | None = None
    time_end: datetime | None = None
    time_compacted: datetime | None = None


class ToolPart(BaseModel):
    type: Literal["tool"] = "tool"
    tool: str
    call_id: str
    state: ToolState


class StepStartPart(BaseModel):
    type: Literal["step-start"] = "step-start"
    snapshot: dict[str, Any] | None = None


class StepFinishPart(BaseModel):
    type: Literal["step-finish"] = "step-finish"
    reason: StepFinishReason
    tokens: dict[str, int] = {}
    cost: float = 0.0


class CompactionPart(BaseModel):
    type: Literal["compaction"] = "compaction"
    auto: bool = True


class SubtaskPart(BaseModel):
    type: Literal["subtask"] = "subtask"
    session_id: str
    title: str
    description: str = ""
    task_id: str | None = None
    parent_id: str | None = None
    agent: str | None = None
    status: Literal[
        "pending",
        "running",
        "waiting_input",
        "completed",
        "failed",
        "cancelled",
    ] | None = None
    depth: int | None = None
    revision: int | None = None
    resumed: bool = False
    error: str | None = None
    cost: float = 0.0
    tokens: dict[str, int] = {}
    started_at: datetime | None = None
    finished_at: datetime | None = None


class SwarmMemberPart(BaseModel):
    agent_run_id: str
    session_id: str
    ordinal: int
    title: str
    agent: str
    provider_id: str | None = None
    model_id: str | None = None
    depth: int = 1
    status: Literal[
        "pending",
        "running",
        "waiting_input",
        "completed",
        "failed",
        "cancelled",
    ]
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    cost: float = 0.0
    tokens: dict[str, int] = {}


class SwarmPart(BaseModel):
    type: Literal["swarm"] = "swarm"
    schema_version: int = 1
    swarm_id: str
    parent_session_id: str
    revision: int
    status: Literal["running", "completed", "partial", "failed", "cancelled"]
    strategy: Literal["parallel"] = "parallel"
    failure_policy: Literal["continue"] = "continue"
    started_at: datetime
    finished_at: datetime | None = None
    members: list[SwarmMemberPart] = []


class FilePart(BaseModel):
    type: Literal["file"] = "file"
    file_id: str
    name: str
    path: str
    size: int
    mime_type: str
    source: Literal["referenced", "uploaded"] = "uploaded"
    content_hash: str | None = None


PartData = (
    TextPart
    | ReasoningPart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | CompactionPart
    | SubtaskPart
    | SwarmPart
    | FilePart
)


# --- Message info types ---


class ModelRef(BaseModel):
    provider_id: str
    model_id: str


class TokenUsage(BaseModel):
    input: int = 0
    output: int = 0
    reasoning: int = 0
    cache_read: int = 0
    cache_write: int = 0


class UserMessageInfo(BaseModel):
    role: Literal["user"] = "user"
    model: ModelRef | None = None
    agent: str = "build"
    system: str | None = None
    variant: str | None = None
    tools: list[str] | None = None


class AssistantMessageInfo(BaseModel):
    role: Literal["assistant"] = "assistant"
    parent_id: str | None = None
    agent: str = "build"
    model_id: str | None = None
    provider_id: str | None = None
    cost: float = 0.0
    tokens: TokenUsage = TokenUsage()
    error: str | None = None
    finish: StepFinishReason | None = None
    summary: bool = False
    mode: str | None = None


MessageInfo = UserMessageInfo | AssistantMessageInfo


# --- API response schemas ---


class PartResponse(BaseModel):
    id: str
    message_id: str
    session_id: str
    time_created: datetime
    data: dict[str, Any]

    model_config = {"from_attributes": True}


class MessageResponse(BaseModel):
    id: str
    session_id: str
    time_created: datetime
    data: dict[str, Any]
    # Set when context collapse dropped this message from the prompt. The
    # message is still part of the transcript — clients may render it dimmed
    # or behind a "collapsed" marker, but must keep showing it.
    collapsed_at: datetime | None = None
    parts: list[PartResponse] = []

    model_config = {"from_attributes": True}


class PaginatedMessages(BaseModel):
    total: int
    offset: int
    messages: list[MessageResponse]
