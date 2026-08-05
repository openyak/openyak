"""LLM streaming bridge.

Handles:
  - System prompt assembly
  - Tool spec resolution
  - Provider streaming call
  - Reasoning token passthrough
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.provider.base import BaseProvider
from app.schemas.agent import AgentInfo
from app.schemas.agent import Ruleset
from app.schemas.provider import StreamChunk
from app.tool.registry import ToolRegistry


async def stream_llm(
    provider: BaseProvider,
    model_id: str,
    messages: list[dict[str, Any]],
    *,
    system_prompt: str | list[dict[str, Any]],
    agent: AgentInfo,
    tool_registry: ToolRegistry,
    extra_body: dict[str, Any] | None = None,
    max_tokens: int | None = None,
    exclude_tools: set[str] | None = None,
    discovered_tools: set[str] | None = None,
    permission_ruleset: Ruleset | None = None,
    response_format: dict[str, Any] | None = None,
) -> AsyncIterator[StreamChunk]:
    """Unified LLM streaming call.

    Assembles system prompt, resolves tools, and calls provider.
    When response_format is set (e.g. json_schema), tools are disabled —
    most providers do not support both simultaneously.
    """
    # Resolve tool specs for this agent; disable when structured output is requested
    tool_specs = None if response_format else tool_registry.to_openai_specs(
        agent,
        extra_ruleset=permission_ruleset,
        exclude=exclude_tools,
        discovered=discovered_tools,
    )

    async for chunk in provider.stream_chat(
        model_id,
        messages,
        system=system_prompt,
        tools=tool_specs if tool_specs else None,
        temperature=agent.temperature,
        max_tokens=max_tokens,
        extra_body=extra_body,
        response_format=response_format,
    ):
        yield chunk
