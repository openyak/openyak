"""Session utility functions — pure helpers with no side effects.

Extracted from processor.py to reduce module size and improve testability.
Functions here operate on data (messages, tokens, text) without touching
database, SSE, or LLM streaming.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)

def _cfg():
    return get_settings()


# Token estimation constants
IMAGE_TOKEN_ESTIMATE = 512  # Approximate tokens for an image_url content block
CHARS_PER_TOKEN = 4  # Average characters per token for rough estimation
MIN_RESERVED_TOKENS = 2048  # Minimum tokens reserved for system overhead
RESERVED_CONTEXT_RATIO = 0.08  # Fraction of model context reserved for overhead
MIN_PARTIAL_MESSAGE_CHARS = 2_048  # Smallest useful tail/head slice to preserve
DEFAULT_OUTPUT_BUDGET = 8192

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


def compute_effective_context_window(
    max_context: int | None,
    explicit_effective: int | None = None,
) -> int | None:
    """Compute the context window used for budgeting decisions.

    Provider-specific overrides are still honored, but models without an
    explicit override should use their advertised context window. Safety
    margins are applied later via output/reserved budgets.
    """
    if isinstance(explicit_effective, int) and explicit_effective > 0:
        if isinstance(max_context, int) and max_context > 0:
            return min(explicit_effective, max_context)
        return explicit_effective

    if isinstance(max_context, int) and max_context > 0:
        return max_context
    return None


def compute_usable_context_window(
    model_max_context: int,
    *,
    model_max_output: int | None = None,
    reserved: int | None = None,
) -> int:
    """Return context available for prompt/history after output and reserve."""
    effective_output = model_max_output or DEFAULT_OUTPUT_BUDGET
    if reserved is None:
        reserved = min(_cfg().compaction_reserved, effective_output)
    return max(0, model_max_context - effective_output - reserved)


def get_effective_context_window(model_info: Any | None) -> int | None:
    """Return the effective context window for budgeting/compaction decisions."""
    if model_info is None:
        return None

    max_context = getattr(getattr(model_info, "capabilities", None), "max_context", None)
    metadata = getattr(model_info, "metadata", None) or {}
    effective = metadata.get("effective_context_window")
    return compute_effective_context_window(max_context, effective)


def is_jwt_expired(token: str, margin_seconds: int = 60) -> bool:
    """Check if a JWT access token is expired (or nearly so)."""
    import base64
    import time

    try:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp", 0)
        return time.time() >= (exp - margin_seconds)
    except Exception:
        return False


def trim_for_context(text: str, limit: int, kind: str) -> str:
    if len(text) <= limit:
        return text
    head_len = int(limit * 0.75)
    tail_len = max(0, limit - head_len)
    head = text[:head_len]
    tail = text[-tail_len:] if tail_len > 0 else ""
    return (
        f"{head}\n\n"
        f"[{kind} truncated for context: original {len(text)} chars, kept {limit}]\n\n"
        f"{tail}"
    )


def patch_dangling_tool_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Inject synthetic tool-result messages for dangling tool calls.

    A dangling tool call occurs when an assistant message contains tool_calls
    but there is no corresponding tool-result message (e.g., user cancelled
    mid-generation). This breaks LLMs that expect paired tool_call/tool_result
    messages (especially Anthropic).

    Patches are inserted immediately after the assistant message that made the
    dangling call, preserving correct message ordering.
    """
    # Collect IDs of all existing tool-result messages
    existing_ids: set[str] = set()
    for msg in messages:
        if msg.get("role") == "tool":
            tid = msg.get("tool_call_id")
            if tid:
                existing_ids.add(tid)

    # Quick check: anything to patch?
    needs_patch = False
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        for tc in msg.get("tool_calls") or []:
            tc_id = tc.get("id")
            if tc_id and tc_id not in existing_ids:
                needs_patch = True
                break
        if needs_patch:
            break

    if not needs_patch:
        return messages

    # Build patched list with synthetic tool-result messages
    patched: list[dict[str, Any]] = []
    patch_count = 0
    patched_ids: set[str] = set()
    for msg in messages:
        patched.append(msg)
        if msg.get("role") != "assistant":
            continue
        for tc in msg.get("tool_calls") or []:
            tc_id = tc.get("id")
            if tc_id and tc_id not in existing_ids and tc_id not in patched_ids:
                patched.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": "[Tool call was interrupted and did not return a result.]",
                })
                patched_ids.add(tc_id)
                patch_count += 1

    logger.warning(
        "Patched %d dangling tool call(s) with synthetic error responses",
        patch_count,
    )
    return patched


def sanitize_llm_messages_for_request(
    messages: list[dict[str, Any]],
    *,
    session_id: str,
    model_max_context: int | None = None,
) -> list[dict[str, Any]]:
    """Clamp oversized LLM request context to prevent single-turn explosions.

    When *model_max_context* is provided, the character budget scales with the
    model's actual context window (``tokens * 3.5`` as a rough chars-per-token
    estimate for mixed English/CJK content). Falls back to the hard-coded
    160 000 char limit if unknown.
    """
    # Fix dangling tool calls before any other processing
    messages = patch_dangling_tool_calls(messages)

    # Dynamic char budget based on model context window.
    #
    # The old implementation hard-capped large-context models at 500k chars.
    # For GPT-5.4-class 1M-token windows, that caused history to be silently
    # dropped long before reactive/full compaction could ever kick in.
    # Keep the fallback floor for unknown models, but let large-context models
    # use a proportionate budget so context can accumulate normally.
    if model_max_context:
        max_request_chars = max(
            _cfg().max_request_context_chars,
            int(model_max_context * 3.5),
        )
    else:
        max_request_chars = _cfg().max_request_context_chars  # 160k fallback

    sanitized: list[dict[str, Any]] = []

    for msg in messages:
        m = dict(msg)
        role = str(m.get("role", ""))
        content = m.get("content")
        if isinstance(content, str):
            if role == "tool":
                m["content"] = trim_for_context(
                    content, _cfg().max_tool_output_chars, "tool output"
                )
            elif role == "assistant":
                m["content"] = trim_for_context(
                    content, _cfg().max_assistant_content_chars, "assistant content"
                )
            elif role == "user" and len(content) > max_request_chars:
                # A single pasted wall of text should not evict the entire
                # previous conversation. Trim it to the model-scaled request
                # budget so earlier context still has a chance to survive.
                m["content"] = trim_for_context(
                    content, max_request_chars, "user content"
                )
        sanitized.append(m)

    total_chars = 0
    for m in sanitized:
        c = m.get("content")
        if isinstance(c, str):
            total_chars += len(c)

    if total_chars <= max_request_chars:
        return sanitized

    trimmed: list[dict[str, Any]] = []
    running = 0
    for m in reversed(sanitized):
        c = m.get("content")
        c_len = len(c) if isinstance(c, str) else 0
        if running + c_len <= max_request_chars:
            trimmed.append(m)
            running += c_len
            continue

        remaining = max_request_chars - running
        role = str(m.get("role", ""))
        kind = {
            "tool": "tool output",
            "assistant": "assistant content",
            "user": "user content",
        }.get(role, "message")

        if isinstance(c, str) and remaining >= MIN_PARTIAL_MESSAGE_CHARS:
            partial = dict(m)
            partial["content"] = trim_for_context(c, remaining, kind)
            trimmed.append(partial)
            running += len(partial["content"])
            continue

        if not trimmed:
            trimmed.append(m)
            running += c_len
            continue

        # Budget exhausted but older turns remain. Preserve the message
        # envelope (and any tool_calls) so conversation shape survives, but
        # collapse large string content to a tiny "truncated" marker rather
        # than silently dropping the turn.
        if isinstance(c, str) and c_len > MIN_PARTIAL_MESSAGE_CHARS:
            stub = dict(m)
            stub["content"] = (
                f"[{kind} truncated for context: original {c_len} chars, kept 0]"
            )
            trimmed.append(stub)
            running += len(stub["content"])
        else:
            trimmed.append(m)
            running += c_len
    trimmed.reverse()

    logger.warning(
        "Context hard-clamped for session %s: chars=%d -> %d, messages=%d -> %d (budget=%d)",
        session_id,
        total_chars,
        running,
        len(sanitized),
        len(trimmed),
        max_request_chars,
    )
    return trimmed


def strip_image_content(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove image_url entries from messages when the model doesn't support vision.

    Converts multimodal content arrays back to plain text strings.
    """
    result = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            text_parts = [
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            m = dict(msg)
            m["content"] = "\n".join(text_parts) if text_parts else "(image)"
            result.append(m)
        else:
            result.append(msg)
    return result


def estimate_llm_message_tokens(messages: list[dict[str, Any]]) -> int:
    total_chars = 0
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            total_chars += len(c)
        elif isinstance(c, list):
            for item in c:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        total_chars += len(str(item.get("text", "")))
                    elif item.get("type") == "image_url":
                        total_chars += IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN
    return max(1, total_chars // CHARS_PER_TOKEN)


def compute_safe_max_tokens(
    messages: list[dict[str, Any]],
    *,
    model_max_context: int,
    model_max_output: int | None,
) -> int:
    estimated_input = estimate_llm_message_tokens(messages)
    reserved = max(MIN_RESERVED_TOKENS, int(model_max_context * RESERVED_CONTEXT_RATIO))
    remaining = model_max_context - estimated_input - reserved

    hard_cap = model_max_output or _cfg().hard_max_output_tokens
    hard_cap = max(_cfg().min_output_tokens, min(hard_cap, _cfg().hard_max_output_tokens))

    if remaining <= _cfg().min_output_tokens:
        return _cfg().min_output_tokens
    return max(_cfg().min_output_tokens, min(hard_cap, remaining))


def repair_tool_call_payload(
    tool_name: str, tool_args: Any
) -> tuple[str, dict[str, Any]]:
    """Repair malformed tool-call payloads emitted by some models."""
    name = tool_name or ""
    args: Any = tool_args if tool_args is not None else {}

    if isinstance(args, list) and args and isinstance(args[0], dict):
        first = args[0]
        fn = first.get("function") if isinstance(first.get("function"), dict) else None
        if fn:
            if not name and isinstance(fn.get("name"), str):
                name = fn["name"]
            params = fn.get("parameters")
            if isinstance(params, dict):
                args = params

    if isinstance(args, dict) and isinstance(args.get("function"), dict):
        fn = args["function"]
        if not name and isinstance(fn.get("name"), str):
            name = fn["name"]
        params = fn.get("parameters")
        if isinstance(params, dict):
            args = params

    if isinstance(args, dict) and isinstance(args.get("parameters"), dict):
        args = args["parameters"]

    if not isinstance(args, dict):
        args = {"_raw": args}

    return name, args


def calculate_step_cost(
    usage_data: dict[str, Any],
    model_info: Any,
) -> float:
    """Calculate per-step USD cost from canonical token usage."""
    if not usage_data or not model_info or not model_info.pricing:
        return 0.0

    prompt_price = model_info.pricing.prompt or 0
    completion_price = model_info.pricing.completion or 0
    if prompt_price <= 0 and completion_price <= 0:
        return 0.0

    input_tokens = usage_data.get("input", 0)
    output_tokens = usage_data.get("output", 0)
    reasoning_tokens = usage_data.get("reasoning", 0)

    raw_cost = (
        input_tokens * prompt_price / 1_000_000
        + (output_tokens + reasoning_tokens) * completion_price / 1_000_000
    )
    return raw_cost
