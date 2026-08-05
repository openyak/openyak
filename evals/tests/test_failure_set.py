from pathlib import Path

from evals.failure_set import load_failure_set
from evals.task import load_task


REPO_ROOT = Path(__file__).parents[2]


def test_structured_failures_are_versioned_and_reference_regression_tasks() -> None:
    failure_set = load_failure_set(
        REPO_ROOT / "evals" / "failure_sets" / "structured-v0.yaml"
    )
    task_ids = {
        load_task(path).task_id
        for path in (
            REPO_ROOT / "evals" / "suites" / "structured-v0" / "tasks"
        ).glob("*.yaml")
    }

    assert failure_set.version == "structured-v0"
    assert len(failure_set.failures) >= 9
    assert all(failure.regression_task in task_ids for failure in failure_set.failures)
    assert all("/" in failure.label for failure in failure_set.failures)
