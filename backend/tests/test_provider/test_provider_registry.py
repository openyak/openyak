"""Tests for ProviderRegistry."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, PropertyMock

import pytest

import app.provider.registry as registry_module
from app.provider.registry import ProviderRegistry
from app.schemas.provider import ModelCapabilities, ModelInfo, ProviderStatus


def _make_provider(pid: str, models: list[ModelInfo] | None = None):
    p = MagicMock()
    type(p).id = PropertyMock(return_value=pid)
    p.list_models = AsyncMock(return_value=models or [])
    p.clear_cache = MagicMock()
    p.health_check = AsyncMock(return_value=ProviderStatus(status="connected", model_count=len(models or [])))
    return p


def _model(mid: str, pid: str = "p1") -> ModelInfo:
    return ModelInfo(id=mid, name=mid, provider_id=pid, capabilities=ModelCapabilities())


class TestRegisterUnregister:
    def test_register(self):
        reg = ProviderRegistry()
        p = _make_provider("p1")
        reg.register(p)
        assert reg.get_provider("p1") is p

    def test_unregister(self):
        reg = ProviderRegistry()
        p = _make_provider("p1")
        reg.register(p)
        reg.unregister("p1")
        assert reg.get_provider("p1") is None

    @pytest.mark.asyncio
    async def test_unregister_clears_models(self):
        reg = ProviderRegistry()
        p = _make_provider("p1", [_model("m1", "p1")])
        reg.register(p)
        await reg.refresh_models()
        assert len(reg.all_models()) == 1
        reg.unregister("p1")
        assert len(reg.all_models()) == 0


class TestRefreshModels:
    @pytest.mark.asyncio
    async def test_success(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [_model("m1"), _model("m2")]))
        result = await reg.refresh_models()
        assert len(result["p1"]) == 2
        assert len(reg.all_models()) == 2

    @pytest.mark.asyncio
    async def test_partial_failure(self):
        reg = ProviderRegistry()
        good = _make_provider("good", [_model("m1")])
        bad = _make_provider("bad")
        bad.list_models = AsyncMock(side_effect=RuntimeError("down"))
        reg.register(good)
        reg.register(bad)
        result = await reg.refresh_models()
        assert len(result["good"]) == 1
        assert result["bad"] == []
        assert len(reg.all_models()) == 1

    @pytest.mark.asyncio
    async def test_all_fail_raises(self):
        reg = ProviderRegistry()
        bad = _make_provider("bad")
        bad.list_models = AsyncMock(side_effect=RuntimeError("down"))
        reg.register(bad)
        with pytest.raises(RuntimeError, match="down"):
            await reg.refresh_models()

    @pytest.mark.asyncio
    async def test_provider_timeout_does_not_block_successes(self, monkeypatch):
        monkeypatch.setattr(registry_module, "MODEL_REFRESH_TIMEOUT_SECONDS", 0.01)

        async def slow_models():
            await asyncio.sleep(1)
            return [_model("slow")]

        reg = ProviderRegistry()
        good = _make_provider("good", [_model("m1")])
        slow = _make_provider("slow")
        slow.list_models = AsyncMock(side_effect=slow_models)
        reg.register(good)
        reg.register(slow)

        result = await reg.refresh_models()

        assert len(result["good"]) == 1
        assert result["slow"] == []
        assert len(reg.all_models()) == 1

class TestResolveModel:
    @pytest.mark.asyncio
    async def test_existing(self):
        reg = ProviderRegistry()
        p = _make_provider("p1", [_model("m1")])
        reg.register(p)
        await reg.refresh_models()
        result = reg.resolve_model("m1")
        assert result is not None
        assert result[1].id == "m1"

    @pytest.mark.asyncio
    async def test_missing(self):
        reg = ProviderRegistry()
        assert reg.resolve_model("nope") is None


class TestHealth:
    @pytest.mark.asyncio
    async def test_aggregation(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1"))
        reg.register(_make_provider("p2"))
        health = await reg.health()
        assert len(health) == 2
        assert all(v.status == "connected" for v in health.values())
