"""Bearer-token authentication middleware for the OpenYak local API.

Threat model
------------

OpenYak's FastAPI backend binds to ``127.0.0.1`` on an ephemeral port. The
loopback interface is not a user-isolation boundary: on any Unix host
every local user shares the same ``127.0.0.1``, and from the backend's
perspective a request from Pepe's shell and a request from Ana's shell
are indistinguishable. Since Pepe's chat-agent endpoint can execute
shell commands with Pepe's permissions, letting Ana reach the server
without a credential is equivalent to giving Ana shell-as-Pepe.

The same applies to an attacker's JavaScript running in any page the
user opens: the browser will proxy requests into loopback, and while
the CSRF middleware blocks browser-initiated cross-site state-changing
requests (via ``Origin`` validation), that is a defense-in-depth layer,
not the primary control. A browser that relaxes preflight behaviour, or
a non-browser client on the host, would bypass it.

This middleware therefore enforces **mandatory bearer-token auth on
every privileged request, regardless of the source interface** — the
session token lives in a 0600 file that only the OpenYak-running user
can read, and any client that cannot present the token is rejected.

Pass-through paths
------------------

The middleware is **deny-by-default**: every route requires a bearer
token unless its path appears in an explicit allowlist. Any new
endpoint a developer adds is therefore authenticated without ceremony,
and forgetting to protect one cannot happen silently — it takes an
explicit code change to the allowlist below.

Currently allowed unauthenticated:

* ``/livez``, ``/health`` — liveness/readiness probes consumed by the
  Tauri watchdog; contain no secrets, do not mutate state.
* ``/favicon.svg``, ``/manifest.json`` — PWA asset serves.
* ``/_next/*`` — Next.js static bundle (JS/CSS/fonts).
* ``/m``, ``/m/*`` — mobile PWA HTML shells. The HTML itself is not
  sensitive; the JS it serves makes authenticated ``/api/*`` calls
  using the remote tunnel token.

Everything else (``/api/*``, ``/v1/*`` OpenAI-compat, ``/shutdown``,
root ``/``, anything a future router mounts) requires a valid token.

Token sources
-------------

Two tokens are accepted, checked in constant time:

1. **Session token** — rotated on backend startup, held in
   ``app.state.session_token``, never leaves the host filesystem
   (Tauri reads the 0600 file and injects ``Authorization`` on every
   request).
2. **Remote token** — persistent, loaded from
   ``settings.remote_token_path``, only when
   ``settings.remote_access_enabled`` is True. Used by the phone
   companion mode through the tunnel.

Rate limiting is preserved for non-loopback clients so a broken or
hostile tunnel peer cannot brute-force the token.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import parse_qs

from app.auth.token import load_token, validate_token

logger = logging.getLogger(__name__)

_LOCALHOST_IPS = frozenset({"127.0.0.1", "::1", "localhost"})

# Exact-path allowlist — these routes skip authentication entirely. Keep
# this set minimal: every entry is a public endpoint and must be audited
# against the criterion "does it leak secrets or mutate state?". Anything
# outside this set (and the prefix allowlist below) is authenticated.
_PUBLIC_PATHS = frozenset({
    "/livez",          # Tauri watchdog liveness probe
    "/health",         # Provider status dump, no secrets
    "/favicon.svg",    # PWA asset
    "/manifest.json",  # PWA asset
    "/m",              # Mobile PWA HTML shell (JS inside calls /api/* authed)
})

# Prefix allowlist — anything under these prefixes is public. The Next.js
# static bundle and the mobile PWA's nested HTML shells fall here.
_PUBLIC_PREFIXES: tuple[str, ...] = (
    "/_next/",  # Next.js static bundle (JS/CSS/fonts)
    "/m/",      # Mobile PWA SPA fallback pages
)

_RATE_WINDOW = 60  # seconds — not user-tunable


class _RateBucket:
    __slots__ = ("timestamps",)

    def __init__(self):
        self.timestamps: list[float] = []

    def hit(self, now: float, window: float) -> int:
        cutoff = now - window
        self.timestamps = [t for t in self.timestamps if t > cutoff]
        self.timestamps.append(now)
        return len(self.timestamps)


def _requires_auth(path: str) -> bool:
    """Return True unless ``path`` is explicitly allowlisted as public.

    Deny-by-default: adding a new endpoint does not require remembering
    to wire up auth — the middleware already protects it. Making an
    endpoint public is the exceptional case and must be an explicit
    code change here.
    """
    if path in _PUBLIC_PATHS:
        return False
    for prefix in _PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return False
    return True


def _extract_token(scope: dict, headers: dict[bytes, bytes]) -> str:
    """Pull a bearer token from ``Authorization`` or the ``?token=`` query.

    Header form is preferred and is what the Tauri shell uses. The query
    string form is retained only for ``EventSource`` streams, which the
    browser API cannot attach custom headers to.
    """
    auth_header = headers.get(b"authorization", b"").decode("latin-1", errors="replace")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    # Fall back to ?token= only if Authorization was absent. Accepting both
    # simultaneously would open a smuggling window if a proxy normalises one
    # but not the other.
    qs = scope.get("query_string", b"").decode("latin-1", errors="replace")
    token_list = parse_qs(qs).get("token", [])
    return token_list[0] if token_list else ""


class AuthMiddleware:
    """Pure ASGI middleware — never buffers response bodies.

    Using raw ASGI rather than ``BaseHTTPMiddleware`` matters for
    ``StreamingResponse`` (chat SSE) which would otherwise be buffered
    in memory before reaching the client.
    """

    def __init__(self, app):
        from app.config import get_settings as _get_settings

        _s = _get_settings()
        self.app = app
        self._max_requests = _s.rate_limit_max_requests
        self._max_failed_auth = _s.rate_limit_max_failed_auth
        self._request_buckets: dict[str, _RateBucket] = defaultdict(_RateBucket)
        self._failed_auth_buckets: dict[str, _RateBucket] = defaultdict(_RateBucket)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not _requires_auth(path):
            await self.app(scope, receive, send)
            return

        app_state = scope.get("app")
        state = getattr(app_state, "state", None) if app_state else None
        settings = getattr(state, "settings", None)
        session_token = getattr(state, "session_token", None)

        if settings is None or not session_token:
            # Fail closed: missing configuration means we cannot validate,
            # so we refuse rather than accidentally letting requests
            # through unauthenticated.
            await self._reject(send, 503, "Auth not initialised")
            return

        headers = dict(scope.get("headers", []))
        client_ip = self._client_ip(scope, headers)
        is_local = client_ip in _LOCALHOST_IPS
        now = time.monotonic()

        # Rate limit non-local peers. Local traffic is the Tauri shell and
        # is trusted to the same extent as the user account — limiting
        # it would just degrade the legitimate UI.
        if not is_local:
            req_count = self._request_buckets[client_ip].hit(now, _RATE_WINDOW)
            if req_count > self._max_requests:
                await self._reject(send, 429, "Rate limit exceeded")
                return
            # Probe the failed-auth bucket without consuming an attempt
            failed_peek = len(self._failed_auth_buckets[client_ip].timestamps)
            if failed_peek > self._max_failed_auth:
                await self._reject(send, 429, "Too many failed authentication attempts")
                return

        provided = _extract_token(scope, headers)
        if not provided:
            if not is_local:
                self._failed_auth_buckets[client_ip].hit(now, _RATE_WINDOW)
            await self._reject(send, 401, "Authentication required")
            return

        if not self._token_matches(provided, session_token, settings):
            if not is_local:
                self._failed_auth_buckets[client_ip].hit(now, _RATE_WINDOW)
            await self._reject(send, 401, "Invalid token")
            return

        # Authenticated — annotate the scope so downstream handlers can
        # distinguish local from remote if they want to apply extra policy
        # (e.g. the permission prompt model).
        scope.setdefault("state", {})["source"] = "local" if is_local else "remote"
        await self.app(scope, receive, send)

    @staticmethod
    def _token_matches(provided: str, session_token: str, settings) -> bool:
        """Constant-time match against session + (optional) remote token.

        Both comparisons always run to keep the timing shape uniform
        regardless of which token the client presented.
        """
        session_ok = validate_token(provided, session_token)
        remote_ok = False
        if getattr(settings, "remote_access_enabled", False):
            remote_path = Path(settings.remote_token_path)
            remote_expected = load_token(remote_path)
            if remote_expected:
                remote_ok = validate_token(provided, remote_expected)
        return session_ok or remote_ok

    @staticmethod
    def _client_ip(scope, headers: dict[bytes, bytes]) -> str:
        # Trust X-Forwarded-For only when remote access is enabled and a
        # tunnel is front-of-us. For loopback-only desktop traffic the
        # header is attacker-controlled and must be ignored — otherwise a
        # browser-driven request could claim to be 127.0.0.1 and skip
        # the rate limiter. We key on the socket peer.
        client = scope.get("client")
        if client:
            return client[0]
        forwarded = headers.get(b"x-forwarded-for", b"").decode("latin-1", errors="replace")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return "unknown"

    @staticmethod
    async def _reject(send, status: int, detail: str) -> None:
        data = json.dumps({"detail": detail}).encode()
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                [b"content-type", b"application/json"],
                [b"content-length", str(len(data)).encode()],
                [b"www-authenticate", b'Bearer realm="openyak"'],
            ],
        })
        await send({
            "type": "http.response.body",
            "body": data,
        })


# Backwards-compatible alias so existing imports (and any external scripts
# that may reach into app.auth.middleware) keep resolving. The old name
# was misleading because the check was optional; the new name reflects
# that auth is now mandatory.
RemoteAuthMiddleware = AuthMiddleware
