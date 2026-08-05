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
    provider: str
    model: str
    tool_call_mode: str
    attempts: int
    passed: int
    pass_rate: float
    total_duration_ms: float
    structured_metrics: dict[str, int | float | None]
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
    providers: set[str] = set()
    models: set[str] = set()
    tool_call_modes: set[str] = set()
    for task_file in task_files:
        task_output = output_dir / task_file.stem
        attempt = await run_task(task_file, task_output, provider=provider)
        suite_versions.add(attempt.suite_version)
        providers.add(attempt.provider)
        models.add(attempt.model)
        tool_call_modes.add(attempt.configuration.tool_call_mode)
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
        provider=providers.pop(),
        model=models.pop(),
        tool_call_mode=tool_call_modes.pop(),
        attempts=len(task_results),
        passed=passed,
        pass_rate=passed / len(task_results),
        total_duration_ms=sum(result.duration_ms for result in task_results),
        structured_metrics=aggregate_structured_metrics(
            [result.metrics for result in task_results]
        ),
        tasks=task_results,
    )
    (output_dir / "suite-summary.json").write_text(
        json.dumps(summary.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / "structured-summary.md").write_text(
        render_structured_summary(summary),
        encoding="utf-8",
    )
    return summary


def aggregate_structured_metrics(
    attempts: list[dict[str, int | float]],
) -> dict[str, int | float | None]:
    """Aggregate first-attempt structured generation metrics reproducibly."""
    eligible = sum(int(item.get("structured_attempt_at_1", 0)) for item in attempts)
    semantic_eligible = sum(
        int(item.get("semantic_evaluated_at_1", 0)) for item in attempts
    )
    repair_attempts = sum(
        int(item.get("repair_attempted_at_1", 0)) for item in attempts
    )

    def rate(numerator: str, denominator: int) -> float | None:
        if denominator == 0:
            return None
        return sum(float(item.get(numerator, 0)) for item in attempts) / denominator

    return {
        "eligible_attempts": eligible,
        "tool_selection_rate": rate("tool_selection_at_1", eligible),
        "schema_valid_at_1_rate": rate("strict_schema_valid_at_1", eligible),
        "execution_success_at_1_rate": rate(
            "execution_success_at_1",
            eligible,
        ),
        "semantic_evaluated_attempts": semantic_eligible,
        "semantic_argument_accuracy": rate(
            "semantic_valid_at_1",
            semantic_eligible,
        ),
        "repair_attempts": repair_attempts,
        "repair_attempt_rate": rate("repair_attempted_at_1", eligible),
        "repair_success_rate": rate("repair_success_at_1", repair_attempts),
        "average_repair_extra_tokens": rate(
            "repair_extra_tokens_at_1",
            repair_attempts,
        ),
        "average_repair_latency_ms": rate(
            "repair_latency_ms_at_1",
            repair_attempts,
        ),
    }


def render_structured_metrics_row(
    *,
    label: str,
    pass_rate: float,
    metrics: dict[str, int | float | None],
) -> str:
    """Render one reproducible structured-generation benchmark row."""
    def percentage(key: str) -> str:
        value = metrics.get(key)
        return "—" if value is None else f"{float(value) * 100:.1f}%"

    def number(key: str, suffix: str = "") -> str:
        value = metrics.get(key)
        return "—" if value is None else f"{float(value):.{'3' if suffix else '2'}f}{suffix}"

    cells = [
        label,
        f"{pass_rate * 100:.1f}%",
        percentage("tool_selection_rate"),
        percentage("schema_valid_at_1_rate"),
        percentage("execution_success_at_1_rate"),
        percentage("semantic_argument_accuracy"),
        percentage("repair_attempt_rate"),
        percentage("repair_success_rate"),
        number("average_repair_extra_tokens"),
        number("average_repair_latency_ms", " ms"),
    ]
    return "| " + " | ".join(cells) + " |"


def render_structured_summary(summary: SuiteSummary) -> str:
    """Render a complete table directly from a machine-readable summary."""
    header = (
        "| Configuration | Task success | Tool selection | Schema-valid@1 | "
        "Execution-valid@1 | Semantic accuracy | Repair attempt | "
        "Repair success | Repair extra tokens | Repair latency |\n"
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n"
    )
    label = f"{summary.provider} / {summary.model} / {summary.tool_call_mode}"
    return header + render_structured_metrics_row(
        label=label,
        pass_rate=summary.pass_rate,
        metrics=summary.structured_metrics,
    ) + "\n"


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
