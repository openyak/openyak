"""CSRF protection via Origin/Referer validation.

OpenYak's HTTP server binds to 127.0.0.1, so it is reachable from any webpage
the user visits — the browser acts as a proxy into loopback. Without server-side
origin validation, a malicious page can issue cross-site POSTs to privileged
endpoints (shutdown, chat-prompt-with-bash, config reads, etc.). Neither
Private Network Access nor CORS fully prevents this: PNA is absent in Firefox
and bypassable in Chrome (e.g. via a public domain whose A record resolves to
127.0.0.1), and CORS only controls whether the browser lets JS *read* the
response — the request still reaches the server.

Browsers always attach an `Origin` header on cross-origin state-changing
fetches, and the value cannot be forged from JS. This middleware rejects any
mutating request whose `Origin` (or `Referer` fallback) is not in the
allowlist. Native HTTP clients (curl, the Next.js dev proxy, CI scripts)
legitimately send no `Origin`/`Referer` and are permitted — that is not a
hole because a browser cannot impersonate them from JS.

In addition, requests that carry a body with an unusual `Content-Type` are
rejected — defense-in-depth against form-based CSRF variants that try to
smuggle JSON bodies through simple requests.
"""

from __future__ import annotations

import json
import logging
from typing import Iterable
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Exact-match origins for the Tauri desktop shell. Tauri serves the frontend
# from a custom URL scheme (varies across platforms/versions).
_DESKTOP_ORIGINS = frozenset({
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
})

# Canonical loopback hostnames. Intentionally narrow: browsers always
# serialise the Origin header from their already-canonicalised URL, so a
# legitimate same-host fetch to our backend always reports one of these
# three strings. Receiving a "semantically equivalent" loopback spelling
# (``127.0.0.2``, ``0x7f000001``, ``::ffff:127.0.0.1``) is a strong
# signal the Origin was hand-crafted by an attacker — reject it rather
# than try to normalise. ``urlparse().hostname`` strips IPv6 brackets
# and lowercases, so we match the post-parse form.
_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})

# Content-Types allowed on state-changing requests carrying a body. Anything
# else (notably `text/plain`, which browsers permit cross-origin without a
# preflight) is rejected.
_ALLOWED_CONTENT_TYPES = (
    "application/json",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
)


def _parse_origin(raw: str) -> tuple[str, str, int | None] | None:
    """Parse an Origin/Referer value into (scheme, host, port).

    Returns None for unparseable values and the literal string ``"null"``
    (the origin browsers send from opaque contexts like sandboxed iframes).
    ``urlparse`` handles RFC-3986 normalisation (case folding, punycode,
    IPv6 brackets) so callers receive a canonicalised host — far less
    error-prone than hand-rolled splitting.
    """
    if not raw or raw == "null":
        return None
    try:
        p = urlparse(raw)
    except ValueError:
        return None
    if not p.scheme or not p.hostname:
        return None
    # ``port`` raises ValueError for out-of-range or non-numeric ports;
    # swallow it so an attacker cannot smuggle a parse error into the
    # exception-free path and coerce us to fall back to Referer.
    try:
        port = p.port
    except ValueError:
        return None
    return (p.scheme.lower(), p.hostname.lower(), port)


def _is_loopback_host(host: str) -> bool:
    """Return True if ``host`` is a canonical loopback spelling.

    We deliberately do **not** route through ``ipaddress.is_loopback``:
    that would accept alternate forms (``127.0.0.2``, ``0x7f000001``,
    ``::ffff:127.0.0.1``) which are semantically loopback but which
    browsers never send as an Origin — their presence means the header
    was hand-crafted and should be treated as hostile. See
    ``TestHostnameSpoofing`` for the rejection matrix. ``urlparse()``
    has already lowercased the host and stripped IPv6 brackets for us.
    """
    return host in _LOOPBACK_HOSTNAMES


def _canonical_origin(scheme: str, host: str, port: int | None) -> str:
    if port is None:
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _origin_allowed(
    origin: str,
    extra: Iterable[str],
    runtime: Iterable[str] = (),
) -> bool:
    """Return True if ``origin`` is an OpenYak-controlled frontend origin.

    Per RFC 6454, origin scheme and host compare case-insensitively — browsers
    normalize before sending, but we defensively normalize on our side too.
    ``runtime`` is the cloudflared / manual-tunnel URL snapshot read from
    app.state at request time; ``extra`` is the static override list.
    """
    parsed = _parse_origin(origin)
    if parsed is None:
        return False
    scheme, host, port = parsed
    canonical = _canonical_origin(scheme, host, port)
    if canonical in _DESKTOP_ORIGINS:
        return True
    if origin in extra or canonical in extra:
        return True
    if origin in runtime or canonical in runtime:
        return True
    if scheme == "http" and _is_loopback_host(host):
        # Any port on loopback is considered same-host (backend picks a
        # random free port; frontend dev server uses a configurable one).
        # HTTPS on loopback is deliberately excluded — we never serve
        # loopback over TLS, so seeing ``https://127.0.0.1`` is evidence
        # of an attacker-crafted origin, not a legitimate client.
        return True
    return False


def _source_origin(headers: dict[bytes, bytes]) -> str | None:
    """Return the canonical origin string for the request, or None if absent.

    Prefer the ``Origin`` header (always set by browsers on cross-origin
    state-changing requests). Fall back to ``Referer`` for older browsers
    or edge cases (e.g. some `<form>` submissions). Returns the literal
    ``"null"`` when the browser explicitly signals an opaque origin, so
    callers can reject it rather than mistaking it for "no header".
    """
    origin = headers.get(b"origin", b"").decode("latin-1", errors="replace").strip()
    if origin:
        return origin
    referer = headers.get(b"referer", b"").decode("latin-1", errors="replace").strip()
    if not referer:
        return None
    if referer == "null":
        return "null"
    parsed = _parse_origin(referer)
    if parsed is None:
        return None
    return _canonical_origin(*parsed)


def _content_type(headers: dict[bytes, bytes]) -> str:
    raw = headers.get(b"content-type", b"").decode("latin-1", errors="replace")
    # Strip parameters like "; charset=utf-8" and "; boundary=..."
    return raw.split(";", 1)[0].strip().lower()


def _has_body(headers: dict[bytes, bytes]) -> bool:
    """Best-effort: does this request carry a body?"""
    cl = headers.get(b"content-length", b"").strip()
    if cl and cl != b"0":
        return True
    te = headers.get(b"transfer-encoding", b"").strip().lower()
    if te and b"chunked" in te:
        return True
    return False


class CsrfProtectionMiddleware:
    """Pure ASGI middleware enforcing an Origin allowlist on mutating requests.

    Pass-through for safe methods (GET/HEAD/OPTIONS) and for requests without
    any browser-attached Origin/Referer (native clients). Rejects mutating
    requests whose Origin/Referer does not match the OpenYak frontend
    allowlist, and rejects state-changing requests carrying a body with an
    unexpected Content-Type.

    Allowlist sources (checked in order):

    1. Compile-time defaults: the Tauri desktop origins and loopback.
    2. ``extra_allowed_origins`` passed at construction — the
       ``OPENYAK_EXTRA_ALLOWED_ORIGINS`` env var, for static overrides.
    3. Dynamic set ``app.state.runtime_allowed_origins`` — the
       cloudflared tunnel URL is added here when remote access is
       enabled and removed when it stops. Reading per request (not at
       construction) means a tunnel that comes up after startup is
       honoured without a backend restart, and a rotated tunnel URL
       eviction takes effect on the very next request.
    """

    def __init__(self, app, *, extra_allowed_origins: Iterable[str] = ()):
        self.app = app
        # Normalize: drop empty strings and trailing slashes
        self._extra = tuple(
            o.rstrip("/") for o in (s.strip() for s in extra_allowed_origins) if o
        )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "").upper()
        headers = dict(scope.get("headers", []))

        # Safe methods: no CSRF check (they MUST be side-effect-free). CORS
        # is what limits cross-origin *reads* of these responses.
        if method in _SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        # --- Origin / Referer check ---
        source = _source_origin(headers)
        if source is not None:
            # Reject the literal "null" origin (sandboxed iframes, data: URLs,
            # certain redirects — never a legitimate OpenYak frontend).
            if source == "null":
                await _reject(send, scope, "null origin is not allowed", source=source)
                return
            runtime_origins = _runtime_origins(scope)
            if not _origin_allowed(source, self._extra, runtime_origins):
                await _reject(
                    send, scope,
                    "Cross-site request blocked: unrecognized Origin",
                    source=source,
                )
                return

        # --- Content-Type allowlist (defense-in-depth) ---
        # Only enforced when the request carries a body. Empty-body mutating
        # requests (e.g. POST /shutdown) are covered by the Origin check above.
        if _has_body(headers):
            ct = _content_type(headers)
            if ct and ct not in _ALLOWED_CONTENT_TYPES:
                await _reject(
                    send, scope,
                    f"Unsupported Content-Type: {ct!r}",
                    status=415,
                )
                return

        await self.app(scope, receive, send)


def _runtime_origins(scope) -> frozenset[str]:
    """Snapshot ``app.state.runtime_allowed_origins`` for this request.

    The set is mutated by the remote-access enable/disable handlers when a
    tunnel comes up or down, and by the tunnel monitor when it restarts
    on a fresh URL. We take a snapshot (``frozenset``) per request so a
    concurrent mutation cannot race the allowlist check.
    """
    app_state = scope.get("app")
    state = getattr(app_state, "state", None) if app_state else None
    origins = getattr(state, "runtime_allowed_origins", None) if state else None
    if not origins:
        return frozenset()
    # Defensive copy: callers should not be able to influence the set we
    # compare against via an aliased reference, and a raw set is not
    # hashable/freezeable in the allowlist membership test otherwise.
    return frozenset(o.rstrip("/") for o in origins if o)


async def _reject(
    send,
    scope,
    detail: str,
    *,
    status: int = 403,
    source: str | None = None,
) -> None:
    """Send a JSON error response directly via ASGI send."""
    path = scope.get("path", "")
    method = scope.get("method", "")
    if source is not None:
        logger.warning("CSRF blocked %s %s from %s", method, path, source)
    else:
        logger.warning("CSRF blocked %s %s (%s)", method, path, detail)
    body = {"detail": detail}
    if source is not None:
        body["origin"] = source
    data = json.dumps(body).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            [b"content-type", b"application/json"],
            [b"content-length", str(len(data)).encode()],
        ],
    })
    await send({
        "type": "http.response.body",
        "body": data,
    })
