"""Tests for model listing API endpoints."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock

from app.schemas.provider import ModelCapabilities, ModelInfo

pytestmark = pytest.mark.asyncio


def _model(mid: str) -> ModelInfo:
    return ModelInfo(id=mid, name=mid, provider_id="or", capabilities=ModelCapabilities())


class TestListModels:
    async def test_with_models(self, app_client):
        app_client.app.state.provider_registry.all_models.return_value = [_model("m1"), _model("m2")]
        resp = await app_client.get("/api/models")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    async def test_empty_triggers_refresh(self, app_client):
        pr = app_client.app.state.provider_registry
        pr.all_models.return_value = []
        resp = await app_client.get("/api/models")
        assert resp.status_code == 200
        pr.refresh_models.assert_called()


class TestRefreshModels:
    async def test_success(self, app_client):
        pr = app_client.app.state.provider_registry
        pr.refresh_models = AsyncMock(return_value={"or": [_model("m1")]})
        resp = await app_client.post("/api/models/refresh")
        assert resp.status_code == 200
        assert "refreshed" in resp.json()

    async def test_non_auth_error(self, app_client):
        pr = app_client.app.state.provider_registry
        pr.refresh_models = AsyncMock(side_effect=RuntimeError("Connection refused"))
        resp = await app_client.post("/api/models/refresh")
        assert resp.status_code == 200
        assert resp.json()["refreshed"] == {}
