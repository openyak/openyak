"""Live evaluation providers configured without persisting credentials."""

from __future__ import annotations

import os
import json
from collections.abc import AsyncIterator
from typing import Any

from app.provider.base import BaseProvider
from app.provider.generic_openai import GenericOpenAIProvider
from app.provider.ollama import OllamaProvider
from app.provider.tool_calling.prompt_based import convert_to_stream_chunks
from app.schemas.provider import ModelInfo, ProviderStatus, StreamChunk


REALROUTER_BASE_URL = "https://api.realrouter.org/v1"
REALROUTER_KEY_ENV = "REALROUTER_API_KEY"
REALROUTER_BASE_URL_ENV = "REALROUTER_BASE_URL"
OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL"


class PromptToolCallingProvider(BaseProvider):
    """Eval-only adapter that exercises prompt-tag tool calling end to end."""

    tool_call_mode = "prompt"

    def __init__(self, delegate: BaseProvider) -> None:
        self.delegate = delegate

    @property
    def id(self) -> str:
        return self.delegate.id

    async def list_models(self) -> list[ModelInfo]:
        return await self.delegate.list_models()

    async def health_check(self) -> ProviderStatus:
        return await self.delegate.health_check()

    async def stream_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        system: str | list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamChunk]:
        prompt = _prompt_tool_contract(tools or [])
        if isinstance(system, list):
            adapted_system: str | list[dict[str, Any]] = [
                *system,
                {"type": "text", "text": prompt},
            ]
        else:
            adapted_system = f"{system or ''}\n\n{prompt}".strip()

        text_parts: list[str] = []
        finish_data: dict[str, Any] = {"reason": "stop"}
        async for chunk in self.delegate.stream_chat(
            model,
            messages,
            tools=None,
            system=adapted_system,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_body=extra_body,
            response_format=response_format,
        ):
            if chunk.type == "text-delta":
                text_parts.append(str(chunk.data.get("text", "")))
            elif chunk.type == "finish":
                finish_data = dict(chunk.data)
            else:
                yield chunk

        normalized = convert_to_stream_chunks("".join(text_parts))
        for chunk in normalized:
            yield chunk
        if any(chunk.type == "tool-call" for chunk in normalized):
            finish_data["reason"] = "tool_use"
        yield StreamChunk(type="finish", data=finish_data)


def _prompt_tool_contract(tools: list[dict[str, Any]]) -> str:
    return (
        "# Available tools\n"
        "Call tools only with this exact envelope:\n"
        '<tool_call>{"name":"tool_name","arguments":{}}</tool_call>\n'
        "Tool definitions:\n"
        f"{json.dumps(tools, sort_keys=True)}"
    )


def create_realrouter_provider(model_id: str) -> GenericOpenAIProvider:
    """Create a production OpenAI-compatible provider from an environment key."""
    api_key = os.environ.get(REALROUTER_KEY_ENV, "")
    if not api_key:
        raise ValueError(
            f"Set {REALROUTER_KEY_ENV} to a newly created key before running live evaluations"
        )
    return GenericOpenAIProvider(
        api_key=api_key,
        provider_id="realrouter",
        base_url=os.environ.get(REALROUTER_BASE_URL_ENV, REALROUTER_BASE_URL),
        kind="openai_compat_custom",
        models_override=[{"id": model_id, "name": model_id}],
    )


class EvaluationOllamaProvider(OllamaProvider):
    """Expose one requested local model for an apples-to-apples eval run."""

    def __init__(self, model_id: str, *, base_url: str) -> None:
        super().__init__(base_url=base_url)
        self.requested_model = (
            model_id if model_id.startswith("ollama/") else f"ollama/{model_id}"
        )

    async def list_models(self) -> list[ModelInfo]:
        models = await super().list_models()
        selected = [model for model in models if model.id == self.requested_model]
        if not selected:
            available = ", ".join(model.id for model in models) or "none"
            raise ValueError(
                f"Ollama model {self.requested_model!r} is not installed; "
                f"available: {available}"
            )
        return selected


def create_ollama_provider(model_id: str) -> EvaluationOllamaProvider:
    """Create a local provider constrained to one benchmark model."""
    return EvaluationOllamaProvider(
        model_id,
        base_url=os.environ.get(OLLAMA_BASE_URL_ENV, "http://localhost:11434"),
    )
