import json
import os
from pathlib import Path
import subprocess
import sys


REPO_ROOT = Path(__file__).parents[2]
TASK = (
    REPO_ROOT
    / "evals"
    / "suites"
    / "runtime-v0"
    / "tasks"
    / "file-create-exact-001.yaml"
)


def test_cli_runs_the_offline_task_and_prints_a_machine_readable_summary(
    tmp_path: Path,
) -> None:
    output = tmp_path / "run"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([
        str(REPO_ROOT / "backend"),
        str(REPO_ROOT),
    ])

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "evals",
            "run",
            str(TASK),
            "--output",
            str(output),
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {
        "attempts": 1,
        "output": str(output),
        "passed": 1,
        "task_id": "file/create-exact-001",
    }
    assert (output / "attempts.jsonl").is_file()


def test_cli_runs_the_complete_offline_suite(tmp_path: Path) -> None:
    output = tmp_path / "suite"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([
        str(REPO_ROOT / "backend"),
        str(REPO_ROOT),
    ])

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "evals",
            "run-suite",
            str(TASK.parent),
            "--output",
            str(output),
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    summary = json.loads(completed.stdout)
    assert summary["attempts"] == 20
    assert summary["passed"] == 20
    assert summary["pass_rate"] == 1.0
    tasks = {task["task_id"]: task for task in summary["tasks"]}
    assert tasks["permission/deny-write-001"]["tool_calls"] == 1
    assert tasks["permission/deny-write-001"]["tool_executions"] == 0
    assert tasks["permission/deny-write-001"]["workspace_changes"] == {}
    assert tasks["provider/retry-once-001"]["retry_count"] == 1
    assert tasks["bash/self-correct-nonzero-001"]["tool_calls"] == 2
    assert tasks["code_execute/create-exact-001"]["workspace_changes"] == {
        "openyak_written/code-output.txt": "created",
    }
    assert tasks["file/rename-preserve-001"]["workspace_changes"] == {
        "openyak_written/draft.md": "deleted",
        "openyak_written/final.md": "created",
    }
    assert (output / "suite-summary.json").is_file()


def test_live_cli_fails_before_network_access_when_key_is_missing(
    tmp_path: Path,
) -> None:
    output = tmp_path / "live-suite"
    env = os.environ.copy()
    env.pop("REALROUTER_API_KEY", None)
    env["PYTHONPATH"] = os.pathsep.join([
        str(REPO_ROOT / "backend"),
        str(REPO_ROOT),
    ])

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "evals",
            "run-suite",
            str(TASK.parent),
            "--output",
            str(output),
            "--provider",
            "realrouter",
            "--model",
            "gpt-5.6-luna",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "REALROUTER_API_KEY" in completed.stderr
    assert not output.exists()
