"""OpenRouter provider tests (live API calls).

These tests require a valid OPENYAK_OPENROUTER_API_KEY in .env.
"""

import pytest

from app.provider.openrouter import OpenRouterProvider
from app.provider.registry import ProviderRegistry
from app.provider.tool_calling.detector import supports_function_calling
from app.provider.tool_calling.prompt_based import build_tool_prompt, parse_tool_calls


class TestOpenRouterConnection:
    """Tests that hit the real OpenRouter API."""

    @pytest.mark.asyncio
    async def test_list_models(self, api_key: str):
        provider = OpenRouterProvider(api_key)
        models = await provider.list_models()
        assert len(models) > 0
        # Verify model structure
        m = models[0]
        assert m.id
        assert m.name
        assert m.provider_id == "openrouter"

    @pytest.mark.asyncio
    async def test_health_check(self, api_key: str):
        provider = OpenRouterProvider(api_key)
        status = await provider.health_check()
        assert status.status == "connected"
        assert status.model_count > 0

    @pytest.mark.asyncio
    async def test_simple_stream(self, api_key: str):
        provider = OpenRouterProvider(api_key, enable_reasoning=False)
        messages = [{"role": "user", "content": "Say exactly: hello"}]

        chunks = []
        async for chunk in provider.stream_chat(
            "z-ai/glm-4.7-flash",
            messages,
            system="Respond with the exact word requested.",
        ):
            chunks.append(chunk)

        types = {c.type for c in chunks}
        assert "text-delta" in types
        # Should have at least one text chunk and a finish
        text = "".join(c.data.get("text", "") for c in chunks if c.type == "text-delta")
        assert len(text) > 0

    @pytest.mark.asyncio
    async def test_stream_with_tools(self, api_key: str):
        """Test that the model can generate tool calls."""
        provider = OpenRouterProvider(api_key, enable_reasoning=False)
        messages = [{"role": "user", "content": "Read the file at /tmp/test.txt"}]

        tools = [{
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Path to file"},
                    },
                    "required": ["file_path"],
                },
            },
        }]

        chunks = []
        async for chunk in provider.stream_chat(
            "z-ai/glm-4.7-flash",
            messages,
            tools=tools,
            system="Use the read tool to read files when asked.",
        ):
            chunks.append(chunk)

        types = {c.type for c in chunks}
        # Model should call the read tool
        assert "tool-call" in types, f"Expected tool-call, got types: {types}"
        tool_call = next(c for c in chunks if c.type == "tool-call")
        assert tool_call.data["name"] == "read"
        assert "file_path" in tool_call.data["arguments"]


class TestProviderRegistry:
    @pytest.mark.asyncio
    async def test_registry_refresh(self, api_key: str):
        registry = ProviderRegistry()
        provider = OpenRouterProvider(api_key)
        registry.register(provider)

        result = await registry.refresh_models()
        assert "openrouter" in result
        assert len(result["openrouter"]) > 0

    @pytest.mark.asyncio
    async def test_resolve_model(self, api_key: str):
        registry = ProviderRegistry()
        provider = OpenRouterProvider(api_key)
        registry.register(provider)
        await registry.refresh_models()

        resolved = registry.resolve_model("z-ai/glm-4.7-flash")
        assert resolved is not None
        prov, info = resolved
        assert info.id == "z-ai/glm-4.7-flash"

    @pytest.mark.asyncio
    async def test_health(self, api_key: str):
        registry = ProviderRegistry()
        provider = OpenRouterProvider(api_key)
        registry.register(provider)

        health = await registry.health()
        assert "openrouter" in health
        assert health["openrouter"].status == "connected"


class TestToolCallingDetector:
    def test_glm5_supported(self):
        from app.schemas.provider import ModelInfo, ModelCapabilities
        m = ModelInfo(
            id="z-ai/glm-5", name="GLM-5", provider_id="openrouter",
            capabilities=ModelCapabilities(function_calling=True),
        )
        assert supports_function_calling(m) is True

    def test_tinyllama_not_supported(self):
        from app.schemas.provider import ModelInfo
        m = ModelInfo(id="custom/tinyllama-1b", name="TinyLlama", provider_id="openrouter")
        assert supports_function_calling(m) is False

    def test_unknown_defaults_false(self):
        from app.schemas.provider import ModelInfo
        m = ModelInfo(id="unknown/custom-model", name="Custom", provider_id="openrouter")
        assert supports_function_calling(m) is False


class TestPromptBasedToolCalling:
    def test_parse_tool_call(self):
        text = 'Let me read that.\n<tool_call>\n{"name": "read", "arguments": {"file_path": "x.py"}}\n</tool_call>\nDone.'
        clean, calls = parse_tool_calls(text)
        assert len(calls) == 1
        assert calls[0]["name"] == "read"
        assert calls[0]["arguments"]["file_path"] == "x.py"
        assert "<tool_call>" not in clean

    def test_multiple_tool_calls(self):
        text = '<tool_call>\n{"name": "glob", "arguments": {"pattern": "*.py"}}\n</tool_call>\n<tool_call>\n{"name": "read", "arguments": {"file_path": "a.py"}}\n</tool_call>'
        _, calls = parse_tool_calls(text)
        assert len(calls) == 2

    def test_no_tool_calls(self):
        text = "Just some regular text."
        clean, calls = parse_tool_calls(text)
        assert len(calls) == 0
        assert clean == text

    def test_build_tool_prompt(self):
        from app.tool.builtin.read import ReadTool
        prompt = build_tool_prompt([ReadTool()])
        assert "read" in prompt
        assert "file_path" in prompt
        assert "<tool_call>" in prompt
