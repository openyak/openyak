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
from dataclasses import dataclass
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

# Re-use cost/budget helpers from session utils
from app.session.utils import calculate_step_cost as _calculate_step_cost
from app.session.utils import compute_usable_context_window

logger = logging.getLogger(__name__)

# Config
PROTECTED_TOKEN_BUDGET = 40_000  # Protect this many tokens of tool output
SKIP_RECENT_TURNS = 2  # Don't compact the last N assistant messages
PROTECTED_TOOLS = frozenset({"skill"})  # Never prune these tool outputs
AUTO_COMPACT_CONTEXT_RATIO = 0.85  # Proactively compact before the hard context edge


@dataclass
class CompactionResult:
    pruned_parts: int = 0
    summary: str | None = None
    summary_visible: bool = False


async def run_compaction(
    session_id: str,
    *,
    job: GenerationJob,
    session_factory: async_sessionmaker[AsyncSession],
    provider_registry: ProviderRegistry,
    agent_registry: AgentRegistry,
    model_id: str | None = None,
    visible_summary: bool = False,
) -> CompactionResult:
    """Run two-phase compaction on a session's history."""
    logger.info("Running compaction on session %s", session_id)
    result = CompactionResult(summary_visible=visible_summary)

    if job.abort_event.is_set():
        logger.info("Compaction aborted before start for session %s", session_id)
        return result

    # Signal compaction start
    job.publish(SSEEvent(COMPACTION_START, {
        "session_id": session_id,
        "phases": ["prune", "summarize"],
    }))

    # Phase 1: Prune old tool outputs
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "prune", "status": "started",
    }))
    result.pruned_parts = await _phase1_prune(session_id, session_factory=session_factory)
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "prune", "status": "completed",
    }))

    if job.abort_event.is_set():
        logger.info("Compaction aborted after prune for session %s", session_id)
        return result

    # Phase 2: Generate summary
    job.publish(SSEEvent(COMPACTION_PHASE, {
        "session_id": session_id, "phase": "summarize", "status": "started",
    }))
    result.summary = await _phase2_summarize(
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

    if job.abort_event.is_set():
        logger.info("Compaction aborted during summarize for session %s", session_id)
        return result

    if result.summary:
        # Auto compaction keeps the injected summary invisible so it doesn't
        # interrupt the normal assistant flow. Manual compaction should surface
        # the summary so the user can see what the AI actually compressed.
        async with session_factory() as db:
            async with db.begin():
                msg = await create_message(
                    db,
                    session_id=session_id,
                    data={
                        "role": "assistant" if visible_summary else "user",
                        "agent": "compaction",
                        "system": True,
                        **({"summary": True} if visible_summary else {}),
                    },
                )
                await create_part(
                    db,
                    message_id=msg.id,
                    session_id=session_id,
                    data={
                        "type": "text",
                        "text": (
                            f"[Context Summary]\n\n{result.summary}"
                            if visible_summary
                            else f"[Context Summary]\n\n{result.summary}\n\nContinue if you have next steps."
                        ),
                        "synthetic": True,
                    },
                )
                await create_part(
                    db,
                    message_id=msg.id,
                    session_id=session_id,
                    data={"type": "compaction", "auto": True},
                )

    job.publish(SSEEvent(COMPACTED, {
        "session_id": session_id,
        "summary_created": bool(result.summary),
        "pruned_parts": result.pruned_parts,
        "visible_summary": visible_summary,
    }))
    logger.info("Compaction complete for session %s", session_id)
    return result


async def _phase1_prune(
    session_id: str,
    *,
    session_factory: async_sessionmaker[AsyncSession],
) -> int:
    """Mark old tool outputs as truncated to reduce context size."""
    pruned_parts = 0
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
                return 0  # Not enough history to prune

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
                    pruned_parts += 1

            await db.flush()
    return pruned_parts


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
            if job.abort_event.is_set():
                logger.info("Compaction summarize stream aborted for session %s", session_id)
                return None
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
    threshold_ratio: float = AUTO_COMPACT_CONTEXT_RATIO,
) -> bool:
    """Check if context usage warrants compaction.

    Mirrors OpenCode ``SessionCompaction.isOverflow()`` budget shape:
      - reserved defaults to ``min(20_000, model_max_output)``
      - usable = model_max_context - output_budget - reserved

    Also applies a proactive threshold so compaction starts around 85% of the
    provider-reported context window instead of waiting for the hard edge.
    """
    total_tokens = usage.get("total", 0)
    if not total_tokens:
        total_tokens = (
            usage.get("input", 0)
            + usage.get("output", 0)
            + usage.get("reasoning", 0)
            + usage.get("cache_read", 0)
        )
    usable = compute_usable_context_window(
        model_max_context,
        model_max_output=model_max_output,
        reserved=reserved,
    )
    threshold = min(usable, int(model_max_context * threshold_ratio))
    return total_tokens >= threshold and threshold > 0
