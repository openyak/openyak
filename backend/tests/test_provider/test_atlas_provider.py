import os

import pytest

from app.provider.catalog import PROVIDER_CATALOG
from app.provider.factory import create_provider


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
@pytest.mark.skipif(
    not os.environ.get("OPENYAK_ATLAS_API_KEY"),
    reason="OPENYAK_ATLAS_API_KEY not set",
)
async def test_atlas_provider_live_stream():
    provider = create_provider("atlas", os.environ["OPENYAK_ATLAS_API_KEY"])

    models = await provider.list_models()
    assert models
    assert any(m.id == "deepseek-ai/DeepSeek-V3-0324" for m in models)

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


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("OPENYAK_OPENAI_API_KEY"),
    reason="OPENYAK_OPENAI_API_KEY not set",
)
async def test_openai_provider_regression_smoke():
    provider = create_provider("openai", os.environ["OPENYAK_OPENAI_API_KEY"])

    chunks = []
    async for chunk in provider.stream_chat(
        "gpt-4o-mini",
        [{"role": "user", "content": "Say exactly: openai"}],
        system="Respond with the exact word requested.",
        temperature=0,
        max_tokens=16,
    ):
        chunks.append(chunk)

    text = "".join(c.data.get("text", "") for c in chunks if c.type == "text-delta")
    assert "openai" in text.lower()
