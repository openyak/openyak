"""Tests for CSRF / Origin-validation middleware.

These tests cover the four root causes in the April 2026 disclosure:

1. No Origin/Referer validation on mutating endpoints.
2. No authentication on loopback for privileged endpoints (e.g. /shutdown).
3. Unvalidated Content-Type on JSON endpoints.
4. Permissive CORS with wildcard Access-Control-Allow-Origin.

The harness mounts a tiny FastAPI app with the real middleware stack so the
interaction between CORSMiddleware and CsrfProtectionMiddleware is exercised.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import FastAPI

from app.auth.csrf import CsrfProtectionMiddleware
from fastapi.middleware.cors import CORSMiddleware


def _make_app(extra_origins: tuple[str, ...] = ()) -> FastAPI:
    """Mount a minimal app with the same middleware wiring as production."""
    app = FastAPI()

    @app.get("/api/ping")
    async def ping():
        return {"status": "ok"}

    @app.post("/api/echo")
    async def echo(payload: dict):
        return {"received": payload}

    @app.post("/shutdown")
    async def shutdown():
        return {"status": "shutting_down"}

    allowed_regex = (
        r"^(?:tauri://localhost"
        r"|https?://tauri\.localhost"
        r"|http://localhost(?::\d+)?"
        r"|http://127\.0\.0\.1(?::\d+)?)$"
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(extra_origins),
        allow_origin_regex=allowed_regex,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    app.add_middleware(
        CsrfProtectionMiddleware,
        extra_allowed_origins=extra_origins,
    )
    return app


async def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class TestOriginAllowlist:
    """Root causes #1 and #2: Origin validation on mutating endpoints."""

    @pytest.mark.asyncio
    async def test_no_origin_allowed_for_native_client(self):
        """Native HTTP clients (curl, CI) send no Origin → allowed."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post("/api/echo", json={"x": 1})
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_attacker_origin_blocked(self):
        """Real PoC: a malicious website issues a cross-site POST."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://evil.example"},
            )
        assert r.status_code == 403
        body = r.json()
        assert "cross-site" in body["detail"].lower()
        assert body["origin"] == "https://evil.example"

    @pytest.mark.asyncio
    async def test_loopback_dns_trick_blocked(self):
        """PoC used a public domain whose A record resolves to 127.0.0.1 to
        bypass Chrome's Private Network Access. The Origin header the browser
        sets is the public domain, not loopback — so the allowlist still
        rejects it."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "http://loopback.creathem.one:19141"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_null_origin_blocked(self):
        """Sandboxed iframes and opaque-origin contexts send Origin: null —
        never a legitimate OpenYak client, always rejected."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "null"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_tauri_origin_allowed(self):
        app = _make_app()
        for origin in (
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ):
            async with await _client(app) as c:
                r = await c.post(
                    "/api/echo",
                    json={"x": 1},
                    headers={"origin": origin},
                )
            assert r.status_code == 200, (origin, r.text)

    @pytest.mark.asyncio
    async def test_loopback_origin_allowed(self):
        """Any port on http://localhost or http://127.0.0.1 — the backend
        picks a random port at startup."""
        app = _make_app()
        for origin in (
            "http://localhost:3000",
            "http://127.0.0.1:8000",
            "http://localhost",
        ):
            async with await _client(app) as c:
                r = await c.post(
                    "/api/echo",
                    json={"x": 1},
                    headers={"origin": origin},
                )
            assert r.status_code == 200, (origin, r.text)

    @pytest.mark.asyncio
    async def test_referer_fallback(self):
        """If Origin is absent but Referer is present, check Referer's
        origin — some older browsers and <form> submissions rely on this."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"referer": "https://evil.example/attack.html"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_referer_fallback_allowed(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"referer": "http://localhost:3000/some/page"},
            )
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_extra_allowed_origin(self):
        """Operators can extend the allowlist via config."""
        app = _make_app(extra_origins=("https://my-custom-wrapper.example",))
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://my-custom-wrapper.example"},
            )
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_case_insensitive_scheme_host(self):
        """RFC 6454: origin scheme and host compare case-insensitively."""
        app = _make_app()
        for origin in (
            "TAURI://LOCALHOST",
            "Tauri://localhost",
            "HTTP://LOCALHOST:3000",
            "HTTP://127.0.0.1:8000",
            "HTTPS://TAURI.LOCALHOST",
        ):
            async with await _client(app) as c:
                r = await c.post(
                    "/api/echo",
                    json={"x": 1},
                    headers={"origin": origin},
                )
            assert r.status_code == 200, (origin, r.text)


class TestHostnameSpoofing:
    """Ensure regex and allowlist logic reject hostnames that look similar
    to legitimate ones but belong to different authorities."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("origin", [
        "http://evil.localhost",            # subdomain of localhost TLD
        "http://localhost.evil.com",        # localhost as subdomain
        "http://127.0.0.1.evil.com",        # IP-looking prefix
        "http://xxx.tauri.localhost",       # subdomain of tauri.localhost
        "http://tauri-localhost",           # hyphen not dot
        "http://localhost@evil.com",        # URL userinfo trick
        "http://127.0.0.2:3000",            # different loopback address
        "http://0.0.0.0:3000",              # wildcard IP
        "http://2130706433:3000",           # decimal encoding of 127.0.0.1
        "http://0x7f000001:3000",           # hex encoding of 127.0.0.1
        "ftp://localhost",                  # wrong scheme for loopback
        "https://localhost",                # https not in allowlist
        "http://xn--loclhost-vxa:3000",     # punycode lookalike
        "not-a-url",                        # unparseable garbage
        "https://evil.example#tauri://localhost",  # fragment trick
    ])
    async def test_spoofed_origin_rejected(self, origin):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": origin},
            )
        assert r.status_code == 403, (origin, r.text)


class TestIPv6Loopback:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("origin", [
        "http://[::1]",
        "http://[::1]:8000",
    ])
    async def test_ipv6_loopback_allowed(self, origin):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": origin},
            )
        assert r.status_code == 200, (origin, r.text)


class TestRefererPrecedence:
    """Origin takes precedence over Referer; Referer is only consulted when
    Origin is absent. This matches the Fetch Standard's behavior."""

    @pytest.mark.asyncio
    async def test_origin_legit_referer_evil_accepted(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={
                    "origin": "tauri://localhost",
                    "referer": "https://evil.example/attack.html",
                },
            )
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_origin_evil_referer_legit_rejected(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={
                    "origin": "https://evil.example",
                    "referer": "http://localhost:3000/legit",
                },
            )
        assert r.status_code == 403


class TestShutdownEndpoint:
    """Root cause #2: /shutdown was an unauthenticated DoS vector."""

    @pytest.mark.asyncio
    async def test_cross_site_shutdown_blocked(self):
        """The exact PoC from the report: a malicious page tries to kill
        the service via POST /shutdown."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/shutdown",
                headers={"origin": "https://evil.example"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_form_submission_shutdown_blocked(self):
        """HTML <form> cross-site POST — the browser sets Origin anyway
        for state-changing methods since Chrome 83+."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/shutdown",
                headers={
                    "origin": "https://evil.example",
                    "content-type": "application/x-www-form-urlencoded",
                },
                content="",
            )
        assert r.status_code == 403


class TestSafeMethods:
    """GET/HEAD/OPTIONS never carry side effects and bypass the CSRF check.
    Cross-origin READS are controlled by CORS, which is tightened separately.
    """

    @pytest.mark.asyncio
    async def test_get_from_any_origin_reaches_handler(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.get(
                "/api/ping",
                headers={"origin": "https://evil.example"},
            )
        # Handler runs; CORS middleware decides whether the browser can
        # read the response (it cannot — but the server returned 200).
        assert r.status_code == 200


class TestContentType:
    """Root cause #3: unvalidated Content-Type on mutating endpoints.

    Defense in depth against form-based CSRF that tries to smuggle JSON
    bodies by setting exotic Content-Types (e.g. text/plain, arbitrary
    strings) that browsers allow without a preflight.
    """

    @pytest.mark.asyncio
    async def test_text_plain_body_rejected(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                headers={"content-type": "text/plain"},
                content='{"x": 1}',
            )
        assert r.status_code == 415

    @pytest.mark.asyncio
    async def test_arbitrary_content_type_rejected(self):
        """The report explicitly noted the server accepted Content-Type
        values like `uvuwewewe` — anything non-standard is now 415."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                headers={"content-type": "uvuwewewe"},
                content='{"x": 1}',
            )
        assert r.status_code == 415

    @pytest.mark.asyncio
    async def test_application_json_accepted(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post("/api/echo", json={"x": 1})
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_empty_body_no_content_type_ok(self):
        """POST /shutdown has no body and no Content-Type — the request
        reaches the handler when Origin is absent or allowed."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post("/shutdown")
        assert r.status_code == 200


class TestCors:
    """Root cause #4: CORS was allow_origins=['*'] with credentials — any
    site could read responses cross-origin (PII leak)."""

    @pytest.mark.asyncio
    async def test_cors_rejects_evil_origin(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.options(
                "/api/echo",
                headers={
                    "origin": "https://evil.example",
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type",
                },
            )
        # Starlette's CORS returns 400 on disallowed preflights. Either
        # way, the Access-Control-Allow-Origin header must not be emitted.
        assert r.headers.get("access-control-allow-origin") != "*"
        assert r.headers.get("access-control-allow-origin") != "https://evil.example"

    @pytest.mark.asyncio
    async def test_cors_accepts_tauri_origin(self):
        app = _make_app()
        async with await _client(app) as c:
            r = await c.options(
                "/api/echo",
                headers={
                    "origin": "tauri://localhost",
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type",
                },
            )
        assert r.headers.get("access-control-allow-origin") == "tauri://localhost"


class TestOriginParsingHardening:
    """Reviewer feedback (Arturo, April 2026): prefer stdlib URL parsing
    over hand-rolled string work, and handle every error path the
    parser can raise. These tests exercise the edge cases the
    hardening pass introduced."""

    @pytest.mark.asyncio
    async def test_https_loopback_rejected(self):
        """We never serve loopback over TLS — a request claiming
        ``https://127.0.0.1`` is evidence of an attacker-crafted origin,
        not a legitimate client."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://127.0.0.1:8443"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_malformed_port_rejected(self):
        """urlparse raises on out-of-range ports; the middleware must
        treat that as "origin unparseable" and reject, not fall back
        to the Referer."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={
                    "origin": "http://127.0.0.1:999999",
                    # Referer is loopback — if we erroneously fell back
                    # we would accept the request.
                    "referer": "http://127.0.0.1:3000/",
                },
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_ipv6_loopback_allowed_after_bracket_strip(self):
        """urlparse strips IPv6 brackets before returning ``hostname``;
        our allowlist must match the post-parse form (``::1``), not the
        bracketed form (``[::1]``)."""
        app = _make_app()
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "http://[::1]:8080"},
            )
        assert r.status_code == 200, r.text


class TestRuntimeTunnelOrigin:
    """Reviewer feedback (Arturo, final pass): verify cloudflared does
    not break. Quick-tunnel URLs are random per session, so they cannot
    be baked into the static allowlist or the env-var override; the
    middleware must read a mutable runtime set from app.state that
    remote-access handlers update when the tunnel comes up or down."""

    @pytest.mark.asyncio
    async def test_active_tunnel_origin_allowed(self):
        """Once the tunnel URL is registered on app.state, a mobile
        browser POSTing from that origin is accepted."""
        app = _make_app()
        app.state.runtime_allowed_origins = {"https://abc-xyz.trycloudflare.com"}
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://abc-xyz.trycloudflare.com"},
            )
        assert r.status_code == 200, r.text

    @pytest.mark.asyncio
    async def test_unrelated_trycloudflare_still_blocked(self):
        """Only the *currently-registered* tunnel URL is trusted — a
        different trycloudflare.com subdomain is not automatically
        accepted."""
        app = _make_app()
        app.state.runtime_allowed_origins = {"https://abc-xyz.trycloudflare.com"}
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://evil-other.trycloudflare.com"},
            )
        assert r.status_code == 403

    @pytest.mark.asyncio
    async def test_tunnel_origin_eviction_takes_effect_immediately(self):
        """Removing the URL from the set (e.g. tunnel restart on a new
        URL, or disable_remote) must block the old origin on the very
        next request — no backend restart, no middleware rebuild."""
        app = _make_app()
        app.state.runtime_allowed_origins = {"https://abc-xyz.trycloudflare.com"}
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://abc-xyz.trycloudflare.com"},
            )
            assert r.status_code == 200, r.text
            # Tunnel restarts on a new URL; swap the allowlist entry.
            app.state.runtime_allowed_origins = {"https://def-qrs.trycloudflare.com"}
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://abc-xyz.trycloudflare.com"},
            )
            assert r.status_code == 403
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://def-qrs.trycloudflare.com"},
            )
            assert r.status_code == 200, r.text

    @pytest.mark.asyncio
    async def test_trailing_slash_tolerated(self):
        """cloudflared may hand us the URL with or without a trailing
        slash; the set compares normalised forms."""
        app = _make_app()
        # Register with trailing slash; request without.
        app.state.runtime_allowed_origins = {"https://abc-xyz.trycloudflare.com/"}
        async with await _client(app) as c:
            r = await c.post(
                "/api/echo",
                json={"x": 1},
                headers={"origin": "https://abc-xyz.trycloudflare.com"},
            )
        assert r.status_code == 200, r.text

