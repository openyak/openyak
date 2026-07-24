import asyncio
from types import SimpleNamespace

import pytest

from app.session.processor import (
    SessionProcessor,
    _permission_arguments_for_event,
    _permission_decision_from_response,
    _permission_message,
    _resolve_remember_pattern,
)
from app.agent.agent import AgentRegistry
from app.agent.permission import evaluate
from app.schemas.chat import PromptRequest
from app.schemas.provider import ModelInfo
from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_messages,
)
from app.session.prompt import SessionPrompt
from app.streaming.manager import GenerationJob
from app.tool.builtin.task import TaskTool


def test_permission_arguments_redact_secret_like_keys() -> None:
    args, truncated = _permission_arguments_for_event({
        "command": "curl https://example.test",
        "api_key": "sk-test-secret",
        "nested": {"Authorization": "Bearer secret"},
    })

    assert truncated is False
    assert args["command"] == "curl https://example.test"
    assert args["api_key"] == "[redacted]"
    assert args["nested"] == {"Authorization": "[redacted]"}


def test_permission_arguments_truncate_large_values() -> None:
    args, truncated = _permission_arguments_for_event({
        "file_path": "report.md",
        "content": "x" * 25_000,
    })

    assert truncated is True
    assert args["file_path"] == "report.md"
    assert str(args["content"]).endswith("[permission preview truncated]")


def test_permission_message_shows_bash_command() -> None:
    message = _permission_message(
        "bash",
        {"command": "npm run preflight:ui"},
        truncated=False,
    )

    assert "shell command" in message
    assert "npm run preflight:ui" in message


def test_permission_message_shows_file_target_and_truncation() -> None:
    message = _permission_message(
        "write",
        {"file_path": "docs/launch.md"},
        truncated=True,
    )

    assert "docs/launch.md" in message
    assert "truncated" in message


def test_permission_decision_accepts_legacy_bool() -> None:
    assert _permission_decision_from_response(True) == {
        "allowed": True,
        "remember": False,
        "pattern": None,
    }
    assert _permission_decision_from_response(False) == {
        "allowed": False,
        "remember": False,
        "pattern": None,
    }


def test_permission_decision_accepts_remember_payload() -> None:
    assert _permission_decision_from_response({"allowed": True, "remember": True}) == {
        "allowed": True,
        "remember": True,
        "pattern": None,
    }
    assert _permission_decision_from_response({"allowed": False, "remember": True}) == {
        "allowed": False,
        "remember": True,
        "pattern": None,
    }


def test_permission_decision_extracts_scope_pattern() -> None:
    decision = _permission_decision_from_response(
        {"allowed": True, "remember": True, "pattern": "git *"}
    )
    assert decision["pattern"] == "git *"

    # Non-string / empty patterns are ignored, not remembered verbatim.
    assert _permission_decision_from_response(
        {"allowed": True, "remember": True, "pattern": 42}
    )["pattern"] is None
    assert _permission_decision_from_response(
        {"allowed": True, "remember": True, "pattern": "   "}
    )["pattern"] is None


def test_resolve_remember_pattern_honors_covering_scope() -> None:
    # Chosen scope covers the approved resource → honored.
    assert _resolve_remember_pattern("git push origin main", "git *") == "git *"
    assert _resolve_remember_pattern("/ws/report/q3.md", "/ws/report/*") == "/ws/report/*"
    assert _resolve_remember_pattern("npm run build", "*") == "*"
    # Exact resource is a valid scope of itself.
    assert _resolve_remember_pattern("git status", "git status") == "git status"


def test_resolve_remember_pattern_falls_back_on_mismatch() -> None:
    # A scope that does not cover the approved resource falls back to the
    # exact resource instead of persisting an unrelated rule.
    assert _resolve_remember_pattern("git push", "npm *") == "git push"
    assert _resolve_remember_pattern("/ws/a.txt", "/other/*") == "/ws/a.txt"
    # Missing/blank/non-string scopes also fall back.
    assert _resolve_remember_pattern("git push", None) == "git push"
    assert _resolve_remember_pattern("git push", "") == "git push"
    assert _resolve_remember_pattern("git push", 7) == "git push"


class _Provider:
    id = "test-provider"


class _ProviderRegistry:
    def __init__(self) -> None:
        self.provider = _Provider()
        self.model = ModelInfo(
            id="test-model",
            name="Test Model",
            provider_id=self.provider.id,
        )

    def resolve_model(self, _model_id: str, _provider_id: str | None = None):
        return self.provider, self.model

    async def refresh_models(self):
        return {}


class _ToolRegistry:
    pass


async def _setup_prompt(session_factory, request: PromptRequest) -> SessionPrompt:
    prompt = SessionPrompt(
        job=GenerationJob(stream_id="stream-test", session_id=request.session_id),
        request=request,
        session_factory=session_factory,
        provider_registry=_ProviderRegistry(),
        agent_registry=AgentRegistry(),
        tool_registry=_ToolRegistry(),
    )
    await prompt._setup()
    return prompt


@pytest.mark.asyncio
async def test_prompt_ignores_historical_session_permissions(session_factory) -> None:
    async with session_factory() as db:
        async with db.begin():
            session = await create_session(
                db,
                id="session-with-hidden-allow",
            )
            session.permission = [{"action": "allow", "permission": "bash", "pattern": "*"}]

    prompt = await _setup_prompt(
        session_factory,
        PromptRequest(
            session_id="session-with-hidden-allow",
            text="run a command",
            model="test-model",
        ),
    )

    assert evaluate("bash", "*", prompt.merged_permissions) == "ask"


@pytest.mark.asyncio
async def test_prompt_uses_request_permission_rules(session_factory) -> None:
    prompt = await _setup_prompt(
        session_factory,
        PromptRequest(
            session_id="session-with-request-allow",
            text="run a command",
            model="test-model",
            permission_rules=[
                {"action": "allow", "permission": "bash", "pattern": "*"},
            ],
        ),
    )

    assert evaluate("bash", "*", prompt.merged_permissions) == "allow"


@pytest.mark.asyncio
async def test_ultra_prompt_is_persisted_as_a_turn_variant(session_factory) -> None:
    prompt = await _setup_prompt(
        session_factory,
        PromptRequest(
            session_id="ultra-session",
            text="inspect two independent areas",
            model="test-model",
            execution_mode="ultra",
        ),
    )

    assert "# Ultra Execution" in prompt.system_prompt
    async with session_factory() as db:
        messages = await get_messages(db, "ultra-session")
    assert messages[0].data["variant"] == "ultra"


@pytest.mark.asyncio
async def test_child_session_cannot_recursively_enable_ultra(
    session_factory,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="parent-session")
            await create_session(
                db,
                id="child-session",
                parent_id="parent-session",
            )

    prompt = await _setup_prompt(
        session_factory,
        PromptRequest(
            session_id="child-session",
            text="try to fork again",
            model="test-model",
            execution_mode="ultra",
        ),
    )

    assert prompt.request.execution_mode == "standard"
    assert "# Ultra Execution" not in prompt.system_prompt


@pytest.mark.asyncio
async def test_plan_agent_denials_override_false_permission_presets(
    session_factory,
) -> None:
    prompt = await _setup_prompt(
        session_factory,
        PromptRequest(
            session_id="plan-permission-session",
            text="plan only",
            model="test-model",
            agent="plan",
            permission_presets={
                "file_changes": False,
                "run_commands": False,
            },
            permission_rules=[
                {
                    "action": "allow",
                    "permission": permission,
                    "pattern": "*",
                }
                for permission in (
                    "write",
                    "edit",
                    "apply_patch",
                    "artifact",
                    "bash",
                    "code_execute",
                )
            ],
        ),
    )

    for permission in (
        "write",
        "edit",
        "apply_patch",
        "artifact",
        "bash",
        "code_execute",
    ):
        assert evaluate(permission, "*", prompt.merged_permissions) == "deny"


@pytest.mark.asyncio
async def test_cancelled_dispatch_finalizes_running_tool_part(
    session_factory,
    monkeypatch,
) -> None:
    import app.session.processor as processor_module

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="cancel-tool-session")
            message = await create_message(
                db,
                session_id="cancel-tool-session",
                data={"role": "assistant", "agent": "build"},
            )
            tool_part = await create_part(
                db,
                message_id=message.id,
                session_id="cancel-tool-session",
                data={
                    "type": "tool",
                    "tool": "task",
                    "call_id": "cancel-call",
                    "state": {
                        "status": "running",
                        "input": {"prompt": "wait"},
                    },
                },
            )

    real_update = processor_module.update_part_data
    write_attempts = 0

    async def flaky_update(db, part_id, data):
        nonlocal write_attempts
        write_attempts += 1
        if write_attempts == 1:
            raise RuntimeError("transient ToolPart write")
        return await real_update(db, part_id, data)

    monkeypatch.setattr(processor_module, "update_part_data", flaky_update)

    class _CancelledExecutor:
        has_submissions = True

        def __init__(self) -> None:
            self.cancelled = False

        async def collect(self):
            raise asyncio.CancelledError

        def cancel_all(self) -> None:
            self.cancelled = True

    executor = _CancelledExecutor()
    processor = SessionProcessor(
        SimpleNamespace(
            session_factory=session_factory,
            job=GenerationJob(
                "cancel-tool-stream",
                "cancel-tool-session",
            ),
        ),
        [],
        message.id,
    )
    processor._native_search_ids = set()
    processor._tool_calls_in_step = [{"id": "cancel-call"}]
    processor._has_tool_calls = True
    processor._exec_blocked = False
    processor._streaming_executor = executor
    processor._exec_metadata = {
        0: {
            "tool_part_id": tool_part.id,
            "loop_result": None,
            "tool": TaskTool(),
            "tool_args": {"prompt": "wait"},
            "call_id": "cancel-call",
        }
    }

    with pytest.raises(asyncio.CancelledError):
        await processor._dispatch_tool_calls()

    assert executor.cancelled is True
    assert write_attempts == 2
    async with session_factory() as db:
        messages = await get_messages(db, "cancel-tool-session")
    persisted = next(
        part.data
        for persisted_message in messages
        for part in persisted_message.parts
        if part.id == tool_part.id
    )
    assert persisted["state"]["status"] == "error"
    assert "cancel" in persisted["state"]["output"].lower()


@pytest.mark.asyncio
async def test_cancel_cleanup_preserves_already_finalized_tool_part(
    session_factory,
) -> None:
    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="partial-finalize-session")
            message = await create_message(
                db,
                session_id="partial-finalize-session",
                data={"role": "assistant", "agent": "build"},
            )
            completed_part = await create_part(
                db,
                message_id=message.id,
                session_id="partial-finalize-session",
                data={
                    "type": "tool",
                    "tool": "task",
                    "call_id": "completed-call",
                    "state": {
                        "status": "completed",
                        "input": {},
                        "output": "kept",
                    },
                },
            )
            running_part = await create_part(
                db,
                message_id=message.id,
                session_id="partial-finalize-session",
                data={
                    "type": "tool",
                    "tool": "task",
                    "call_id": "running-call",
                    "state": {"status": "running", "input": {}},
                },
            )

    processor = SessionProcessor(
        SimpleNamespace(
            session_factory=session_factory,
            job=GenerationJob(
                "partial-finalize-stream",
                "partial-finalize-session",
            ),
        ),
        [],
        message.id,
    )
    processor._exec_metadata = {
        0: {
            "tool_part_id": completed_part.id,
            "tool": TaskTool(),
            "tool_args": {},
            "call_id": "completed-call",
        },
        1: {
            "tool_part_id": running_part.id,
            "tool": TaskTool(),
            "tool_args": {},
            "call_id": "running-call",
        },
    }
    processor._finalized_exec_indices = {0}

    await processor._finalize_cancelled_tool_parts()

    async with session_factory() as db:
        messages = await get_messages(db, "partial-finalize-session")
    parts = {
        part.id: part.data
        for persisted_message in messages
        for part in persisted_message.parts
    }
    assert parts[completed_part.id]["state"] == {
        "status": "completed",
        "input": {},
        "output": "kept",
    }
    assert parts[running_part.id]["state"]["status"] == "error"


@pytest.mark.asyncio
async def test_cancel_wins_when_tool_result_finalization_also_fails() -> None:
    processor = SessionProcessor(
        SimpleNamespace(
            session_factory=None,
            job=GenerationJob(
                "finalize-race-stream",
                "finalize-race-session",
            ),
        ),
        [],
        "assistant-message",
    )
    processor._finalized_exec_indices = set()
    finalization_started = asyncio.Event()
    release_finalization = asyncio.Event()

    async def failing_finalization(_meta, _exec_result) -> None:
        finalization_started.set()
        await release_finalization.wait()
        raise RuntimeError("synthetic terminal ToolPart write failure")

    processor._finalize_one_tool_result = failing_finalization
    finalization = asyncio.create_task(
        processor._finalize_exec_result(0, {}, object())
    )
    await finalization_started.wait()
    finalization.cancel()
    await asyncio.sleep(0)
    release_finalization.set()

    with pytest.raises(asyncio.CancelledError):
        await finalization
    assert processor._finalized_exec_indices == set()


@pytest.mark.asyncio
async def test_completed_tool_part_retries_transient_terminal_write(
    session_factory,
    monkeypatch,
) -> None:
    import app.session.processor as processor_module
    from app.tool.base import ToolResult

    async with session_factory() as db:
        async with db.begin():
            await create_session(db, id="completed-tool-retry-session")
            message = await create_message(
                db,
                session_id="completed-tool-retry-session",
                data={"role": "assistant", "agent": "build"},
            )
            part = await create_part(
                db,
                message_id=message.id,
                session_id="completed-tool-retry-session",
                data={
                    "type": "tool",
                    "tool": "task",
                    "call_id": "completed-retry-call",
                    "state": {"status": "running", "input": {}},
                },
            )

    real_update = processor_module.update_part_data
    attempts = 0

    async def flaky_update(db, part_id, data):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient completed ToolPart write")
        return await real_update(db, part_id, data)

    monkeypatch.setattr(processor_module, "update_part_data", flaky_update)
    processor = SessionProcessor(
        SimpleNamespace(
            session_factory=session_factory,
            job=GenerationJob(
                "completed-tool-retry-stream",
                "completed-tool-retry-session",
            ),
            current_todos=[],
        ),
        [],
        message.id,
    )
    processor._finalized_exec_indices = set()
    await processor._finalize_exec_result(
        0,
        {
            "tool_part_id": part.id,
            "loop_result": SimpleNamespace(action="none", message=None),
            "tool": TaskTool(),
            "tool_args": {},
            "call_id": "completed-retry-call",
        },
        SimpleNamespace(
            timed_out=False,
            error=None,
            result=ToolResult(output="completed"),
        ),
    )

    assert attempts == 2
    assert processor._finalized_exec_indices == {0}
    async with session_factory() as db:
        messages = await get_messages(db, "completed-tool-retry-session")
    persisted = next(
        persisted_part.data
        for persisted_message in messages
        for persisted_part in persisted_message.parts
        if persisted_part.id == part.id
    )
    assert persisted["state"]["status"] == "completed"
