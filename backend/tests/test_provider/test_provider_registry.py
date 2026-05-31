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

class TestRefreshProvider:
    """Single-provider refresh — used by heal-on-read so we don't pay
    cross-provider /v1/models calls for one missing endpoint."""

    @pytest.mark.asyncio
    async def test_returns_empty_for_unknown_pid(self):
        reg = ProviderRegistry()
        result = await reg.refresh_provider("nope")
        assert result == []

    @pytest.mark.asyncio
    async def test_adds_models_for_freshly_registered(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [_model("m1", "p1")]))
        models = await reg.refresh_provider("p1")
        assert [m.id for m in models] == ["m1"]
        assert "m1" in reg._model_index
        assert reg._model_index["m1"][0].id == "p1"

    @pytest.mark.asyncio
    async def test_leaves_other_providers_alone(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [_model("m1", "p1")]))
        reg.register(_make_provider("p2", [_model("m2", "p2")]))
        await reg.refresh_models()

        # Re-refresh only p1 — p2's models must still be there. Capture
        # the call count to confirm p2 wasn't list_models'd again.
        p2 = reg.get_provider("p2")
        p2.list_models.reset_mock()  # type: ignore[union-attr]
        p2.clear_cache.reset_mock()  # type: ignore[union-attr]
        await reg.refresh_provider("p1")

        assert "m1" in reg._model_index
        assert "m2" in reg._model_index
        p2.list_models.assert_not_called()  # type: ignore[union-attr]
        p2.clear_cache.assert_not_called()  # type: ignore[union-attr]

    @pytest.mark.asyncio
    async def test_direct_beats_aggregator(self):
        """When a model id exists on both an aggregator and a direct
        provider, direct should win the index slot — and refresh_provider
        on the aggregator must not steal it back."""
        reg = ProviderRegistry()
        aggregator = _make_provider("openrouter", [_model("shared", "openrouter")])
        direct = _make_provider("openai", [_model("shared", "openai")])
        reg.register(aggregator)
        reg.register(direct)
        await reg.refresh_models()
        assert reg._model_index["shared"][0].id == "openai"

        # Refresh the aggregator alone — direct still wins.
        await reg.refresh_provider("openrouter")
        assert reg._model_index["shared"][0].id == "openai"

    @pytest.mark.asyncio
    async def test_falls_back_when_direct_drops_model(self):
        """If a direct provider stops exposing a model that an aggregator
        also serves, the index should fall back to the aggregator on the
        next refresh_provider call."""
        reg = ProviderRegistry()
        aggregator = _make_provider("openrouter", [_model("shared", "openrouter")])
        direct = _make_provider("openai", [_model("shared", "openai")])
        reg.register(aggregator)
        reg.register(direct)
        await reg.refresh_models()
        assert reg._model_index["shared"][0].id == "openai"

        # Direct drops the model on next refresh.
        direct.list_models = AsyncMock(return_value=[])  # type: ignore[union-attr]
        await reg.refresh_provider("openai")

        assert "shared" in reg._model_index
        assert reg._model_index["shared"][0].id == "openrouter"

    @pytest.mark.asyncio
    async def test_drops_removed_models(self):
        """A model the provider no longer exposes should vanish from the
        registry even if nothing else serves it."""
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [_model("m1", "p1"), _model("m2", "p1")]))
        await reg.refresh_models()
        assert {"m1", "m2"} <= set(reg._model_index.keys())

        p1 = reg.get_provider("p1")
        p1.list_models = AsyncMock(return_value=[_model("m1", "p1")])  # type: ignore[union-attr]
        await reg.refresh_provider("p1")

        assert "m1" in reg._model_index
        assert "m2" not in reg._model_index
        # _full_models should also be cleaned up
        assert not any(m.id == "m2" for _, m in reg._full_models)

    @pytest.mark.asyncio
    async def test_swallows_provider_failure(self):
        """If list_models raises, refresh_provider returns [] and logs;
        existing index entries for that provider should remain untouched
        — we don't have a better state to fall back to."""
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [_model("m1", "p1")]))
        await reg.refresh_models()
        assert "m1" in reg._model_index

        p1 = reg.get_provider("p1")
        p1.list_models = AsyncMock(side_effect=RuntimeError("network down"))  # type: ignore[union-attr]
        result = await reg.refresh_provider("p1")

        assert result == []
        # Pre-existing index entry should still be there since the
        # refresh failed before we mutated anything.
        assert "m1" in reg._model_index


class TestVisionPromotion:
    """The registry promotes vision-capable models whose provider reported
    vision=False (missing/stale upstream metadata) via the curated allowlist."""

    def _vision_model(self, mid: str, vision: bool) -> ModelInfo:
        return ModelInfo(
            id=mid,
            name=mid,
            provider_id="p1",
            capabilities=ModelCapabilities(vision=vision),
        )

    @pytest.mark.asyncio
    async def test_promotes_false_negative(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [self._vision_model("gpt-4o", vision=False)]))
        await reg.refresh_models()
        resolved = reg.resolve_model("gpt-4o")
        assert resolved is not None
        assert resolved[1].capabilities.vision is True

    @pytest.mark.asyncio
    async def test_leaves_text_model_alone(self):
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [self._vision_model("gpt-3.5-turbo", vision=False)]))
        await reg.refresh_models()
        resolved = reg.resolve_model("gpt-3.5-turbo")
        assert resolved is not None
        assert resolved[1].capabilities.vision is False

    @pytest.mark.asyncio
    async def test_never_downgrades(self):
        # A provider that already reports vision=True on something the allowlist
        # would not match must keep it — promotion is additive only.
        reg = ProviderRegistry()
        reg.register(_make_provider("p1", [self._vision_model("some-private-vlm", vision=True)]))
        await reg.refresh_models()
        resolved = reg.resolve_model("some-private-vlm")
        assert resolved is not None
        assert resolved[1].capabilities.vision is True


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
