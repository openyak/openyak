"""Versioned, declarative evaluation task definitions."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PermissionConfig(_StrictModel):
    file_changes: Literal["allow", "ask", "deny"]
    run_commands: Literal["allow", "ask", "deny"]


class BudgetConfig(_StrictModel):
    max_tool_calls: int = Field(gt=0)
    timeout_seconds: float = Field(gt=0)


class FileExistsAssertion(_StrictModel):
    type: Literal["file_exists"]
    path: str


class FileAbsentAssertion(_StrictModel):
    type: Literal["file_absent"]
    path: str


class TextEqualsAssertion(_StrictModel):
    type: Literal["text_equals"]
    path: str
    value: str
    normalize_newlines: bool = False


class NoUnexpectedChangesAssertion(_StrictModel):
    type: Literal["no_unexpected_changes"]
    allowed: list[str]


WorkspaceAssertion = Annotated[
    FileExistsAssertion | FileAbsentAssertion | TextEqualsAssertion | NoUnexpectedChangesAssertion,
    Field(discriminator="type"),
]


class WorkspaceScorerConfig(_StrictModel):
    type: Literal["workspace"]
    assertions: list[WorkspaceAssertion]


class ScriptedChunkConfig(_StrictModel):
    type: str
    data: dict[str, Any]


class ScriptedStepConfig(_StrictModel):
    chunks: list[ScriptedChunkConfig] = Field(default_factory=list)
    raise_error: str | None = None
    retry_after_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_step_action(self) -> "ScriptedStepConfig":
        if bool(self.chunks) == bool(self.raise_error):
            raise ValueError("A scripted step must define exactly one of chunks or raise_error")
        if self.retry_after_ms is not None and self.raise_error is None:
            raise ValueError("retry_after_ms requires raise_error")
        return self


class ScriptedProviderConfig(_StrictModel):
    model_id: str = "eval-scripted-model"
    steps: list[ScriptedStepConfig]


class EventExpectation(_StrictModel):
    event: str
    data_contains: dict[str, Any] = Field(default_factory=dict)


class EvaluationTask(_StrictModel):
    schema_version: Literal[1]
    suite_version: str
    task_id: str
    description: str
    execution_modes: list[Literal["scripted", "live"]] = Field(
        default_factory=lambda: ["scripted"]
    )
    prompt: str
    workspace_fixture: str
    allowed_tools: list[str]
    permissions: PermissionConfig
    budget: BudgetConfig
    scorer: WorkspaceScorerConfig
    scripted_provider: ScriptedProviderConfig | None = None
    expected_events: list[EventExpectation] = Field(default_factory=list)


def load_task(path: str | Path) -> EvaluationTask:
    """Load and validate one evaluation task manifest."""
    task_path = Path(path)
    data = yaml.safe_load(task_path.read_text(encoding="utf-8"))
    return EvaluationTask.model_validate(data)
