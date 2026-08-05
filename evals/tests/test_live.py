from pathlib import Path

import pytest

from app.schemas.provider import StreamChunk
from evals.live import (
    PromptToolCallingProvider,
    create_ollama_provider,
    create_realrouter_provider,
)
from evals.runtime import ScriptedProvider, run_task
from evals.suite import discover_task_files


TASKS_DIR = (
    Path(__file__).parents[1]
    / "suites"
    / "runtime-v0"
    / "tasks"
)
STRUCTURED_TASKS_DIR = (
    Path(__file__).parents[1]
    / "suites"
    / "structured-v0"
    / "tasks"
)


def test_realrouter_provider_requires_a_key_in_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("REALROUTER_API_KEY", raising=False)

    with pytest.raises(ValueError, match="REALROUTER_API_KEY"):
        create_realrouter_provider("gpt-5.6-luna")


def test_ollama_provider_targets_one_local_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")

    provider = create_ollama_provider("qwen3:8b")

    assert provider.id == "ollama"
    assert provider.requested_model == "ollama/qwen3:8b"


@pytest.mark.asyncio
async def test_prompt_wrapper_emits_canonical_tool_call_chunks() -> None:
    delegate = ScriptedProvider(steps=[[
        StreamChunk(
            type="text-delta",
            data={
                "text": (
                    '<tool_call>{"name":"write","arguments":'
                    '{"file_path":"result.txt","content":"ok\\n"}}'
                    "</tool_call>"
                )
            },
        ),
        StreamChunk(type="finish", data={"reason": "stop"}),
    ]])
    provider = PromptToolCallingProvider(delegate)

    chunks = [
        chunk
        async for chunk in provider.stream_chat(
            "eval-scripted-model",
            [{"role": "user", "content": "Create the file"}],
            tools=[{
                "type": "function",
                "function": {
                    "name": "write",
                    "description": "Write a file",
                    "parameters": {"type": "object"},
                },
            }],
            system="You are helpful.",
        )
    ]

    assert [chunk.type for chunk in chunks] == ["tool-call", "finish"]
    assert chunks[0].data == {
        "id": "call_0",
        "name": "write",
        "arguments": {"file_path": "result.txt", "content": "ok\n"},
    }
    assert chunks[1].data["reason"] == "tool_use"


@pytest.mark.asyncio
async def test_prompt_mode_runs_through_the_production_agent_loop(
    tmp_path: Path,
) -> None:
    delegate = ScriptedProvider(steps=[
        [
            StreamChunk(
                type="text-delta",
                data={
                    "text": (
                        '<tool_call>{"name":"write","arguments":'
                        '{"file_path":"result.txt","content":"valid\\n"}}'
                        "</tool_call>"
                    )
                },
            ),
            StreamChunk(type="finish", data={"reason": "stop"}),
        ],
        [
            StreamChunk(type="text-delta", data={"text": "Created the file."}),
            StreamChunk(type="finish", data={"reason": "stop"}),
        ],
    ])

    attempt = await run_task(
        STRUCTURED_TASKS_DIR / "valid-write-001.yaml",
        tmp_path / "run",
        provider=PromptToolCallingProvider(delegate),
    )

    assert attempt.score.passed is True
    assert attempt.configuration.tool_call_mode == "prompt"
    assert attempt.score.metrics["strict_schema_valid_at_1"] == 1
    assert attempt.score.metrics["semantic_valid_at_1"] == 1


@pytest.mark.asyncio
async def test_realrouter_provider_declares_only_the_requested_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REALROUTER_API_KEY", "test-key-never-sent")

    provider = create_realrouter_provider("gpt-5.6-luna")
    models = await provider.list_models()

    assert provider.id == "realrouter"
    assert [model.id for model in models] == ["gpt-5.6-luna"]


def test_realrouter_provider_accepts_a_local_proxy_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REALROUTER_API_KEY", "test-key-never-sent")
    monkeypatch.setenv("REALROUTER_BASE_URL", "http://127.0.0.1:8787/v1")

    provider = create_realrouter_provider("gpt-5.6-terra")

    assert str(provider._client.base_url) == "http://127.0.0.1:8787/v1/"


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


def test_structured_live_subset_is_shared_by_cloud_and_local_adapters() -> None:
    task_files = discover_task_files(STRUCTURED_TASKS_DIR, execution_mode="live")

    assert [task.stem for task in task_files] == [
        "missing-required-recovery-001",
        "semantic-path-recovery-001",
        "valid-write-001",
        "wrong-tool-recovery-001",
        "wrong-type-recovery-001",
    ]
