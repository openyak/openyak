"""Session schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class SessionCreate(BaseModel):
    """Create a new session."""

    project_id: str | None = None
    directory: str | None = None
    title: str | None = None
    agent: str = "build"


class SessionUpdate(BaseModel):
    """Update session fields."""

    title: str | None = None
    directory: str | None = None
    is_pinned: bool | None = None
    time_archived: datetime | None = None
    permission: dict[str, Any] | None = None


class SessionResponse(BaseModel):
    """Session detail response."""

    id: str
    project_id: str | None = None
    parent_id: str | None = None
    slug: str | None = None
    directory: str | None = None
    title: str | None = None
    version: str = "0.0.1"
    summary_additions: int | None = None
    summary_deletions: int | None = None
    summary_files: int | None = None
    summary_diffs: list[Any] | None = None
    is_pinned: bool = False
    permission: dict[str, Any] | list[Any] | None = None
    time_created: datetime
    time_updated: datetime
    time_compacting: datetime | None = None
    time_archived: datetime | None = None

    model_config = {"from_attributes": True}


class SessionSearchResult(BaseModel):
    """A single search result with optional content snippet."""

    session: SessionResponse
    snippet: str | None = None


class SessionList(BaseModel):
    """Paginated session list."""

    items: list[SessionResponse]
    total: int


class SessionCompactionRequest(BaseModel):
    """Optional body for POST /sessions/{id}/compact."""

    model_id: str | None = None
