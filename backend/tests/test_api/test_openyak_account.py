"""Tests for OpenYak account provider sync."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.api.config import OpenYakAccountConnect, connect_openyak_account

pytestmark = pytest.mark.asyncio


def _http_status_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://proxy.test/v1/models")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(str(status_code), request=request, response=response)


def _settings():
    settings = MagicMock()
    settings.proxy_url = ""
    settings.proxy_token = ""
    settings.proxy_refresh_token = ""
    return settings


class TestConnectOpenYakAccount:
    async def test_refreshes_expired_access_token_before_registering_proxy(self):
        settings = _settings()
        registry = MagicMock()
        registry.refresh_models = AsyncMock(return_value={})
        created_tokens: list[str] = []

        class FakeOpenRouterProvider:
            def __init__(self, api_key: str, **_kwargs):
                self.api_key = api_key
                created_tokens.append(api_key)

            async def list_models(self):
                if self.api_key == "expired_access":
                    raise _http_status_error(401)
                return [object()]

        body = OpenYakAccountConnect(
            proxy_url="https://proxy.test",
            token="expired_access",
            refresh_token="refresh_token",
        )

        with patch("app.api.config.OpenRouterProvider", FakeOpenRouterProvider):
            with patch(
                "app.api.config._refresh_openyak_proxy_token",
                AsyncMock(return_value=("fresh_access", "fresh_refresh")),
            ):
                with patch("app.api.config._update_env_file") as update_env:
                    status = await connect_openyak_account(settings, registry, body)

        assert status.is_connected is True
        assert settings.proxy_url == "https://proxy.test"
        assert settings.proxy_token == "fresh_access"
        assert settings.proxy_refresh_token == "fresh_refresh"
        assert created_tokens == ["expired_access", "fresh_access", "fresh_access"]
        registered_provider = registry.register.call_args.args[0]
        assert registered_provider.api_key == "fresh_access"
        update_env.assert_any_call("OPENYAK_PROXY_TOKEN", "fresh_access")
        update_env.assert_any_call("OPENYAK_PROXY_REFRESH_TOKEN", "fresh_refresh")
