import os

import pytest

from app.provider.atlas_models import ATLAS_VALIDATED_MODELS
from app.provider.generic_openai import GenericOpenAIProvider
from app.provider.catalog import PROVIDER_CATALOG
from app.provider.factory import create_provider
from app.schemas.provider import ModelCapabilities, ModelInfo


def test_atlas_provider_catalog_entry():
    atlas = PROVIDER_CATALOG["atlas"]
    assert atlas.name == "Atlas Cloud"
    assert atlas.settings_key == "atlas_api_key"
    assert atlas.kind == "openai_compat"
    assert atlas.base_url == "https://api.atlascloud.ai/v1"


def test_create_atlas_provider_uses_openai_compat_base_url():
    provider = create_provider("atlas", "test-key")
    assert provider.id == "atlas"
    assert str(provider._client.base_url) == "https://api.atlascloud.ai/v1/"


@pytest.mark.asyncio
async def test_atlas_provider_returns_validated_pool_when_api_metadata_is_unavailable(monkeypatch: pytest.MonkeyPatch):
    async def fake_fetch(self) -> list[ModelInfo]:
        return []

    monkeypatch.setattr(GenericOpenAIProvider, "_fetch_api_models", fake_fetch)

    provider = create_provider("atlas", "test-key")
    models = await provider.list_models()

    assert [model.id for model in models] == list(ATLAS_VALIDATED_MODELS)
    assert all(model.provider_id == "atlas" for model in models)


@pytest.mark.asyncio
async def test_atlas_provider_filters_live_api_models_to_validated_pool(monkeypatch: pytest.MonkeyPatch):
    async def fake_fetch(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                id="openai/gpt-5.1-chat",
                name="GPT 5.1 Chat",
                provider_id="atlas",
                capabilities=ModelCapabilities(function_calling=True, max_context=400_000),
            ),
            ModelInfo(
                id="not-in-pool",
                name="Ignore Me",
                provider_id="atlas",
                capabilities=ModelCapabilities(function_calling=True, max_context=128_000),
            ),
            ModelInfo(
                id="deepseek-ai/DeepSeek-V3-0324",
                name="DeepSeek V3",
                provider_id="atlas",
                capabilities=ModelCapabilities(function_calling=True, max_context=128_000),
            ),
        ]

    monkeypatch.setattr(GenericOpenAIProvider, "_fetch_api_models", fake_fetch)

    provider = create_provider("atlas", "test-key")
    models = await provider.list_models()

    assert [model.id for model in models] == [
        "deepseek-ai/DeepSeek-V3-0324",
        "openai/gpt-5.1-chat",
    ]
    assert [model.name for model in models] == ["DeepSeek V3", "GPT 5.1 Chat"]


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("OPENYAK_ATLAS_API_KEY"),
    reason="OPENYAK_ATLAS_API_KEY not set",
)
async def test_atlas_provider_live_stream():
    provider = create_provider("atlas", os.environ["OPENYAK_ATLAS_API_KEY"])

    models = await provider.list_models()
    assert [m.id for m in models] == list(ATLAS_VALIDATED_MODELS)

    chunks = []
    async for chunk in provider.stream_chat(
        "deepseek-ai/DeepSeek-V3-0324",
        [{"role": "user", "content": "Say exactly: atlas"}],
        system="Respond with the exact word requested.",
        temperature=0,
        max_tokens=16,
    ):
        chunks.append(chunk)

    types = {c.type for c in chunks}
    assert "text-delta" in types
    assert "finish" in types
    assert "usage" in types
    text = "".join(c.data.get("text", "") for c in chunks if c.type == "text-delta")
    assert "atlas" in text.lower()


