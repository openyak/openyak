"""Versioned, secret-free regression failure records."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict


class FailureRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    regression_task: str
    observed: str
    mitigation: str
    status: Literal["open", "fixed", "monitored"]


class FailureSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    version: str
    failures: list[FailureRecord]


def load_failure_set(path: str | Path) -> FailureSet:
    """Load and strictly validate a public, scrubbed failure set."""
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return FailureSet.model_validate(data)
