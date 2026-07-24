"""Reader-facing schemas for persisted child-Agent runs."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


AgentRunStatus = Literal[
    "pending",
    "running",
    "waiting_input",
    "completed",
    "failed",
    "cancelled",
]


class AgentRunEvidenceOrigin(BaseModel):
    """Child-run provenance retained when evidence is deduplicated."""

    session_id: str
    agent_run_id: str
    agent_title: str
    status: AgentRunStatus
    tool: str


class AgentRunOutput(BaseModel):
    """One durable file produced by a child Agent."""

    name: str
    path: str
    type: str
    tool: str
    origins: list[AgentRunEvidenceOrigin] = Field(default_factory=list)


class AgentRunSource(BaseModel):
    """One durable web source with its originating tool."""

    url: str
    title: str
    domain: str
    snippet: str | None = None
    tool: str
    origins: list[AgentRunEvidenceOrigin] = Field(default_factory=list)


class AgentRunResponse(BaseModel):
    """One task or Swarm member shown for its direct parent Session."""

    id: str
    agent_run_id: str
    session_id: str
    parent_session_id: str
    parent_title: str
    title: str
    summary: str | None = None
    agent: str
    status: AgentRunStatus
    source: Literal["task", "swarm"]
    swarm_id: str | None = None
    ordinal: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    last_message_at: datetime | None = None
    time_updated: datetime
    error: str | None = None
    outputs: list[AgentRunOutput] = Field(default_factory=list)
    sources: list[AgentRunSource] = Field(default_factory=list)


class AgentRunCounts(BaseModel):
    active: int
    done: int
    total: int


class AgentRunListResponse(BaseModel):
    active: list[AgentRunResponse]
    done: list[AgentRunResponse]
    counts: AgentRunCounts
