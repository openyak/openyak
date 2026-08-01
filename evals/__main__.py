"""Command-line entry point for OpenYak evaluations."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.provider.base import BaseProvider
from evals.live import create_realrouter_provider
from evals.runtime import run_task
from evals.suite import run_suite
from evals.task import load_task


def _add_provider_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--provider",
        choices=("scripted", "realrouter"),
        default="scripted",
    )
    parser.add_argument("--model", default="gpt-5.6-luna")


def _provider_from_args(
    args: argparse.Namespace,
    parser: argparse.ArgumentParser,
) -> BaseProvider | None:
    if args.provider == "scripted":
        return None
    try:
        return create_realrouter_provider(args.model)
    except ValueError as error:
        parser.error(str(error))


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m evals")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="run one evaluation task")
    run_parser.add_argument("task", type=Path)
    run_parser.add_argument("--output", type=Path, required=True)
    _add_provider_arguments(run_parser)
    suite_parser = subparsers.add_parser("run-suite", help="run every task in a directory")
    suite_parser.add_argument("tasks", type=Path)
    suite_parser.add_argument("--output", type=Path, required=True)
    _add_provider_arguments(suite_parser)
    args = parser.parse_args()
    provider = _provider_from_args(args, parser)
    execution_mode = "live" if provider is not None else "scripted"

    if args.command == "run":
        task = load_task(args.task)
        if execution_mode not in task.execution_modes:
            parser.error(
                f"Task {task.task_id!r} does not support {execution_mode!r} execution"
            )
        output = args.output.resolve()
        attempt = asyncio.run(run_task(args.task, output, provider=provider))
        print(json.dumps({
            "attempts": 1,
            "output": str(output),
            "passed": int(attempt.score.passed),
            "task_id": attempt.task_id,
        }, sort_keys=True))
        return 0 if attempt.score.passed else 1
    if args.command == "run-suite":
        summary = asyncio.run(run_suite(
            args.tasks,
            args.output,
            provider=provider,
            execution_mode=execution_mode,
        ))
        print(summary.model_dump_json())
        return 0 if summary.passed == summary.attempts else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
