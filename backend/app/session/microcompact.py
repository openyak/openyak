"""Microcompact — lightweight zero-LLM-cost context compression.

Inspired by Claude Code's microcompact system. Runs before every LLM call
to replace old tool outputs with compact stubs, significantly reducing
context usage without any LLM invocation.

Three layers (cheapest to most aggressive):
  1. microcompact_messages() — replace old outputs from specific tool types
  2. apply_tool_result_budget() — enforce aggregate size limit across all tool results
  3. context_collapse() — drop oldest 1/3 of messages, insert boundary summary

OpenAI message format handled:
  - Assistant: {"role": "assistant", "tool_calls": [{"id": "call_1", "function": {"name": "read", ...}}]}
  - Tool result: {"role": "tool", "tool_call_id": "call_1", "content": "..."}
  - The tool_call_id→tool_name mapping must be built from assistant messages first.
"""

from __future__ import annotations

import logging
from typing import Any

from app.utils.token import estimate_tokens

logger = logging.getLogger(__name__)

# Tools whose old outputs can be safely replaced with stubs.
# These produce large but non-critical output that can be re-fetched.
MICROCOMPACTABLE_TOOLS = frozenset({
    "read", "grep", "bash", "glob", "search", "web_fetch",
    "edit", "write",  # Claude Code also compacts these
})

# Default thresholds
DEFAULT_MAX_TOOL_OUTPUT_TOKENS = 2000
DEFAULT_SKIP_RECENT_TURNS = 2
DEFAULT_BUDGET_TOKENS = 100_000


def _build_call_id_to_tool_name(messages: list[dict[str, Any]]) -> dict[str, str]:
    """Build a mapping from tool_call_id to tool name.

    Scans assistant messages for tool_calls arrays and extracts
    the id → function.name mapping.
    """
    mapping: dict[str, str] = {}
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            continue
        for tc in tool_calls:
            call_id = tc.get("id", "")
            func = tc.get("function", {})
            name = func.get("name", "")
            if call_id and name:
                mapping[call_id] = name
    return mapping


def _count_recent_messages(messages: list[dict[str, Any]], skip_turns: int) -> int:
    """Count how many trailing messages constitute the last N assistant turns.

    A 'turn' = one assistant message + its subsequent tool results + next user message.
    We walk backwards counting assistant messages to find the cutoff index.
    """
    if skip_turns <= 0:
        return 0

    assistant_count = 0
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant":
            assistant_count += 1
            if assistant_count >= skip_turns:
                return len(messages) - i
    return 0  # Not enough turns to skip


def microcompact_messages(
    messages: list[dict[str, Any]],
    *,
    skip_recent_turns: int = DEFAULT_SKIP_RECENT_TURNS,
    max_tool_output_tokens: int = DEFAULT_MAX_TOOL_OUTPUT_TOKENS,
) -> list[dict[str, Any]]:
    """Replace old tool results from specific tool types with compact stubs.

    Zero LLM cost — pure text replacement. Runs before every LLM call.

    Args:
        messages: LLM-formatted message history (OpenAI format).
        skip_recent_turns: Number of recent assistant turns to protect.
        max_tool_output_tokens: Token threshold above which old outputs are replaced.

    Returns:
        A new message list with old tool outputs replaced by stubs.
    """
    if not messages:
        return messages

    # Build tool_call_id → tool_name mapping from all assistant messages
    call_id_map = _build_call_id_to_tool_name(messages)

    # Find cutoff: protect the last N assistant turns
    protected_count = _count_recent_messages(messages, skip_recent_turns)
    cutoff = len(messages) - protected_count
    if cutoff <= 0:
        return messages

    replaced = 0
    result = []
    for i, msg in enumerate(messages):
        if i >= cutoff:
            result.append(msg)
            continue

        if msg.get("role") != "tool":
            result.append(msg)
            continue

        # This is a tool result message
        tool_call_id = msg.get("tool_call_id", "")
        tool_name = call_id_map.get(tool_call_id, "")
        content = msg.get("content", "")

        # Only compress outputs from microcompactable tools
        if (
            tool_name in MICROCOMPACTABLE_TOOLS
            and isinstance(content, str)
            and content
        ):
            tokens = estimate_tokens(content)
            if tokens > max_tool_output_tokens:
                msg = dict(msg)
                msg["content"] = (
                    f"[Previous {tool_name} output cleared — "
                    f"{tokens} tokens. Re-run tool if needed.]"
                )
                replaced += 1

        result.append(msg)

    if replaced:
        logger.info("Microcompact: replaced %d old tool outputs", replaced)

    return result


def apply_tool_result_budget(
    messages: list[dict[str, Any]],
    *,
    budget_tokens: int = DEFAULT_BUDGET_TOKENS,
    skip_recent_turns: int = DEFAULT_SKIP_RECENT_TURNS,
) -> list[dict[str, Any]]:
    """Enforce aggregate size limit across all tool results.

    When total tool result tokens exceed the budget, replace the
    oldest/largest results first until within budget.

    Args:
        messages: LLM-formatted message history.
        budget_tokens: Maximum total tokens allowed for all tool results.
        skip_recent_turns: Number of recent assistant turns to protect.

    Returns:
        A new message list with oversized tool results replaced.
    """
    if not messages:
        return messages

    call_id_map = _build_call_id_to_tool_name(messages)

    protected_count = _count_recent_messages(messages, skip_recent_turns)
    cutoff = len(messages) - protected_count
    if cutoff <= 0:
        return messages

    # First pass: collect all tool results with their sizes
    tool_entries: list[dict[str, Any]] = []
    total_tokens = 0

    for i, msg in enumerate(messages):
        if i >= cutoff:
            continue
        if msg.get("role") != "tool":
            continue

        content = msg.get("content", "")
        if isinstance(content, str) and content:
            tokens = estimate_tokens(content)
            tool_call_id = msg.get("tool_call_id", "")
            tool_entries.append({
                "msg_index": i,
                "tokens": tokens,
                "tool_call_id": tool_call_id,
            })
            total_tokens += tokens

    if total_tokens <= budget_tokens:
        return messages

    # Sort by tokens descending — replace largest first
    tool_entries.sort(key=lambda x: x["tokens"], reverse=True)

    to_replace: set[int] = set()
    excess = total_tokens - budget_tokens

    for entry in tool_entries:
        if excess <= 0:
            break
        to_replace.add(entry["msg_index"])
        excess -= entry["tokens"]

    # Second pass: replace identified messages
    result = []
    for i, msg in enumerate(messages):
        if i in to_replace:
            msg = dict(msg)
            tokens = estimate_tokens(msg.get("content", ""))
            tool_call_id = msg.get("tool_call_id", "")
            tool_name = call_id_map.get(tool_call_id, "tool")
            msg["content"] = (
                f"[{tool_name} output removed to stay within context budget — "
                f"{tokens} tokens. Re-run tool if needed.]"
            )
        result.append(msg)

    saved = total_tokens - budget_tokens
    logger.info(
        "Tool result budget: replaced %d results, saved ~%d tokens",
        len(to_replace), saved,
    )

    return result


# ---------------------------------------------------------------------------
# Layer 3: Context Collapse
# ---------------------------------------------------------------------------

def select_collapse_boundary(
    roles: list[str],
    *,
    collapse_fraction: float = 0.33,
    min_messages_to_keep: int = 6,
) -> int:
    """Return the index of the first message to keep, given message roles.

    Shared by :func:`context_collapse` (which applies it to the LLM-formatted
    history) and by the persistence layer (which applies it to the stored
    Message rows) so both agree on where the collapse boundary falls.

    Returns 0 when nothing should be collapsed.
    """
    total = len(roles)
    if total <= min_messages_to_keep:
        return 0

    drop_count = int(total * collapse_fraction)

    # Ensure we keep at least min_messages_to_keep
    if total - drop_count < min_messages_to_keep:
        drop_count = total - min_messages_to_keep
    if drop_count <= 0:
        return 0

    # Find a safe boundary: don't split mid-turn.
    # Walk forward from the target drop_count to find a user message
    # boundary (so we don't leave orphaned tool results).
    boundary = drop_count
    while boundary < total - min_messages_to_keep:
        if roles[boundary] == "user":
            break
        boundary += 1
    else:
        # Couldn't find a clean boundary — use the original count
        boundary = drop_count

    return boundary


def format_collapse_boundary(
    *,
    dropped: int,
    users: int,
    assistants: int,
    tools: int,
    tokens_saved: int,
) -> str:
    """Render the synthetic boundary marker text for a context collapse.

    Shared by :func:`context_collapse` and by the persistence layer so the
    user-visible counts always describe the trim that was actually applied.
    """
    return (
        f"[Context collapsed: {dropped} earlier messages removed "
        f"({users} user, {assistants} assistant, "
        f"{tools} tool results — ~{tokens_saved:,} tokens freed). "
        f"If you need earlier context, ask the user or re-read relevant files.]"
    )


def context_collapse(
    messages: list[dict[str, Any]],
    *,
    collapse_fraction: float = 0.33,
    min_messages_to_keep: int = 6,
) -> tuple[list[dict[str, Any]], int]:
    """Drop the oldest portion of messages and insert a boundary marker.

    This is a zero-LLM-cost intermediate compression layer between
    microcompact and full compaction. It removes the oldest ``collapse_fraction``
    of messages (by count) and inserts a synthetic system message summarizing
    what was dropped, preserving the most recent conversation context intact.

    The boundary ensures the LLM knows context was truncated and key data
    may need to be re-fetched.

    Args:
        messages: LLM-formatted message history (OpenAI format).
        collapse_fraction: Fraction of messages to drop (0.0–1.0).
        min_messages_to_keep: Minimum messages to retain after collapse.

    Returns:
        A tuple of (new_messages, tokens_saved) where tokens_saved is an
        estimate of the tokens freed.
    """
    if not messages:
        return messages, 0

    total = len(messages)
    boundary = select_collapse_boundary(
        [str(m.get("role", "")) for m in messages],
        collapse_fraction=collapse_fraction,
        min_messages_to_keep=min_messages_to_keep,
    )
    if boundary <= 0:
        return messages, 0

    dropped = messages[:boundary]
    kept = messages[boundary:]

    # Estimate tokens saved
    tokens_saved = sum(estimate_tokens(_msg_text(m)) for m in dropped)

    # Build a brief summary of what was dropped
    dropped_user_msgs = [m for m in dropped if m.get("role") == "user"]
    dropped_assistant_msgs = [m for m in dropped if m.get("role") == "assistant"]
    dropped_tool_msgs = [m for m in dropped if m.get("role") == "tool"]

    boundary_text = format_collapse_boundary(
        dropped=len(dropped),
        users=len(dropped_user_msgs),
        assistants=len(dropped_assistant_msgs),
        tools=len(dropped_tool_msgs),
        tokens_saved=tokens_saved,
    )

    boundary_msg: dict[str, Any] = {
        "role": "user",
        "content": boundary_text,
    }

    result = [boundary_msg] + kept

    logger.info(
        "Context collapse: dropped %d/%d messages, saved ~%d tokens",
        boundary, total, tokens_saved,
    )

    return result, tokens_saved


def _msg_text(msg: dict[str, Any]) -> str:
    """Extract text content from a message for token estimation."""
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            block.get("text", "") for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""
