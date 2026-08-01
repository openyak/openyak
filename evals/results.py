"""Machine-readable evaluation run artifacts."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def write_run_artifacts(
    run_directory: Path,
    *,
    attempt: Any,
    runtime_commit: str,
    dirty_worktree: bool,
) -> None:
    """Write one-attempt manifest, JSONL record, and generated summary."""
    manifest = {
        "schema_version": 1,
        "suite_version": attempt.suite_version,
        "created_at": datetime.now(UTC).isoformat(),
        "runtime_commit": runtime_commit,
        "dirty_worktree": dirty_worktree,
        "task_ids": [attempt.task_id],
        "provider": attempt.provider,
        "model": attempt.model,
        "configuration": attempt.configuration.model_dump(),
    }
    summary = {
        "schema_version": 1,
        "suite_version": attempt.suite_version,
        "attempts": 1,
        "passed": int(attempt.score.passed),
        "pass_rate": float(attempt.score.passed),
        "average_duration_ms": attempt.duration_ms,
    }
    _write_json(run_directory / "manifest.json", manifest)
    (run_directory / "attempts.jsonl").write_text(
        attempt.model_dump_json() + "\n",
        encoding="utf-8",
    )
    _write_json(run_directory / "summary.json", summary)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
