"""Offline adapter that runs evaluation tasks through the production agent loop."""

from __future__ import annotations

import asyncio
import subprocess
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.agent import AgentRegistry
from app.main import _register_builtin_tools
from app.models.base import Base
from app.provider.base import BaseProvider
from app.provider.registry import ProviderRegistry
from app.schemas.agent import AgentInfo, PermissionRule, Ruleset
from app.schemas.chat import PromptRequest
from app.schemas.provider import ModelCapabilities, ModelInfo, ProviderStatus, StreamChunk
from app.session.processor import run_generation
from app.streaming.manager import GenerationJob
from app.tool.registry import ToolRegistry
from app.utils.id import generate_ulid
from evals.scoring import AssertionResult, EvaluationScore, score_workspace
from evals.results import write_run_artifacts
from evals.task import EvaluationTask, load_task
from evals.workspace import prepare_workspace


class RuntimeEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: str
    data: dict[str, Any]


class EvaluationConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed_tools: list[str]
    permissions: dict[str, str]
    budget: dict[str, int | float]
    temperature: float
    model_revision: str | None = None


class EvaluationAttempt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    suite_version: str
    task_id: str
    attempt: int = 0
    runtime_commit: str
    dirty_worktree: bool
    provider: str
    model: str
    configuration: EvaluationConfiguration
    duration_ms: float
    tool_calls: int
    tool_executions: int
    retry_count: int
    token_usage: dict[str, int]
    cost_usd: float
    failure_labels: list[str]
    infrastructure_error: str | None = None
    workspace_changes: dict[str, str]
    score: EvaluationScore
    events: list[RuntimeEvent]


@dataclass(frozen=True)
class ScriptedFailure:
    message: str
    retry_after_ms: int | None = None


class _ScriptedProviderError(RuntimeError):
    def __init__(self, failure: ScriptedFailure) -> None:
        super().__init__(failure.message)
        headers = {}
        if failure.retry_after_ms is not None:
            headers["retry-after-ms"] = str(failure.retry_after_ms)
        self.response = type("ScriptedResponse", (), {"headers": headers})()


class ScriptedProvider(BaseProvider):
    """Deterministic provider boundary for offline agent-loop evaluations."""

    def __init__(
        self,
        *,
        steps: list[list[StreamChunk] | ScriptedFailure],
        model_id: str = "eval-scripted-model",
    ) -> None:
        self.steps = steps
        self.model_id = model_id
        self._next_step = 0

    @property
    def id(self) -> str:
        return "eval-scripted"

    async def list_models(self) -> list[ModelInfo]:
        return [ModelInfo(
            id=self.model_id,
            name="OpenYak scripted evaluation model",
            provider_id=self.id,
            capabilities=ModelCapabilities(
                function_calling=True,
                max_context=32_000,
                max_output=1_024,
            ),
        )]

    async def stream_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system: str | list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        del model, messages, tools, system, temperature, max_tokens, extra_body, response_format
        if self._next_step >= len(self.steps):
            yield StreamChunk(
                type="error",
                data={"message": "Scripted provider ran out of evaluation steps"},
            )
            return
        step = self.steps[self._next_step]
        self._next_step += 1
        if isinstance(step, ScriptedFailure):
            raise _ScriptedProviderError(step)
        for chunk in step:
            yield chunk

    async def health_check(self) -> ProviderStatus:
        return ProviderStatus(status="connected", model_count=1)


async def run_task(
    task_path: str | Path,
    run_directory: str | Path,
    *,
    provider: BaseProvider | None = None,
) -> EvaluationAttempt:
    """Run one task through OpenYak and score its observable workspace outcome."""
    task_file = Path(task_path).resolve()
    task = load_task(task_file)
    if provider is None:
        if task.scripted_provider is None:
            raise ValueError(
                f"Task {task.task_id!r} has no scripted provider; inject a provider explicitly"
            )
        provider = ScriptedProvider(
            model_id=task.scripted_provider.model_id,
            steps=[_scripted_step(step) for step in task.scripted_provider.steps],
        )
    run_dir = Path(run_directory).resolve()
    run_dir.mkdir(parents=True, exist_ok=False)
    fixture = (task_file.parent / task.workspace_fixture).resolve()
    workspace = prepare_workspace(fixture, run_dir / "workspace")

    database_path = run_dir / "evaluation.db"
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{database_path}",
        echo=False,
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    provider_registry = ProviderRegistry()
    provider_registry.register(provider)
    await provider_registry.refresh_models()
    models = provider_registry.all_models()
    if not models:
        await engine.dispose()
        raise RuntimeError(f"Evaluation provider {provider.id!r} exposed no models")
    model = models[0]

    agent_registry = _evaluation_agent_registry(task)
    tool_registry = ToolRegistry()
    _register_builtin_tools(tool_registry)

    session_id = generate_ulid()
    job = GenerationJob(stream_id=generate_ulid(), session_id=session_id)
    request = PromptRequest(
        session_id=session_id,
        text=task.prompt,
        model=model.id,
        provider_id=provider.id,
        agent="evaluation",
        workspace=str(workspace.path),
        permission_presets={
            "file_changes": task.permissions.file_changes == "allow",
            "run_commands": task.permissions.run_commands == "allow",
        },
        permission_rules=_deny_permission_rules(task),
    )

    started = time.perf_counter()
    infrastructure_error: str | None = None
    try:
        await asyncio.wait_for(
            run_generation(
                job,
                request,
                session_factory=session_factory,
                provider_registry=provider_registry,
                agent_registry=agent_registry,
                tool_registry=tool_registry,
            ),
            timeout=task.budget.timeout_seconds,
        )
    except TimeoutError:
        infrastructure_error = "timeout"
    except Exception:
        infrastructure_error = "runtime"
    finally:
        duration_ms = (time.perf_counter() - started) * 1000
        await engine.dispose()
        _remove_evaluation_database(database_path)

    events = [
        RuntimeEvent(event=event.event, data=_safe_event_data(event.event, event.data))
        for event in job.events
    ]
    tool_call_ids = {
        event.data["call_id"]
        for event in events
        if event.event in {"tool-call", "tool-error"} and "call_id" in event.data
    }
    tool_calls = len(tool_call_ids)
    tool_executions = sum(event.event == "tool-call" for event in events)
    retry_count = sum(event.event == "retry" for event in events)
    token_usage = _aggregate_token_usage(events)
    cost_usd = max(
        (
            float(event.data.get("total_cost", 0.0))
            for event in events
            if event.event in {"step-finish", "done"}
        ),
        default=0.0,
    )
    score = _apply_runtime_budget(
        score_workspace(task.scorer, workspace),
        tool_calls=tool_calls,
        tool_executions=tool_executions,
        max_tool_calls=task.budget.max_tool_calls,
    )
    score = _apply_tool_telemetry(score, events=events)
    score = _apply_event_expectations(score, task=task, events=events)
    score = _apply_infrastructure_failure(
        score,
        infrastructure_error=infrastructure_error,
    )
    runtime_commit, dirty_worktree = _git_state()
    attempt = EvaluationAttempt(
        suite_version=task.suite_version,
        task_id=task.task_id,
        runtime_commit=runtime_commit,
        dirty_worktree=dirty_worktree,
        provider=provider.id,
        model=model.id,
        configuration=EvaluationConfiguration(
            allowed_tools=task.allowed_tools,
            permissions=task.permissions.model_dump(),
            budget=task.budget.model_dump(),
            temperature=0.0,
        ),
        duration_ms=duration_ms,
        tool_calls=tool_calls,
        tool_executions=tool_executions,
        retry_count=retry_count,
        token_usage=token_usage,
        cost_usd=cost_usd,
        failure_labels=_failure_labels(
            score,
            infrastructure_error=infrastructure_error,
        ),
        infrastructure_error=infrastructure_error,
        workspace_changes=workspace.diff().changes,
        score=score,
        events=events,
    )
    write_run_artifacts(
        run_dir,
        attempt=attempt,
        runtime_commit=runtime_commit,
        dirty_worktree=dirty_worktree,
    )
    return attempt


def _failure_labels(
    score: EvaluationScore,
    *,
    infrastructure_error: str | None,
) -> list[str]:
    if score.passed:
        return []
    if infrastructure_error is not None:
        return [f"infrastructure/{infrastructure_error}"]
    failed_types = {
        assertion.type for assertion in score.assertions if not assertion.passed
    }
    labels: list[str] = []
    if failed_types & {
        "file_exists",
        "file_absent",
        "text_equals",
        "no_unexpected_changes",
    }:
        labels.append("outcome/workspace")
    if "tool_call_budget" in failed_types:
        labels.append("budget/tool-calls")
    if "event_occurs" in failed_types:
        labels.append("outcome/expected-event")
    return labels or ["outcome/unknown"]


def _apply_infrastructure_failure(
    score: EvaluationScore,
    *,
    infrastructure_error: str | None,
) -> EvaluationScore:
    if infrastructure_error is None:
        return score
    return EvaluationScore(
        passed=False,
        metrics={
            **score.metrics,
            "assertions_total": int(score.metrics["assertions_total"]) + 1,
        },
        assertions=[
            *score.assertions,
            AssertionResult(
                type="infrastructure",
                passed=False,
                message="Evaluation infrastructure did not complete the task",
                details={"category": infrastructure_error},
            ),
        ],
    )


def _evaluation_agent_registry(task: EvaluationTask) -> AgentRegistry:
    registry = AgentRegistry()
    rules = [PermissionRule(action="deny", permission="*")]
    rules.extend(
        PermissionRule(action="allow", permission=tool)
        for tool in task.allowed_tools
    )
    registry.register(AgentInfo(
        name="evaluation",
        description="Restricted agent for deterministic runtime evaluation",
        mode="primary",
        tools=task.allowed_tools,
        permissions=Ruleset(rules=rules),
        system_prompt=(
            "Complete the evaluation task using only the advertised tools. "
            "Do not make unrelated workspace changes."
        ),
        temperature=0,
    ))
    return registry


def _git_state() -> tuple[str, bool]:
    repo_root = Path(__file__).resolve().parents[1]
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        return commit, bool(status.strip())
    except (OSError, subprocess.CalledProcessError):
        return "unknown", True


def _scripted_step(step: Any) -> list[StreamChunk] | ScriptedFailure:
    if step.raise_error is not None:
        return ScriptedFailure(
            message=step.raise_error,
            retry_after_ms=step.retry_after_ms,
        )
    return [StreamChunk(type=chunk.type, data=chunk.data) for chunk in step.chunks]


def _safe_event_data(event: str, data: dict[str, Any]) -> dict[str, Any]:
    """Keep evaluation telemetry while excluding prompts and tool payload values."""
    keys_by_event: dict[str, tuple[str, ...]] = {
        "step-start": ("step",),
        "step-finish": ("tokens", "cost", "total_cost", "reason"),
        "tool-call": (
            "tool",
            "call_id",
            "repair_applied",
            "schema_valid_before_repair",
            "schema_valid_after_repair",
        ),
        "tool-result": ("tool", "call_id"),
        "tool-error": (
            "tool",
            "call_id",
            "error_category",
            "exit_code",
            "cwd_scope",
            "repair_applied",
            "schema_valid_before_repair",
            "schema_valid_after_repair",
        ),
        "permission-request": ("tool", "call_id"),
        "retry": ("attempt", "max_retries", "delay", "reason"),
        "agent-error": ("error_type",),
        "done": ("finish_reason", "total_cost"),
    }
    allowed = keys_by_event.get(event, ())
    safe = {key: data[key] for key in allowed if key in data}
    if event == "tool-result":
        metadata = data.get("metadata")
        written_files = (
            metadata.get("written_files") if isinstance(metadata, dict) else None
        )
        if isinstance(written_files, list):
            safe["written_file_count"] = len(written_files)
        cwd_scope = metadata.get("cwd_scope") if isinstance(metadata, dict) else None
        if cwd_scope in {
            "default_output",
            "workspace_root",
            "workspace_subdir",
            "external",
        }:
            safe["cwd_scope"] = cwd_scope
    return safe


def _remove_evaluation_database(path: Path) -> None:
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        candidate.unlink(missing_ok=True)


def _aggregate_token_usage(events: list[RuntimeEvent]) -> dict[str, int]:
    totals: dict[str, int] = {}
    for event in events:
        if event.event != "step-finish":
            continue
        tokens = event.data.get("tokens")
        if not isinstance(tokens, dict):
            continue
        for key, value in tokens.items():
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return totals


def _apply_runtime_budget(
    score: EvaluationScore,
    *,
    tool_calls: int,
    tool_executions: int,
    max_tool_calls: int,
) -> EvaluationScore:
    within_budget = tool_calls <= max_tool_calls
    metrics = {
        **score.metrics,
        "assertions_total": int(score.metrics.get("assertions_total", 0)) + 1,
        "assertions_passed": (
            int(score.metrics.get("assertions_passed", 0)) + int(within_budget)
        ),
        "tool_calls": tool_calls,
        "tool_executions": tool_executions,
        "within_tool_call_budget": int(within_budget),
    }
    assertions = [
        *score.assertions,
        AssertionResult(
            type="tool_call_budget",
            passed=within_budget,
            message=(
                None
                if within_budget
                else f"Used {tool_calls} tool calls; maximum is {max_tool_calls}"
            ),
            details={"actual": tool_calls, "maximum": max_tool_calls},
        ),
    ]
    return EvaluationScore(
        passed=score.passed and within_budget,
        metrics=metrics,
        assertions=assertions,
    )


def _deny_permission_rules(task: EvaluationTask) -> list[dict[str, str]]:
    rules: list[dict[str, str]] = []
    if task.permissions.file_changes == "deny":
        for permission in ("write", "edit", "apply_patch", "artifact"):
            rules.append({"action": "deny", "permission": permission, "pattern": "*"})
    if task.permissions.run_commands == "deny":
        for permission in ("bash", "code_execute"):
            rules.append({"action": "deny", "permission": permission, "pattern": "*"})
    return rules


def _apply_tool_telemetry(
    score: EvaluationScore,
    *,
    events: list[RuntimeEvent],
) -> EvaluationScore:
    observed_calls: dict[str, RuntimeEvent] = {}
    for event in events:
        if event.event not in {"tool-call", "tool-error"}:
            continue
        call_id = event.data.get("call_id")
        if not isinstance(call_id, str):
            continue
        if "schema_valid_before_repair" not in event.data:
            continue
        observed_calls.setdefault(call_id, event)
    tool_calls = list(observed_calls.values())
    first_call = tool_calls[0] if tool_calls else None
    tool_error_ids = {
        event.data["call_id"]
        for event in events
        if event.event == "tool-error" and "call_id" in event.data
    }
    tool_result_ids = {
        event.data["call_id"]
        for event in events
        if event.event == "tool-result" and "call_id" in event.data
    }
    first_call_id = first_call.data.get("call_id") if first_call is not None else None
    seen_tool_error = False
    recovered_after_tool_error = False
    for event in events:
        if event.event == "tool-error":
            seen_tool_error = True
        elif event.event == "tool-result" and seen_tool_error:
            recovered_after_tool_error = True
    metrics = {
        **score.metrics,
        "repairs_applied": sum(
            event.data.get("repair_applied") is True for event in tool_calls
        ),
        "schema_valid_before_repair": sum(
            event.data.get("schema_valid_before_repair") is True
            for event in tool_calls
        ),
        "schema_valid_after_repair": sum(
            event.data.get("schema_valid_after_repair") is True
            for event in tool_calls
        ),
        "schema_valid_at_1": int(
            first_call is not None
            and first_call.data.get("schema_valid_before_repair") is True
        ),
        "tool_errors": len(tool_error_ids),
        "tool_results": len(tool_result_ids),
        "written_files": sum(
            count
            for event in events
            if event.event == "tool-result"
            for count in [event.data.get("written_file_count", 0)]
            if isinstance(count, int) and not isinstance(count, bool)
        ),
        "execution_success_at_1": int(
            first_call_id is not None and first_call_id in tool_result_ids
        ),
        "recovered_after_tool_error": int(recovered_after_tool_error),
    }
    return EvaluationScore(
        passed=score.passed,
        metrics=metrics,
        assertions=score.assertions,
    )


def _apply_event_expectations(
    score: EvaluationScore,
    *,
    task: EvaluationTask,
    events: list[RuntimeEvent],
) -> EvaluationScore:
    if not task.expected_events:
        return score
    assertions = list(score.assertions)
    passed_count = 0
    for expectation in task.expected_events:
        passed = any(
            event.event == expectation.event
            and all(event.data.get(key) == value for key, value in expectation.data_contains.items())
            for event in events
        )
        passed_count += int(passed)
        assertions.append(AssertionResult(
            type="event_occurs",
            passed=passed,
            message=None if passed else f"Expected event {expectation.event!r} was not observed",
            details={
                "event": expectation.event,
                "data_contains": expectation.data_contains,
            },
        ))
    metrics = {
        **score.metrics,
        "assertions_total": int(score.metrics["assertions_total"]) + len(task.expected_events),
        "assertions_passed": int(score.metrics["assertions_passed"]) + passed_count,
        "expected_events_passed": passed_count,
    }
    return EvaluationScore(
        passed=score.passed and passed_count == len(task.expected_events),
        metrics=metrics,
        assertions=assertions,
    )
