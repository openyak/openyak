"""Tests for the Rapid-MLX provider adapter."""

from __future__ import annotations

import pytest

from app.provider.rapid_mlx import RapidMLXProvider


class _FailingModels:
    async def list(self):
        raise RuntimeError("server is still starting")


class _Client:
    models = _FailingModels()


@pytest.mark.asyncio
async def test_rapid_mlx_falls_back_to_default_model():
    provider = RapidMLXProvider()
    provider._client = _Client()

    models = await provider.list_models()

    assert len(models) == 1
    assert models[0].id == "rapid-mlx/default"
    assert models[0].provider_id == "rapid-mlx"
    assert models[0].pricing.prompt == 0
    assert models[0].capabilities.function_calling is True
    assert models[0].capabilities.prompt_caching is True
