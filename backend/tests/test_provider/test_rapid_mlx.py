"""Tests for the Rapid-MLX provider adapter."""

from __future__ import annotations

import pytest

from app.provider.rapid_mlx import RapidMLXProvider


class _FailingModels:
    async def list(self):
        raise RuntimeError("server is still starting")


class _Client:
    models = _FailingModels()


class _ModelItem:
    def __init__(self, model_id: str):
        self.id = model_id


class _Models:
    async def list(self):
        return type(
            "ModelList",
            (),
            {"data": [_ModelItem("qwen3-vl-4b"), _ModelItem("qwen3.5-9b")]},
        )()


class _ModelsClient:
    models = _Models()


@pytest.mark.asyncio
async def test_rapid_mlx_returns_no_models_when_runtime_is_unavailable():
    provider = RapidMLXProvider()
    provider._client = _Client()

    models = await provider.list_models()

    assert models == []


@pytest.mark.asyncio
async def test_rapid_mlx_marks_known_vision_models():
    provider = RapidMLXProvider()
    provider._client = _ModelsClient()

    models = await provider.list_models()
    by_id = {model.id: model for model in models}

    assert by_id["rapid-mlx/qwen3-vl-4b"].capabilities.vision is True
    assert by_id["rapid-mlx/qwen3.5-9b"].capabilities.vision is False


@pytest.mark.asyncio
async def test_rapid_mlx_maps_legacy_default_model(monkeypatch):
    provider = RapidMLXProvider()
    chunks = []

    async def fake_stream(self, model, messages, **kwargs):
        chunks.append((model, messages, kwargs))
        if False:
            yield None

    monkeypatch.setattr("app.provider.openai_compat.OpenAICompatProvider.stream_chat", fake_stream)

    async for _ in provider.stream_chat("rapid-mlx/default", [{"role": "user", "content": "hi"}]):
        pass

    assert chunks[0][0] == "qwen3.5-4b"
