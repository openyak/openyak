"""Two-phase context compaction.

Phase 1 (prune): Mark old tool outputs as truncated
  - Skip last 2 turns
  - Protect first 40K tokens of tool output
  - Mark rest as compacted → "[truncated]"

Phase 2 (summarize): LLM generates structured summary
  Goal → Instructions → Discoveries → Accomplished → Relevant files

Auto-continue: Append "Continue if you have next steps"
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.agent import AgentRegistry
from app.models.message import Message, Part
from app.provider.registry import ProviderRegistry
from app.session.manager import create_message, create_part
from app.streaming.events import (
    COMPACTED,
    COMPACTION_ERROR,
    COMPACTION_PHASE,
    COMPACTION_PROGRESS,
    COMPACTION_START,
    SSEEvent,
)
from app.streaming.manager import GenerationJob
from app.utils.token import estimate_tokens

# Re-use cost calculation from session utils
from app.session.utils import calculate_step_cost as _calculate_step_cost

logger = logging.getLogger(__name__)

# Config
PROTECTED_TOKEN_BUDGET = 40_000  # Protect this many tokens of tool output
SKIP_RECENT_TURNS = 2  # Don't compact the last N assistant messages
PROTECTED_TOOLS = frozenset({"skill"})  # Never prune these tool outputs


async def run_compaction(
    session_id: str,
    *,
    job: GenerationJob,
    session_factory: async_sessionmaker[AsyncSession],
    provider_registry: ProviderRegistry,
    agent_registry: AgentRegistry,
    model_id: str | None = None,
) -> None:
    """Run two-phase compaction on a session's history."""
    logger.info("Running compaction on session %s", session_id)

    # Signal compaction start
    job.publish(SSEEvent(COMPACTION_START, {
        "session_id": session_id,
        "phases": ["prune", "summarize"],
    }))

    # Phase 1: Prune old tool outputs
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "prune", "status": "started",
    }))
    await _phase1_prune(session_id, session_factory=session_factory)
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "prune", "status": "completed",
    }))

    # Phase 2: Generate summary
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "summarize", "status": "started",
    }))
    summary = await _phase2_summarize(
        session_id,
        job=job,
        session_factory=session_factory,
        provider_registry=provider_registry,
        agent_registry=agent_registry,
        model_id=model_id,
    )
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "summarize", "status": "completed",
    }))

    if summary:
        # Insert summary as a synthetic user message
        async with session_factory() as db:
            async with db.begin():
                msg = await create_message(
                    db,
                    session_id=session_id,
                    data={"role": "user", "agent": "compaction", "system": True},
                )
                await create_part(
                    db,
                    message_id=msg.id,
                    session_id=session_id,
                    data={
                        "type": "text",
                        "text": f"[Context Summary]\n\n{summary}\n\nContinue if you have next steps.",
                        "synthetic": True,
                    },
                )
                await create_part(
                    db,
                    message_id=msg.id,
                    session_id=session_id,
                    data={"type": "compaction", "auto": True},
                )

    job.publish(SSEEvent(COMPACTED, {"session_id": session_id}))
    logger.info("Compaction complete for session %s", session_id)


async def _phase1_prune(
    session_id: str,
    *,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Mark old tool outputs as truncated to reduce context size."""
    async with session_factory() as db:
        async with db.begin():
            # Get all messages ordered by time
            stmt = (
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.time_created.asc())
            )
            result = await db.execute(stmt)
            messages = list(result.scalars().all())

            if len(messages) <= SKIP_RECENT_TURNS * 2:
                return  # Not enough history to prune

            # Skip the last N turns (each turn = user + assistant)
            cutoff = len(messages) - (SKIP_RECENT_TURNS * 2)
            messages_to_prune = messages[:cutoff]

            token_budget = PROTECTED_TOKEN_BUDGET

            for msg in messages_to_prune:
                # Get tool parts for this message
                part_stmt = (
                    select(Part)
                    .where(Part.message_id == msg.id)
                    .order_by(Part.time_created.asc())
                )
                part_result = await db.execute(part_stmt)
                parts = list(part_result.scalars().all())

                for part in parts:
                    if not part.data or part.data.get("type") != "tool":
                        continue

                    # Never prune protected tool outputs (e.g. skill)
                    tool_name = part.data.get("tool", "")
                    if tool_name in PROTECTED_TOOLS:
                        continue

                    state = part.data.get("state", {})
                    output = state.get("output", "")
                    if not output or state.get("time_compacted"):
                        continue

                    output_tokens = estimate_tokens(output)

                    if token_budget > 0:
                        token_budget -= output_tokens
                        continue  # Protected

                    # Mark as compacted
                    updated_data = dict(part.data)
                    updated_state = dict(state)
                    updated_state["output"] = "[truncated]"
                    updated_state["time_compacted"] = "auto"
                    updated_data["state"] = updated_state
                    part.data = updated_data

            await db.flush()


async def _phase2_summarize(
    session_id: str,
    *,
    job: GenerationJob,
    session_factory: async_sessionmaker[AsyncSession],
    provider_registry: ProviderRegistry,
    agent_registry: AgentRegistry,
    model_id: str | None = None,
) -> str | None:
    """Generate a structured summary of the conversation."""
    compaction_agent = agent_registry.get("compaction")
    if not compaction_agent or not compaction_agent.system_prompt:
        return None

    # Find a model
    if not model_id:
        models = provider_registry.all_models()
        if not models:
            return None
        model_id = models[0].id

    resolved = provider_registry.resolve_model(model_id)
    if not resolved:
        return None

    provider, model_info = resolved

    # Load conversation for summarization
    from app.session.manager import get_message_history_for_llm

    async with session_factory() as db:
        async with db.begin():
            llm_messages = await get_message_history_for_llm(db, session_id)

    if not llm_messages:
        return None

    # Ask compaction agent to summarize
    try:
        summary_prompt = (
            "Summarize the conversation above. Follow the format in your system prompt."
        )
        messages = llm_messages + [{"role": "user", "content": summary_prompt}]

        summary = ""
        usage_data: dict[str, Any] = {}
        last_reported = 0
        async for chunk in provider.stream_chat(
            model_id,
            messages,
            system=compaction_agent.system_prompt,
            max_tokens=4096,
        ):
            if chunk.type == "text-delta":
                summary += chunk.data.get("text", "")
                # Emit progress every ~200 chars to avoid flooding
                if len(summary) - last_reported >= 200:
                    job.publish(SSEEvent(COMPACTION_PROGRESS, {
                        "session_id": session_id,
                        "phase": "summarize",
                        "chars": len(summary),
                    }))
                    last_reported = len(summary)
            elif chunk.type == "usage":
                usage_data = chunk.data

        # Persist usage as a synthetic assistant message so the usage API picks it up
        if usage_data:
            cost = _calculate_step_cost(usage_data, model_info)
            async with session_factory() as db:
                async with db.begin():
                    await create_message(
                        db,
                        session_id=session_id,
                        data={
                            "role": "assistant",
                            "agent": "compaction",
                            "system": True,
                            "cost": cost,
                            "tokens": usage_data,
                            "model_id": model_id,
                            "provider_id": provider.id,
                        },
                    )
            logger.info(
                "Compaction usage: %s tokens, $%.6f (session %s)",
                usage_data.get("total", 0), cost, session_id,
            )

        return summary.strip() if summary.strip() else None

    except Exception as e:
        logger.warning("Failed to generate compaction summary: %s", e)
        job.publish(SSEEvent(COMPACTION_ERROR, {
            "session_id": session_id,
            "message": "Context compression failed. Consider starting a new chat.",
        }))
        return None


def should_compact(
    usage: dict[str, Any],
    model_max_context: int,
    *,
    model_max_output: int | None = None,
    reserved: int | None = None,
) -> bool:
    """Check if context usage warrants compaction.

    Mirrors OpenCode ``SessionCompaction.isOverflow()``:
      - reserved defaults to ``min(20_000, model_max_output)``
      - usable = model_max_context - output_budget - reserved
    """
    total_tokens = usage.get("total", 0)
    if not total_tokens:
        total_tokens = (
            usage.get("input", 0)
            + usage.get("output", 0)
            + usage.get("reasoning", 0)
            + usage.get("cache_read", 0)
        )
    effective_output = model_max_output or 8192
    if reserved is None:
        reserved = min(20_000, effective_output)
    # Usable = total context window - output budget - safety reserve
    usable = model_max_context - effective_output - reserved
    return total_tokens >= usable and usable > 0
