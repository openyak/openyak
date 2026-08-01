"""Deterministic scorers for observable evaluation outcomes."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from evals.task import (
    FileAbsentAssertion,
    FileExistsAssertion,
    NoUnexpectedChangesAssertion,
    TextEqualsAssertion,
    WorkspaceScorerConfig,
)
from evals.workspace import EvaluationWorkspace


class AssertionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    passed: bool
    path: str | None = None
    message: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class EvaluationScore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passed: bool
    metrics: dict[str, int | float]
    assertions: list[AssertionResult]


def score_workspace(
    config: WorkspaceScorerConfig,
    workspace: EvaluationWorkspace,
) -> EvaluationScore:
    """Score the final workspace state using declarative assertions."""
    results: list[AssertionResult] = []
    unexpected_changes = 0

    for assertion in config.assertions:
        if isinstance(assertion, FileExistsAssertion):
            path = _safe_path(workspace.path, assertion.path)
            passed = path.is_file() if path is not None else False
            results.append(AssertionResult(
                type=assertion.type,
                path=assertion.path,
                passed=passed,
                message=None if passed else "Expected file does not exist",
            ))
        elif isinstance(assertion, FileAbsentAssertion):
            path = _safe_path(workspace.path, assertion.path)
            passed = path is not None and not path.exists()
            results.append(AssertionResult(
                type=assertion.type,
                path=assertion.path,
                passed=passed,
                message=None if passed else "Expected path still exists",
            ))
        elif isinstance(assertion, TextEqualsAssertion):
            path = _safe_path(workspace.path, assertion.path)
            actual: str | None = None
            if path is not None and path.is_file():
                try:
                    actual = path.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    actual = None
            expected = assertion.value
            if assertion.normalize_newlines:
                actual = _normalize_newlines(actual) if actual is not None else None
                expected = _normalize_newlines(expected)
            passed = actual == expected
            results.append(AssertionResult(
                type=assertion.type,
                path=assertion.path,
                passed=passed,
                message=None if passed else "File text does not match expected value",
            ))
        elif isinstance(assertion, NoUnexpectedChangesAssertion):
            changes = workspace.diff().changes
            allowed = set(assertion.allowed)
            unexpected = sorted(path for path in changes if path not in allowed)
            unexpected_changes += len(unexpected)
            results.append(AssertionResult(
                type=assertion.type,
                passed=not unexpected,
                message=None if not unexpected else "Workspace contains unexpected changes",
                details={"unexpected": unexpected},
            ))

    passed_by_type = Counter(result.type for result in results if result.passed)
    metrics: dict[str, int | float] = {
        "assertions_total": len(results),
        "assertions_passed": sum(result.passed for result in results),
        "file_exists_passed": passed_by_type["file_exists"],
        "file_absent_passed": passed_by_type["file_absent"],
        "text_equals_passed": passed_by_type["text_equals"],
        "no_unexpected_changes_passed": passed_by_type["no_unexpected_changes"],
        "unexpected_changes": unexpected_changes,
    }
    return EvaluationScore(
        passed=all(result.passed for result in results),
        metrics=metrics,
        assertions=results,
    )


def _safe_path(root: Path, relative: str) -> Path | None:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")
