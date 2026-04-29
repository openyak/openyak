import pytest

from app.session.processor import (
    _permission_arguments_for_event,
    _permission_decision_from_response,
    _permission_message,
)
from app.agent.agent import AgentRegistry
from app.agent.permission import evaluate
from app.schemas.chat import PromptRequest
from app.schemas.provider import ModelInfo
from app.session.manager import create_session
from app.session.prompt import SessionPrompt
from app.streaming.manager import GenerationJob


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
    assert _permission_decision_from_response(True) == {"allowed": True, "remember": False}
    assert _permission_decision_from_response(False) == {"allowed": False, "remember": False}


def test_permission_decision_accepts_remember_payload() -> None:
    assert _permission_decision_from_response({"allowed": True, "remember": True}) == {
        "allowed": True,
        "remember": True,
    }
    assert _permission_decision_from_response({"allowed": False, "remember": True}) == {
        "allowed": False,
        "remember": True,
    }


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
