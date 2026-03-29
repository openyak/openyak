"""LLM-based workspace memory refresh.

After each conversation, the current workspace memory is merged with
conversation history to produce an updated Markdown document.
"""

from __future__ import annotations

import logging
from typing import Any

from app.memory.workspace_memory_storage import MAX_WORKSPACE_MEMORY_LINES

logger = logging.getLogger(__name__)

WORKSPACE_MEMORY_UPDATE_PROMPT = """\
You are a workspace memory manager. Your job is to maintain a concise \
plain-text document that captures important context about this workspace/project.

You will receive:
1. The current workspace memory (may be empty for new workspaces)
2. A conversation that just happened in this workspace

Generate an UPDATED workspace memory that:
- Preserves important existing information that is still relevant
- Incorporates new insights, decisions, patterns, and context from the conversation
- Removes outdated or superseded information
- Stays within {max_lines} lines maximum
- Uses PURE PLAIN TEXT only — dashes for lists, blank lines for sections
- NEVER use any Markdown syntax: no # headings, no **bold**, no *italic*, no `code`, \
no ```code blocks```, no [links](url), no > blockquotes
- Focuses on information useful for FUTURE sessions: project structure, conventions, \
decisions made, ongoing tasks, known issues, user preferences for this project
- Does NOT include conversation-specific details (timestamps, "user asked about X")
- Does NOT include temporary debugging states or one-off commands

Current workspace memory:
<current-memory>
{current_memory}
</current-memory>

Conversation:
<conversation>
{conversation}
</conversation>

Respond with ONLY the new workspace memory content in pure plain text. \
No preamble, no explanation, no code fences, no Markdown formatting of any kind."""


def _extract_text_content(content: Any) -> str:
    """Extract text from message content (string or multimodal list)."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        # Multimodal content — extract text parts only
        texts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                texts.append(part.get("text", ""))
        return "\n".join(texts).strip()
    return ""


def format_conversation_for_workspace_update(messages: list[dict[str, Any]]) -> str:
    """Format LLM message history into a compact string for memory refresh.

    Only includes user and assistant text — strips tool calls and
    intermediate results to focus on meaningful content.
    """
    lines = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        text = _extract_text_content(content)
        if not text:
            continue

        if role == "user":
            lines.append(f"User: {text[:2000]}")
        elif role == "assistant":
            lines.append(f"Assistant: {text[:2000]}")

    return "\n\n".join(lines)


def parse_workspace_memory_response(response_text: str) -> str:
    """Parse the LLM response and enforce the line cap.

    Strips outer code fences if present and truncates to the max line limit.
    """
    text = response_text.strip()

    # Strip markdown code fences wrapping the entire output
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove opening fence (```markdown or ```)
        if lines:
            lines = lines[1:]
        # Remove closing fence
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    # Enforce line cap
    result_lines = text.split("\n")
    if len(result_lines) > MAX_WORKSPACE_MEMORY_LINES:
        result_lines = result_lines[:MAX_WORKSPACE_MEMORY_LINES]

    return "\n".join(result_lines)
