from pathlib import Path

from evals import load_task


REPO_ROOT = Path(__file__).parents[2]


def test_load_task_returns_a_versioned_evaluation_task(tmp_path: Path) -> None:
    task_file = tmp_path / "task.yaml"
    task_file.write_text(
        """
schema_version: 1
suite_version: runtime-v0
task_id: file/create-exact-001
description: Create a file with exact content
prompt: Create result.txt containing exactly OpenYak evaluation passed.
workspace_fixture: fixtures/empty
allowed_tools: [write, apply_patch]
permissions:
  file_changes: allow
  run_commands: deny
budget:
  max_tool_calls: 3
  timeout_seconds: 30
scorer:
  type: workspace
  assertions:
    - type: file_exists
      path: openyak_written/result.txt
    - type: text_equals
      path: openyak_written/result.txt
      value: "OpenYak evaluation passed.\n"
    - type: no_unexpected_changes
      allowed: [openyak_written/result.txt]
""".lstrip(),
        encoding="utf-8",
    )

    task = load_task(task_file)

    assert task.schema_version == 1
    assert task.suite_version == "runtime-v0"
    assert task.task_id == "file/create-exact-001"
    assert task.execution_modes == ["scripted"]
    assert task.scorer.assertions[1].type == "text_equals"


def test_structured_v0_covers_the_declared_generation_failure_taxonomy() -> None:
    tasks_directory = REPO_ROOT / "evals" / "suites" / "structured-v0" / "tasks"
    tasks = [load_task(path) for path in sorted(tasks_directory.glob("*.yaml"))]

    assert tasks
    assert all(task.suite_version == "structured-v0" for task in tasks)
    assert all(task.structured_generation is not None for task in tasks)
    coverage = {
        case
        for task in tasks
        for case in task.structured_generation.coverage  # type: ignore[union-attr]
    }
    assert coverage >= {
        "valid",
        "required",
        "type",
        "enum",
        "nested",
        "unknown_tool",
        "wrong_tool",
        "malformed_list_wrapper",
        "malformed_function_wrapper",
        "malformed_parameters_wrapper",
    }
