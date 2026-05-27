"""Session manager tests (DB operations)."""

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.session.manager import (
    create_message,
    create_part,
    create_session,
    get_message_history_for_llm,
    get_messages,
    get_session,
    list_sessions,
    update_session_title,
)


class TestSessionManager:
    @pytest.mark.asyncio
    async def test_create_session(self, db: AsyncSession):
        session = await create_session(db, title="Test Session")
        assert session.id is not None
        assert session.title == "Test Session"

    @pytest.mark.asyncio
    async def test_get_session(self, db: AsyncSession):
        session = await create_session(db, title="Find Me")
        found = await get_session(db, session.id)
        assert found is not None
        assert found.title == "Find Me"

    @pytest.mark.asyncio
    async def test_get_nonexistent_session(self, db: AsyncSession):
        found = await get_session(db, "nonexistent-id")
        assert found is None

    @pytest.mark.asyncio
    async def test_list_sessions(self, db: AsyncSession):
        await create_session(db, title="S1")
        await create_session(db, title="S2")
        sessions = await list_sessions(db)
        assert len(sessions) >= 2

    @pytest.mark.asyncio
    async def test_update_title(self, db: AsyncSession):
        session = await create_session(db, title="Old")
        await update_session_title(db, session.id, "New")
        updated = await get_session(db, session.id)
        assert updated.title == "New"


class TestMessageManager:
    @pytest.mark.asyncio
    async def test_create_message_and_part(self, db: AsyncSession):
        session = await create_session(db, title="Msg Test")
        msg = await create_message(db, session_id=session.id, data={"role": "user"})
        assert msg.id is not None

        part = await create_part(
            db, message_id=msg.id, session_id=session.id,
            data={"type": "text", "text": "hello"},
        )
        assert part.id is not None

    @pytest.mark.asyncio
    async def test_get_messages_with_parts(self, db: AsyncSession):
        session = await create_session(db, title="Parts Test")

        msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=msg.id, session_id=session.id,
            data={"type": "text", "text": "hello"},
        )
        await create_part(
            db, message_id=msg.id, session_id=session.id,
            data={"type": "text", "text": "world"},
        )

        messages = await get_messages(db, session.id)
        assert len(messages) == 1
        assert len(messages[0].parts) == 2

    @pytest.mark.asyncio
    async def test_message_history_for_llm(self, db: AsyncSession):
        session = await create_session(db, title="LLM History")

        # User message
        user_msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=user_msg.id, session_id=session.id,
            data={"type": "text", "text": "What is 2+2?"},
        )

        # Assistant message
        asst_msg = await create_message(db, session_id=session.id, data={"role": "assistant"})
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "text", "text": "4"},
        )

        history = await get_message_history_for_llm(db, session.id)
        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[0]["content"] == "What is 2+2?"
        assert history[1]["role"] == "assistant"
        assert history[1]["content"] == "4"

    @pytest.mark.asyncio
    async def test_history_reasoning_echo_provider_matrix(
        self, db: AsyncSession,
    ):
        """Issue #126: thinking-mode providers using DeepSeek's
        `reasoning_content` convention 400 on multi-turn follow-ups unless the
        prior assistant turn echoes its reasoning. The exceptions are:

          * providers with their own reasoning protocol
            (openrouter / anthropic / google / openai / azure)
          * the legacy `deepseek-reasoner` (R1) model, which rejects the field
            on input.
        """
        session = await create_session(db, title="Thinking Echo")

        user_msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=user_msg.id, session_id=session.id,
            data={"type": "text", "text": "What is 2+2?"},
        )

        asst_msg = await create_message(db, session_id=session.id, data={"role": "assistant"})
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "reasoning", "text": "User wants arithmetic. 2+2=4."},
        )
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "text", "text": "4"},
        )

        expected_reasoning = "User wants arithmetic. 2+2=4."

        # Every openai-compat provider that surfaces reasoning_content must
        # receive the echo. Default behavior — no enumeration needed except
        # for documentation: catalog providers + ollama / rapid-mlx / BYOK.
        echo_providers = (
            "deepseek", "kimi", "qwen", "zhipu",
            "groq", "mistral", "xai", "together", "deepinfra",
            "cerebras", "cohere", "perplexity", "fireworks",
            "minimax", "siliconflow", "xiaomi",
            "ollama", "rapid-mlx",
            "some-byok-id",  # GenericOpenAIProvider with a custom id
        )
        for provider_id in echo_providers:
            history = await get_message_history_for_llm(
                db, session.id, provider_id=provider_id,
            )
            assert history[1]["role"] == "assistant"
            assert history[1].get("reasoning_content") == expected_reasoning, (
                f"{provider_id} should echo reasoning_content"
            )

        # Providers with their own reasoning protocol — never echo.
        skip_providers = (
            "openrouter", "anthropic", "google",
            "openai", "openai-subscription", "azure",
            None,  # no provider hint (compaction / workspace memory callers)
        )
        for provider_id in skip_providers:
            history = await get_message_history_for_llm(
                db, session.id, provider_id=provider_id,
            )
            assert "reasoning_content" not in history[1], (
                f"{provider_id} must not receive reasoning_content"
            )

        # Legacy deepseek-reasoner (R1) actively 400s when reasoning_content
        # is included on input — strip even though the provider is deepseek.
        history = await get_message_history_for_llm(
            db, session.id, provider_id="deepseek", model_id="deepseek-reasoner",
        )
        assert "reasoning_content" not in history[1]

        # Match is exact, not prefix: a hypothetical future model whose name
        # starts with `deepseek-reasoner-` is not assumed to share R1's
        # rejection rule, so the echo still applies.
        history = await get_message_history_for_llm(
            db, session.id, provider_id="deepseek", model_id="deepseek-reasoner-v2",
        )
        assert history[1].get("reasoning_content") == expected_reasoning

    @pytest.mark.asyncio
    async def test_history_reasoning_only_assistant_turn_preserved(
        self, db: AsyncSession,
    ):
        """An assistant turn with only reasoning (no text, no tool_calls) must
        survive in history when echo is on, otherwise the assistant slot goes
        missing from the alternating sequence.
        """
        session = await create_session(db, title="Reasoning-only turn")

        user_msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=user_msg.id, session_id=session.id,
            data={"type": "text", "text": "Continue thinking."},
        )

        asst_msg = await create_message(db, session_id=session.id, data={"role": "assistant"})
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "reasoning", "text": "Still working it out."},
        )

        echoed = await get_message_history_for_llm(
            db, session.id, provider_id="deepseek",
        )
        assert echoed[-1]["role"] == "assistant"
        assert echoed[-1]["content"] == ""
        assert echoed[-1]["reasoning_content"] == "Still working it out."

        # When echo is off the orphan turn is collapsed (no value in keeping
        # an empty assistant message that won't be sent).
        skipped = await get_message_history_for_llm(db, session.id)
        assert all(m["role"] == "user" for m in skipped)

    @pytest.mark.asyncio
    async def test_history_reasoning_content_is_trimmed(self, db: AsyncSession):
        """Reasoning blocks can be tens of thousands of chars; per-message
        trimming caps each turn so a single thinking-heavy reply cannot
        consume the entire request budget.
        """
        session = await create_session(db, title="Huge reasoning")

        user_msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=user_msg.id, session_id=session.id,
            data={"type": "text", "text": "ping"},
        )

        huge = "x" * 200_000
        asst_msg = await create_message(db, session_id=session.id, data={"role": "assistant"})
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "reasoning", "text": huge},
        )
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "text", "text": "pong"},
        )

        history = await get_message_history_for_llm(
            db, session.id, provider_id="deepseek",
        )
        reasoning = history[1]["reasoning_content"]
        assert len(reasoning) < len(huge)
        assert "[reasoning truncated for context" in reasoning

    @pytest.mark.asyncio
    async def test_history_with_tool_calls(self, db: AsyncSession):
        session = await create_session(db, title="Tool History")

        # User message
        user_msg = await create_message(db, session_id=session.id, data={"role": "user"})
        await create_part(
            db, message_id=user_msg.id, session_id=session.id,
            data={"type": "text", "text": "Read test.py"},
        )

        # Assistant with tool call
        asst_msg = await create_message(db, session_id=session.id, data={"role": "assistant"})
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={"type": "text", "text": "Let me read that file."},
        )
        await create_part(
            db, message_id=asst_msg.id, session_id=session.id,
            data={
                "type": "tool", "tool": "read", "call_id": "call_1",
                "state": {
                    "status": "completed",
                    "input": {"file_path": "test.py"},
                    "output": "print('hello')",
                },
            },
        )

        history = await get_message_history_for_llm(db, session.id)
        # Should be: user, assistant (with tool_calls), tool result
        assert len(history) == 3
        assert history[0]["role"] == "user"
        assert history[1]["role"] == "assistant"
        assert "tool_calls" in history[1]
        assert history[2]["role"] == "tool"
        assert history[2]["content"] == "print('hello')"
