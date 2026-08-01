from pathlib import Path

import pytest

from evals.live import create_realrouter_provider
from evals.suite import discover_task_files


TASKS_DIR = (
    Path(__file__).parents[1]
    / "suites"
    / "runtime-v0"
    / "tasks"
)


def test_realrouter_provider_requires_a_key_in_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("REALROUTER_API_KEY", raising=False)

    with pytest.raises(ValueError, match="REALROUTER_API_KEY"):
        create_realrouter_provider("gpt-5.6-luna")


@pytest.mark.asyncio
async def test_realrouter_provider_declares_only_the_requested_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REALROUTER_API_KEY", "test-key-never-sent")

    provider = create_realrouter_provider("gpt-5.6-luna")
    models = await provider.list_models()

    assert provider.id == "realrouter"
    assert [model.id for model in models] == ["gpt-5.6-luna"]


def test_live_suite_selects_only_real_model_tasks() -> None:
    task_files = discover_task_files(TASKS_DIR, execution_mode="live")

    assert [task.stem for task in task_files] == [
        "apply-patch-add-exact-001",
        "apply-patch-delete-exact-001",
        "apply-patch-update-exact-001",
        "bash-create-exact-001",
        "code-execute-create-exact-001",
        "edit-batch-atomic-001",
        "file-create-exact-001",
        "file-edit-preserve-001",
        "file-rename-preserve-001",
        "permission-deny-bash-001",
        "permission-deny-code-execute-001",
        "permission-deny-write-001",
    ]
