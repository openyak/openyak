import asyncio
from pathlib import Path
import json

import pytest

from app.schemas.provider import StreamChunk
from evals.runtime import ScriptedProvider, run_task


TASK = (
    Path(__file__).parents[1]
    / "suites"
    / "runtime-v0"
    / "tasks"
    / "file-create-exact-001.yaml"
)
TASKS_DIR = TASK.parent


def _create_file_provider() -> ScriptedProvider:
    return ScriptedProvider(steps=[
        [
            StreamChunk(
                type="tool-call",
                data={
                    "id": "write-result",
                    "name": "write",
                    "arguments": {
                        "file_path": "result.txt",
                        "content": "OpenYak evaluation passed.\n",
                    },
                },
            ),
            StreamChunk(type="finish", data={"reason": "tool_use"}),
        ],
        [
            StreamChunk(
                type="text-delta",
                data={"text": "Created the requested file."},
            ),
            StreamChunk(type="finish", data={"reason": "stop"}),
        ],
    ])


@pytest.mark.asyncio
async def test_scripted_provider_creates_an_exact_scored_file(tmp_path: Path) -> None:
    provider = _create_file_provider()

    attempt = await run_task(TASK, tmp_path / "run", provider=provider)

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {
        "openyak_written/result.txt": "created",
    }
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 1
    assert attempt.token_usage == {}
    assert attempt.cost_usd == 0.0
    assert attempt.score.metrics["within_tool_call_budget"] == 1
    assert attempt.score.metrics["assertions_total"] == 4
    assert attempt.score.metrics["assertions_passed"] == 4
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "result.txt"
    ).read_text(encoding="utf-8") == "OpenYak evaluation passed.\n"


@pytest.mark.asyncio
async def test_run_task_writes_reproducible_secret_free_result_files(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"

    await run_task(TASK, run_dir, provider=_create_file_provider())

    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    attempts_text = (run_dir / "attempts.jsonl").read_text(encoding="utf-8")
    attempt = json.loads(attempts_text)
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["suite_version"] == "runtime-v0"
    assert manifest["runtime_commit"]
    assert isinstance(manifest["dirty_worktree"], bool)
    expected_configuration = {
        "allowed_tools": ["write"],
        "budget": {"max_tool_calls": 3, "timeout_seconds": 30.0},
        "model_revision": None,
        "permissions": {"file_changes": "allow", "run_commands": "deny"},
        "temperature": 0.0,
    }
    assert manifest["configuration"] == expected_configuration
    assert attempt["configuration"] == expected_configuration
    assert attempt["score"]["passed"] is True
    assert "OpenYak evaluation passed." not in attempts_text
    assert summary["attempts"] == 1
    assert summary["passed"] == 1
    assert summary["pass_rate"] == 1.0
    assert not (run_dir / "evaluation.db").exists()


@pytest.mark.asyncio
async def test_committed_task_runs_offline_without_provider_injection(
    tmp_path: Path,
) -> None:
    attempt = await run_task(TASK, tmp_path / "run")

    assert attempt.provider == "eval-scripted"
    assert attempt.score.passed is True


@pytest.mark.asyncio
async def test_failed_workspace_outcome_has_a_stable_failure_label(
    tmp_path: Path,
) -> None:
    provider = ScriptedProvider(steps=[[
        StreamChunk(type="finish", data={"reason": "stop"}),
    ]])

    attempt = await run_task(TASK, tmp_path / "run", provider=provider)

    assert attempt.score.passed is False
    assert attempt.failure_labels == ["outcome/workspace"]


@pytest.mark.asyncio
async def test_harness_timeout_is_recorded_as_an_infrastructure_failure(
    tmp_path: Path,
) -> None:
    class SlowProvider(ScriptedProvider):
        async def stream_chat(self, *args, **kwargs):
            del args, kwargs
            await asyncio.sleep(1)
            if False:
                yield StreamChunk(type="finish", data={"reason": "stop"})

    fixture = tmp_path / "fixture"
    fixture.mkdir()
    task_path = tmp_path / "timeout-task.yaml"
    task_path.write_text(
        TASK.read_text(encoding="utf-8")
        .replace("workspace_fixture: ../fixtures/empty", "workspace_fixture: fixture")
        .replace("timeout_seconds: 30", "timeout_seconds: 0.01"),
        encoding="utf-8",
    )

    attempt = await run_task(
        task_path,
        tmp_path / "run",
        provider=SlowProvider(steps=[]),
    )

    assert attempt.score.passed is False
    assert attempt.infrastructure_error == "timeout"
    assert attempt.failure_labels == ["infrastructure/timeout"]
    assert (tmp_path / "run" / "attempts.jsonl").is_file()


@pytest.mark.asyncio
async def test_edit_preserve_changes_only_the_requested_field(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "file-edit-preserve-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {
        "openyak_written/config.txt": "modified",
    }
    assert attempt.score.metrics["schema_valid_at_1"] == 1
    assert attempt.score.metrics["repairs_applied"] == 0
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "config.txt"
    ).read_text(encoding="utf-8") == "status=active\nowner=alice\n"


@pytest.mark.asyncio
async def test_batch_edit_applies_every_change_atomically(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "edit-batch-atomic-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.workspace_changes == {
        "openyak_written/config.txt": "modified",
    }
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "config.txt"
    ).read_text(encoding="utf-8") == "status=active\nowner=bob\n"


@pytest.mark.asyncio
async def test_batch_edit_rolls_back_when_any_change_is_invalid(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "edit-batch-rollback-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {}
    assert any(
        event.event == "tool-error" and event.data.get("tool") == "edit"
        for event in attempt.events
    )
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "config.txt"
    ).read_text(encoding="utf-8") == "status=inactive\nowner=alice\n"


@pytest.mark.asyncio
async def test_persisted_tool_errors_exclude_raw_messages_and_paths(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"

    attempt = await run_task(
        TASKS_DIR / "edit-batch-rollback-001.yaml",
        run_dir,
    )

    tool_error = next(event for event in attempt.events if event.event == "tool-error")
    attempts_text = (run_dir / "attempts.jsonl").read_text(encoding="utf-8")
    assert "error" not in tool_error.data
    assert str(tmp_path) not in attempts_text


@pytest.mark.asyncio
async def test_conflicting_edit_modes_can_recover_after_execution_feedback(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "edit-self-correct-conflicting-modes-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 2
    assert attempt.score.metrics["schema_valid_at_1"] == 0
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert attempt.score.metrics["tool_errors"] == 1
    assert attempt.score.metrics["recovered_after_tool_error"] == 1
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "config.txt"
    ).read_text(encoding="utf-8") == "status=active\nowner=alice\n"


@pytest.mark.asyncio
async def test_rename_preserve_moves_the_same_content(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "file-rename-preserve-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {
        "openyak_written/draft.md": "deleted",
        "openyak_written/final.md": "created",
    }
    workspace = tmp_path / "run" / "workspace" / "openyak_written"
    assert not (workspace / "draft.md").exists()
    assert (workspace / "final.md").read_text(encoding="utf-8") == "# Stable report\n"


@pytest.mark.asyncio
async def test_apply_patch_adds_an_exact_file(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "apply-patch-add-exact-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.workspace_changes == {
        "openyak_written/added.txt": "created",
    }
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "added.txt"
    ).read_text(encoding="utf-8") == "added by patch\n"


@pytest.mark.asyncio
async def test_apply_patch_updates_only_the_expected_content(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "apply-patch-update-exact-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {
        "openyak_written/config.txt": "modified",
    }
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "config.txt"
    ).read_text(encoding="utf-8") == "status=active\nowner=alice\n"


@pytest.mark.asyncio
async def test_apply_patch_deletes_only_the_requested_file(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "apply-patch-delete-exact-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {
        "openyak_written/draft.md": "deleted",
    }
    assert not (
        tmp_path / "run" / "workspace" / "openyak_written" / "draft.md"
    ).exists()


@pytest.mark.asyncio
async def test_malformed_patch_can_recover_after_parser_feedback(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "apply-patch-self-correct-malformed-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 2
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert attempt.score.metrics["tool_errors"] == 1
    assert attempt.score.metrics["recovered_after_tool_error"] == 1
    assert attempt.workspace_changes == {
        "openyak_written/draft.md": "deleted",
        "openyak_written/final.md": "created",
    }


@pytest.mark.asyncio
async def test_permission_deny_blocks_the_write_without_side_effects(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "permission-deny-write-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.workspace_changes == {}
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 0
    assert attempt.score.metrics["schema_valid_at_1"] == 1
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert any(
        event.event == "tool-error" and event.data.get("tool") == "write"
        for event in attempt.events
    )
    assert not (
        tmp_path / "run" / "workspace" / "openyak_written" / "forbidden.txt"
    ).exists()


@pytest.mark.asyncio
async def test_malformed_tool_payload_is_repaired_before_execution(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "tool-malformed-repair-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert any(
        event.event == "tool-call" and event.data.get("tool") == "write"
        for event in attempt.events
    )
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "repaired.txt"
    ).read_text(encoding="utf-8") == "repaired\n"


@pytest.mark.asyncio
async def test_repair_telemetry_is_recorded_without_tool_arguments(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "tool-malformed-repair-001.yaml",
        tmp_path / "run",
    )

    tool_call = next(event for event in attempt.events if event.event == "tool-call")
    assert tool_call.data["repair_applied"] is True
    assert tool_call.data["schema_valid_before_repair"] is False
    assert tool_call.data["schema_valid_after_repair"] is True
    assert "arguments" not in tool_call.data
    assert attempt.score.metrics["schema_valid_at_1"] == 0
    assert attempt.score.metrics["repairs_applied"] == 1
    assert attempt.score.metrics["schema_valid_after_repair"] == 1


@pytest.mark.asyncio
async def test_transient_provider_failure_retries_once_then_recovers(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "provider-retry-once-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.retry_count == 1
    assert any(
        event.event == "retry" and event.data.get("reason") == "Server error (503)"
        for event in attempt.events
    )
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "recovered.txt"
    ).read_text(encoding="utf-8") == "recovered\n"


@pytest.mark.asyncio
async def test_bash_creates_an_exact_scored_file_in_the_workspace(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "bash-create-exact-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 1
    assert attempt.workspace_changes == {
        "openyak_written/bash.txt": "created",
    }
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "bash.txt"
    ).read_text(encoding="utf-8") == "created by bash\n"
    tool_result = next(
        event for event in attempt.events if event.event == "tool-result"
    )
    assert tool_result.data["cwd_scope"] == "default_output"
    assert "cwd" not in tool_result.data


@pytest.mark.asyncio
async def test_bash_recovers_after_a_nonzero_exit(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "bash-self-correct-nonzero-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 2
    assert attempt.tool_executions == 2
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert attempt.score.metrics["tool_errors"] == 1
    assert attempt.score.metrics["recovered_after_tool_error"] == 1
    assert attempt.workspace_changes == {
        "openyak_written/recovered.txt": "created",
    }
    tool_error = next(event for event in attempt.events if event.event == "tool-error")
    assert tool_error.data["exit_code"] == 7
    assert tool_error.data["error_category"] == "nonzero_exit"
    assert tool_error.data["cwd_scope"] == "default_output"
    assert "command" not in tool_error.data
    assert "output" not in tool_error.data
    assert "metadata" not in tool_error.data


@pytest.mark.asyncio
async def test_bash_timeout_is_observable_and_has_no_side_effects(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "bash-timeout-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 1
    assert attempt.workspace_changes == {}
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert attempt.score.metrics["tool_errors"] == 1
    assert any(
        event.event == "tool-error"
        and event.data.get("tool") == "bash"
        and event.data.get("error_category") == "timeout"
        and event.data.get("cwd_scope") == "default_output"
        for event in attempt.events
    )


@pytest.mark.asyncio
async def test_permission_deny_blocks_bash_before_execution(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "permission-deny-bash-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 0
    assert attempt.workspace_changes == {}
    assert attempt.score.metrics["schema_valid_at_1"] == 1
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert any(
        event.event == "tool-error" and event.data.get("tool") == "bash"
        for event in attempt.events
    )


@pytest.mark.asyncio
async def test_code_execute_creates_an_exact_scored_artifact(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "code-execute-create-exact-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 1
    assert attempt.workspace_changes == {
        "openyak_written/code-output.txt": "created",
    }
    assert (
        tmp_path / "run" / "workspace" / "openyak_written" / "code-output.txt"
    ).read_text(encoding="utf-8") == "created by code\n"
    tool_result = next(
        event for event in attempt.events if event.event == "tool-result"
    )
    assert tool_result.data["written_file_count"] == 1
    assert attempt.score.metrics["written_files"] == 1
    assert "metadata" not in tool_result.data
    assert "output" not in tool_result.data
    assert "title" not in tool_result.data


@pytest.mark.asyncio
async def test_code_execute_recovers_after_python_failure(tmp_path: Path) -> None:
    attempt = await run_task(
        TASKS_DIR / "code-execute-self-correct-error-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 2
    assert attempt.tool_executions == 2
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert attempt.score.metrics["tool_errors"] == 1
    assert attempt.score.metrics["recovered_after_tool_error"] == 1
    assert attempt.workspace_changes == {
        "openyak_written/code-recovered.txt": "created",
    }


@pytest.mark.asyncio
async def test_permission_deny_blocks_code_execute_before_execution(
    tmp_path: Path,
) -> None:
    attempt = await run_task(
        TASKS_DIR / "permission-deny-code-execute-001.yaml",
        tmp_path / "run",
    )

    assert attempt.score.passed is True
    assert attempt.tool_calls == 1
    assert attempt.tool_executions == 0
    assert attempt.workspace_changes == {}
    assert attempt.score.metrics["execution_success_at_1"] == 0
    assert any(
        event.event == "tool-error" and event.data.get("tool") == "code_execute"
        for event in attempt.events
    )
