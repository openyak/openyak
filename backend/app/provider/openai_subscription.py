"""OpenAI Subscription provider — uses ChatGPT Plus/Pro/Team subscription via WHAM API.

Translates between OpenAI Chat Completions format (used internally by OpenYak)
and the WHAM Responses API (https://chatgpt.com/backend-api/codex/responses).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator

import httpx

from app.config import get_settings
from app.provider.base import BaseProvider
from app.schemas.provider import (
    ModelCapabilities,
    ModelInfo,
    ModelPricing,
    ProviderStatus,
    StreamChunk,
)

logger = logging.getLogger(__name__)

WHAM_BASE_URL = "https://chatgpt.com/backend-api/codex"
PROVIDER_ID = "openai-subscription"

# Curated models available through ChatGPT subscription
_SUBSCRIPTION_MODELS: list[dict[str, Any]] = [
    {
        "id": "gpt-5.5",
        "name": "GPT-5.5",
        "capabilities": {
            "function_calling": True,
            "vision": True,
            "reasoning": True,
            "json_output": True,
            "max_context": 1_050_000,
            "max_output": 128_000,
        },
    },
    {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "capabilities": {
            "function_calling": True,
            "vision": True,
            "reasoning": True,
            "json_output": True,
            "max_context": 1_050_000,
            "max_output": 128_000,
        },
    },
]


class OpenAISubscriptionProvider(BaseProvider):
    """Provider that uses a ChatGPT subscription via the WHAM Responses API."""

    def __init__(
        self,
        access_token: str,
        account_id: str,
        refresh_token: str = "",
        expires_at_ms: int = 0,
        settings: Any | None = None,
    ):
        self._access_token = access_token
        self._account_id = account_id
        self._refresh_token = refresh_token
        self._expires_at_ms = expires_at_ms
        self._settings = settings
        self._refresh_lock = asyncio.Lock()
        self._needs_reauth: bool = False

    @property
    def id(self) -> str:
        return PROVIDER_ID

    def update_tokens(
        self,
        access_token: str,
        refresh_token: str = "",
        expires_at_ms: int = 0,
    ) -> None:
        """Hot-swap tokens after a refresh."""
        self._access_token = access_token
        if refresh_token:
            self._refresh_token = refresh_token
        if expires_at_ms:
            self._expires_at_ms = expires_at_ms

    async def _do_refresh(self) -> None:
        """Perform the actual token refresh. Must be called under self._refresh_lock."""
        from app.provider.openai_oauth import refresh_access_token
        from app.api.config import _update_env_file

        logger.info("OpenAI subscription token refreshing...")
        try:
            tokens = await refresh_access_token(self._refresh_token)
        except Exception as e:
            logger.error("Token refresh failed: %s", e)
            self._needs_reauth = True
            raise

        new_expires_at = int(time.time() * 1000) + tokens.get("expires_in", 3600) * 1000

        self._access_token = tokens["access_token"]
        if tokens.get("refresh_token"):
            self._refresh_token = tokens["refresh_token"]
        self._expires_at_ms = new_expires_at
        self._needs_reauth = False

        # Persist updated tokens to .env
        _update_env_file("OPENYAK_OPENAI_OAUTH_ACCESS_TOKEN", self._access_token)
        if tokens.get("refresh_token"):
            _update_env_file("OPENYAK_OPENAI_OAUTH_REFRESH_TOKEN", self._refresh_token)
        _update_env_file("OPENYAK_OPENAI_OAUTH_EXPIRES_AT", str(new_expires_at))

        # Sync runtime settings if available
        if self._settings is not None:
            self._settings.openai_oauth_access_token = self._access_token
            self._settings.openai_oauth_refresh_token = self._refresh_token
            self._settings.openai_oauth_expires_at = new_expires_at

        logger.info("OpenAI subscription token refreshed successfully")

    async def _ensure_valid_token(self) -> None:
        """Proactively refresh the access token if it's about to expire (<5 min).

        Uses double-checked locking to avoid concurrent refreshes.
        """
        from app.provider.openai_oauth import is_token_expired

        if not self._refresh_token or not self._expires_at_ms:
            return
        if not is_token_expired(self._expires_at_ms):
            return
        async with self._refresh_lock:
            # Double-check: another coroutine may have refreshed while we waited
            if not is_token_expired(self._expires_at_ms):
                return
            await self._do_refresh()

    async def list_models(self) -> list[ModelInfo]:
        """Return curated list of subscription models."""
        return [
            ModelInfo(
                id=f"{PROVIDER_ID}/{m['id']}",
                name=m["name"],
                provider_id=PROVIDER_ID,
                capabilities=ModelCapabilities(**m["capabilities"]),
                pricing=ModelPricing(prompt=0.0, completion=0.0),
                metadata=dict(m.get("metadata", {})),
            )
            for m in _SUBSCRIPTION_MODELS
        ]

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
        """Stream chat via WHAM Responses API, translating to/from Chat Completions format."""
        await self._ensure_valid_token()

        # Strip provider prefix from model ID
        raw_model = model.removeprefix(f"{PROVIDER_ID}/")

        # Build WHAM request body
        wham_body = self._build_wham_request(
            model=raw_model,
            messages=messages,
            system=system,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        headers = {
            "Authorization": f"Bearer {self._access_token}",
            "ChatGPT-Account-Id": self._account_id,
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                async with client.stream(
                    "POST",
                    f"{WHAM_BASE_URL}/responses",
                    json=wham_body,
                    headers=headers,
                ) as response:
                    if response.status_code == 401:
                        # Token expired — try one refresh and retry
                        logger.warning("WHAM API returned 401, attempting token refresh")
                        try:
                            async with self._refresh_lock:
                                await self._do_refresh()
                            headers["Authorization"] = f"Bearer {self._access_token}"
                        except Exception:
                            yield StreamChunk(type="error", data={"message": "Authentication failed. Please re-authorize your ChatGPT subscription.", "code": "needs_reauth"})
                            return

                        # Retry with new token
                        async with client.stream(
                            "POST",
                            f"{WHAM_BASE_URL}/responses",
                            json=wham_body,
                            headers=headers,
                        ) as retry_response:
                            if retry_response.status_code != 200:
                                text = (await retry_response.aread()).decode()
                                yield StreamChunk(type="error", data={"message": f"WHAM API error after refresh: {retry_response.status_code} — {text[:200]}"})
                                return
                            async for chunk in self._parse_wham_stream(retry_response):
                                yield chunk
                        return

                    if response.status_code != 200:
                        text = (await response.aread()).decode()
                        yield StreamChunk(type="error", data={"message": f"WHAM API error: {response.status_code} — {text[:200]}"})
                        return

                    async for chunk in self._parse_wham_stream(response):
                        yield chunk

        except Exception as e:
            logger.error("OpenAI subscription stream error: %s", e)
            yield StreamChunk(type="error", data={"message": str(e)})

    def _build_wham_request(
        self,
        model: str,
        messages: list[dict[str, Any]],
        system: str | list[dict[str, Any]] | None = None,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Translate Chat Completions format to WHAM Responses format."""
        body: dict[str, Any] = {
            "model": model,
            "store": False,
            "stream": True,
        }

        # System message → instructions
        if system:
            if isinstance(system, str):
                body["instructions"] = system
            elif isinstance(system, list):
                # Extract text from content blocks
                texts = []
                for block in system:
                    if isinstance(block, dict) and block.get("type") == "text":
                        texts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        texts.append(block)
                body["instructions"] = "\n".join(texts)

        # Also check for system messages in the messages list
        # Track native web_search call IDs to skip their results in history
        native_ws_call_ids: set[str] = set()

        wham_input: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                # Move to instructions (append if already set)
                text = content if isinstance(content, str) else json.dumps(content)
                if "instructions" in body:
                    body["instructions"] += "\n" + text
                else:
                    body["instructions"] = text
                continue

            if role == "user":
                wham_input.append({
                    "role": "user",
                    "content": self._translate_content(content),
                })

            elif role == "assistant":
                assistant_item: dict[str, Any] = {"role": "assistant"}
                # Handle tool_calls in assistant messages
                tool_calls = msg.get("tool_calls", [])
                if tool_calls:
                    # Convert to function_call output items
                    for tc in tool_calls:
                        func = tc.get("function", {})
                        # Skip native web_search calls — handled server-side by WHAM
                        if func.get("name") == "web_search":
                            native_ws_call_ids.add(tc.get("id", ""))
                            continue
                        wham_input.append({
                            "type": "function_call",
                            "id": tc.get("id", ""),
                            "call_id": tc.get("id", ""),
                            "name": func.get("name", ""),
                            "arguments": func.get("arguments", "{}"),
                        })
                elif content:
                    assistant_item["content"] = self._translate_content(content)
                    wham_input.append(assistant_item)

            elif role == "tool":
                # Skip results for native web_search calls
                if msg.get("tool_call_id", "") in native_ws_call_ids:
                    continue
                # Tool result → function_call_output
                wham_input.append({
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id", ""),
                    "output": self._translate_content(content),
                })

        body["input"] = wham_input

        # Enable reasoning summary so the API returns thinking content in the stream
        body["reasoning"] = {"effort": "medium", "summary": "auto"}

        if tools:
            wham_tools = self._translate_tools(tools)
            # Add native web search (replaces custom web_search tool)
            wham_tools.append({
                "type": "web_search",
                "search_context_size": get_settings().web_search_context_size,
            })
            body["tools"] = wham_tools
            # Include sources in web search results
            body["include"] = ["web_search_call.action.sources"]

        if temperature is not None:
            body["temperature"] = temperature

        return body

    def _translate_content(self, content: Any) -> list[dict[str, Any]] | str:
        """Translate message content to WHAM format."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            wham_parts = []
            for part in content:
                if isinstance(part, dict):
                    if part.get("type") == "text":
                        wham_parts.append({
                            "type": "input_text",
                            "text": part.get("text", ""),
                        })
                    elif part.get("type") == "image_url":
                        wham_parts.append({
                            "type": "input_image",
                            "image_url": part.get("image_url", {}).get("url", ""),
                        })
                    else:
                        wham_parts.append(part)
            return wham_parts
        return str(content)

    def _translate_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Translate Chat Completions tool definitions to WHAM format."""
        wham_tools = []
        for tool in tools:
            if tool.get("type") == "function":
                func = tool.get("function", {})
                wham_tools.append({
                    "type": "function",
                    "name": func.get("name", ""),
                    "description": func.get("description", ""),
                    "parameters": func.get("parameters", {}),
                })
        return wham_tools

    async def _parse_wham_stream(self, response: httpx.Response) -> AsyncIterator[StreamChunk]:
        """Parse WHAM SSE stream and yield StreamChunks."""
        tool_call_accumulators: dict[str, dict[str, Any]] = {}
        web_search_calls: dict[str, dict[str, Any]] = {}

        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue

            data_str = line[6:]
            if data_str == "[DONE]":
                break

            try:
                event = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")

            # Text output delta
            if event_type == "response.output_text.delta":
                text = event.get("delta", "")
                if text:
                    yield StreamChunk(type="text-delta", data={"text": text})

            # Reasoning/thinking delta (Responses API reasoning summary)
            elif event_type == "response.reasoning_summary_text.delta":
                text = event.get("delta", "")
                if text:
                    yield StreamChunk(type="reasoning-delta", data={"text": text})

            # Function call arguments delta
            elif event_type == "response.function_call_arguments.delta":
                item_id = event.get("item_id", "")
                delta = event.get("delta", "")
                if item_id not in tool_call_accumulators:
                    tool_call_accumulators[item_id] = {
                        "id": item_id,
                        "name": "",
                        "arguments": "",
                    }
                tool_call_accumulators[item_id]["arguments"] += delta

            # Function call arguments done
            elif event_type == "response.function_call_arguments.done":
                item_id = event.get("item_id", "")
                if item_id in tool_call_accumulators:
                    acc = tool_call_accumulators.pop(item_id)
                    try:
                        args = json.loads(acc["arguments"]) if acc["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {"_raw": acc["arguments"]}
                    yield StreamChunk(
                        type="tool-call",
                        data={
                            "id": acc["id"],
                            "name": acc["name"],
                            "arguments": args,
                        },
                    )

            # Output item added — capture function call name or web search
            elif event_type == "response.output_item.added":
                item = event.get("item", {})
                if item.get("type") == "function_call":
                    item_id = item.get("id", "")
                    tool_call_accumulators[item_id] = {
                        "id": item_id,
                        "call_id": item.get("call_id", item_id),
                        "name": item.get("name", ""),
                        "arguments": "",
                    }
                elif item.get("type") == "web_search_call":
                    item_id = item.get("id", "")
                    action = item.get("action") or {}
                    query = action.get("query", "")
                    web_search_calls[item_id] = {
                        "id": item_id,
                        "query": query,
                        "status": item.get("status", "searching"),
                    }
                    # Emit start event so frontend shows "searching..." state
                    yield StreamChunk(
                        type="web-search-start",
                        data={"id": item_id, "query": query},
                    )

            # Output item done — handle completed web search
            elif event_type == "response.output_item.done":
                item = event.get("item", {})
                if item.get("type") == "web_search_call":
                    item_id = item.get("id", "")
                    action = item.get("action") or {}
                    query = action.get("query", "")
                    if not query and item_id in web_search_calls:
                        query = web_search_calls[item_id].get("query", "")
                    # Extract sources from action.sources (populated via include directive)
                    results = _extract_web_search_results(action)
                    yield StreamChunk(
                        type="web-search-result",
                        data={
                            "id": item_id,
                            "query": query,
                            "results": results,
                        },
                    )
                    web_search_calls.pop(item_id, None)

            # Response completed
            elif event_type == "response.completed":
                resp = event.get("response", {})
                usage_data = resp.get("usage", {})

                # Emit any remaining tool calls
                for acc in tool_call_accumulators.values():
                    try:
                        args = json.loads(acc["arguments"]) if acc["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {"_raw": acc["arguments"]}
                    yield StreamChunk(
                        type="tool-call",
                        data={
                            "id": acc["id"],
                            "name": acc["name"],
                            "arguments": args,
                        },
                    )
                tool_call_accumulators.clear()

                # Determine finish reason
                status = resp.get("status", "completed")
                finish_reason = "stop"
                if status == "incomplete":
                    finish_reason = resp.get("incomplete_details", {}).get("reason", "length")

                # Check if any output item is a function_call
                for item in resp.get("output", []):
                    if item.get("type") == "function_call":
                        finish_reason = "tool_calls"
                        break

                yield StreamChunk(type="finish", data={"reason": finish_reason})

                # Usage
                if usage_data:
                    output_details = usage_data.get("output_tokens_details", {})
                    reasoning_tokens = output_details.get("reasoning_tokens", 0)
                    yield StreamChunk(
                        type="usage",
                        data={
                            "input": usage_data.get("input_tokens", 0),
                            "output": usage_data.get("output_tokens", 0),
                            "reasoning": reasoning_tokens,
                            "cache_read": 0,
                            "cache_write": 0,
                            "total": usage_data.get("total_tokens", 0),
                        },
                    )

            # Error
            elif event_type == "error":
                error_msg = event.get("error", {})
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("message", str(error_msg))
                yield StreamChunk(type="error", data={"message": str(error_msg)})

    async def health_check(self) -> ProviderStatus:
        """Check if the subscription is active by verifying the token."""
        if not self._access_token or not self._account_id:
            return ProviderStatus(status="unconfigured")

        try:
            models = await self.list_models()
            return ProviderStatus(status="connected", model_count=len(models))
        except Exception as e:
            return ProviderStatus(status="error", error=str(e))


_MAX_SOURCES_PER_SEARCH = 10  # cap per individual native web search call


def _extract_web_search_results(action: dict[str, Any]) -> list[dict[str, str]]:
    """Extract search results from a web_search_call action (with sources via include)."""
    results = []
    # Sources are populated via the "include": ["web_search_call.action.sources"] directive
    for r in action.get("sources", [])[:_MAX_SOURCES_PER_SEARCH]:
        results.append({
            "url": r.get("url", ""),
            "title": r.get("title", ""),
            "snippet": r.get("snippet", r.get("quote", "")),
        })
    return results
