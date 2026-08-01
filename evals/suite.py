"""Run and aggregate a directory of versioned evaluation tasks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.provider.base import BaseProvider
from evals.runtime import run_task
from evals.task import load_task


class SuiteTaskResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str
    passed: bool
    duration_ms: float
    tool_calls: int
    tool_executions: int
    retry_count: int
    workspace_changes: dict[str, str]
    output: str
    metrics: dict[str, int | float]


class SuiteSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    suite_version: str
    execution_mode: Literal["scripted", "live"]
    attempts: int
    passed: int
    pass_rate: float
    total_duration_ms: float
    tasks: list[SuiteTaskResult]


async def run_suite(
    tasks_directory: str | Path,
    output_directory: str | Path,
    *,
    provider: BaseProvider | None = None,
    execution_mode: Literal["scripted", "live"] = "scripted",
) -> SuiteSummary:
    """Run every YAML task in a directory and write one aggregate summary."""
    tasks_dir = Path(tasks_directory).resolve()
    output_dir = Path(output_directory).resolve()
    task_files = discover_task_files(tasks_dir, execution_mode=execution_mode)
    if not task_files:
        raise ValueError(f"No evaluation tasks found in {tasks_dir}")
    output_dir.mkdir(parents=True, exist_ok=False)

    task_results: list[SuiteTaskResult] = []
    suite_versions: set[str] = set()
    for task_file in task_files:
        task_output = output_dir / task_file.stem
        attempt = await run_task(task_file, task_output, provider=provider)
        suite_versions.add(attempt.suite_version)
        task_results.append(SuiteTaskResult(
            task_id=attempt.task_id,
            passed=attempt.score.passed,
            duration_ms=attempt.duration_ms,
            tool_calls=attempt.tool_calls,
            tool_executions=attempt.tool_executions,
            retry_count=attempt.retry_count,
            workspace_changes=attempt.workspace_changes,
            output=str(task_output),
            metrics=attempt.score.metrics,
        ))

    if len(suite_versions) != 1:
        raise ValueError(f"Task directory mixes suite versions: {sorted(suite_versions)}")
    passed = sum(result.passed for result in task_results)
    summary = SuiteSummary(
        suite_version=suite_versions.pop(),
        execution_mode=execution_mode,
        attempts=len(task_results),
        passed=passed,
        pass_rate=passed / len(task_results),
        total_duration_ms=sum(result.duration_ms for result in task_results),
        tasks=task_results,
    )
    (output_dir / "suite-summary.json").write_text(
        json.dumps(summary.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


def discover_task_files(
    tasks_directory: str | Path,
    *,
    execution_mode: Literal["scripted", "live"],
) -> list[Path]:
    """Return deterministic task paths eligible for one execution mode."""
    tasks_dir = Path(tasks_directory).resolve()
    task_files = sorted([*tasks_dir.glob("*.yaml"), *tasks_dir.glob("*.yml")])
    return [
        task_file
        for task_file in task_files
        if execution_mode in load_task(task_file).execution_modes
    ]
