"""Tests for the mandatory bearer-token AuthMiddleware.

These tests cover the additional hardening introduced after the April
2026 review (Arturo): the local HTTP API now requires authentication on
every privileged request regardless of the source interface, closing
the same-host lateral-user escalation vector that Origin-only
validation does not address.
"""

from __future__ import annotations

import json
import types
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI

from app.auth.middleware import AuthMiddleware


_SESSION_TOKEN = "openyak_st_test_session_abcdef0123456789"
_REMOTE_TOKEN = "openyak_rt_test_remote_abcdef0123456789"


def _settings(**overrides) -> types.SimpleNamespace:
    defaults = dict(
        remote_access_enabled=False,
        remote_token_path="",
        rate_limit_max_requests=120,
        rate_limit_max_failed_auth=5,
    )
    defaults.update(overrides)
    return types.SimpleNamespace(**defaults)


def _make_app(settings: types.SimpleNamespace, *, session_token: str | None = _SESSION_TOKEN) -> FastAPI:
    app = FastAPI()

    @app.get("/api/ping")
    async def ping():
        return {"status": "ok"}

    @app.post("/api/echo")
    async def echo(payload: dict):
        return {"received": payload}

    @app.get("/livez")
    async def livez():
        return {"status": "ok"}

    @app.post("/shutdown")
    async def shutdown():
        return {"status": "shutting_down"}

    app.state.settings = settings
    app.state.session_token = session_token

    # Patch get_settings so AuthMiddleware picks up the test config at
    # construction. The middleware reads rate-limit knobs from it once.
    import app.auth.middleware as mw

    mw.get_settings = lambda: settings  # type: ignore[attr-defined]
    # Rebind via the local import path used inside AuthMiddleware.__init__
    from app.config import get_settings as _real_get_settings  # noqa: F401

    import app.config as _cfg

    _cfg.get_settings = lambda: settings  # type: ignore[assignment]

    app.add_middleware(AuthMiddleware)
    return app


async def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class TestPublicRoutes:
    """Liveness endpoints must remain reachable without a token — the
    Tauri watchdog polls /livez every 10s to decide whether the backend
    needs to be restarted."""

    @pytest.mark.asyncio
    async def test_livez_no_auth(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get("/livez")
        assert r.status_code == 200


class TestDenyByDefault:
    """Reviewer feedback (Arturo, second pass): auth should be applied to
    every endpoint by default, with opt-out for specific public routes.
    Any path not on the allowlist must be challenged — including routes
    that live outside the ``/api/`` prefix (e.g. OpenAI-compat ``/v1/*``)
    and hypothetical future top-level mounts."""

    @pytest.mark.asyncio
    async def test_openai_compat_v1_requires_auth(self):
        """``/v1/chat/completions`` is OpenAI-compatible and can invoke
        tools — must require a token even though it's not under /api/."""
        app = _make_app(_settings())

        @app.post("/v1/chat/completions")
        async def compat():
            return {"ok": True}

        async with await _client(app) as c:
            r = await c.post("/v1/chat/completions", json={})
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_arbitrary_top_level_route_requires_auth(self):
        """Adding a new top-level route in the future must not silently
        bypass auth — the deny-by-default policy protects it."""
        app = _make_app(_settings())

        @app.post("/some-future-route")
        async def future():
            return {"ok": True}

        async with await _client(app) as c:
            r = await c.post("/some-future-route")
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_root_requires_auth(self):
        """``/`` also denies unauthenticated requests — CSRF is not the
        only thing keeping a browser-driven POST at bay."""
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.post("/")
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_static_asset_public(self):
        """``/favicon.svg`` and ``/manifest.json`` must stay reachable
        for the PWA icon to load before the user has any credential."""
        app = _make_app(_settings())

        @app.get("/favicon.svg")
        async def favicon():
            return {"ok": True}

        async with await _client(app) as c:
            r = await c.get("/favicon.svg")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_next_bundle_public(self):
        """The Next.js static bundle is served from ``/_next/`` and is
        neither secret nor mutation-capable."""
        app = _make_app(_settings())

        @app.get("/_next/static/chunks/main.js")
        async def bundle():
            return {"ok": True}

        async with await _client(app) as c:
            r = await c.get("/_next/static/chunks/main.js")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_mobile_shell_public(self):
        """Mobile PWA HTML shells are public so an unauthenticated
        browser can bootstrap the app; the JS inside then authenticates
        via the remote tunnel token before calling /api/*."""
        app = _make_app(_settings())

        @app.get("/m")
        async def m_root():
            return {"ok": True}

        @app.get("/m/settings")
        async def m_settings():
            return {"ok": True}

        async with await _client(app) as c:
            r = await c.get("/m")
            assert r.status_code == 200
            r = await c.get("/m/settings")
            assert r.status_code == 200


class TestMandatoryAuth:
    """Every /api/* route must reject anonymous requests, including
    those originating from loopback — lateral user-to-user escalation
    on a shared host is the scenario the reviewer flagged."""

    @pytest.mark.asyncio
    async def test_api_rejects_anonymous_even_from_loopback(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get("/api/ping")
        assert r.status_code == 401
        assert r.json()["detail"] == "Authentication required"
        assert "Bearer" in r.headers.get("www-authenticate", "")

    @pytest.mark.asyncio
    async def test_api_accepts_valid_bearer(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": f"Bearer {_SESSION_TOKEN}"},
            )
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_api_accepts_query_token_for_eventsource(self):
        """EventSource cannot set headers; we accept ?token= as a fallback
        for SSE streams only."""
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get(f"/api/ping?token={_SESSION_TOKEN}")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_api_rejects_wrong_token(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": "Bearer openyak_st_wrong_token_value"},
            )
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid token"

    @pytest.mark.asyncio
    async def test_api_rejects_empty_bearer(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": "Bearer "},
            )
        assert r.status_code == 401


class TestShutdownProtected:
    """/shutdown is outside /api/ but is still a privileged endpoint —
    a malicious webpage being able to kill the backend at will is a
    DoS primitive. It must require the bearer token."""

    @pytest.mark.asyncio
    async def test_shutdown_requires_token(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.post("/shutdown")
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_shutdown_allowed_with_token(self):
        app = _make_app(_settings())
        async with await _client(app) as c:
            r = await c.post(
                "/shutdown",
                headers={"authorization": f"Bearer {_SESSION_TOKEN}"},
            )
        assert r.status_code == 200


class TestRemoteToken:
    """When remote-access mode is on, the persisted remote token is a
    second accepted credential (in addition to the per-run session
    token). Rotating the remote token does not invalidate the Tauri
    shell's session token and vice versa."""

    @pytest.mark.asyncio
    async def test_remote_token_accepted(self, tmp_path: Path):
        token_path = tmp_path / "remote_token.json"
        token_path.write_text(json.dumps({"token": _REMOTE_TOKEN}))
        app = _make_app(
            _settings(
                remote_access_enabled=True,
                remote_token_path=str(token_path),
            )
        )
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": f"Bearer {_REMOTE_TOKEN}"},
            )
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_remote_token_ignored_when_disabled(self, tmp_path: Path):
        """If the user has not opted into remote access, a request
        presenting only the remote token is rejected — we never silently
        broaden the credential set."""
        token_path = tmp_path / "remote_token.json"
        token_path.write_text(json.dumps({"token": _REMOTE_TOKEN}))
        app = _make_app(
            _settings(
                remote_access_enabled=False,
                remote_token_path=str(token_path),
            )
        )
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": f"Bearer {_REMOTE_TOKEN}"},
            )
        assert r.status_code == 401


class TestFailClosed:
    """If the middleware cannot obtain the session token (e.g. the
    lifespan startup failed to generate one), the only safe response
    is to refuse traffic — never accept requests unauthenticated."""

    @pytest.mark.asyncio
    async def test_missing_session_token_refuses(self):
        app = _make_app(_settings(), session_token=None)
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"authorization": f"Bearer {_SESSION_TOKEN}"},
            )
        assert r.status_code == 503


