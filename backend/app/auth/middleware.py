"""Remote access authentication middleware (pure ASGI).

Uses raw ASGI middleware instead of Starlette's BaseHTTPMiddleware to avoid
buffering StreamingResponse bodies — which breaks SSE event streaming.

- If remote_access_enabled is False: no auth enforced.
- If request is from localhost: skip auth (Tauri desktop app).
- If non-API route: skip auth (static frontend files).
- If non-localhost API request: require Bearer token or ?token= query param.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from urllib.parse import parse_qs

from app.auth.token import load_token, validate_token

logger = logging.getLogger(__name__)

_LOCALHOST_IPS = {"127.0.0.1", "::1", "localhost"}

_RATE_WINDOW = 60  # seconds — kept as constant (not user-tunable)


class _RateBucket:
    __slots__ = ("timestamps",)

    def __init__(self):
        self.timestamps: list[float] = []

    def hit(self, now: float, window: float) -> int:
        cutoff = now - window
        self.timestamps = [t for t in self.timestamps if t > cutoff]
        self.timestamps.append(now)
        return len(self.timestamps)


class RemoteAuthMiddleware:
    """Pure ASGI middleware — does NOT wrap response bodies.

    Unlike BaseHTTPMiddleware, this passes `scope/receive/send` straight
    through to the downstream app, so StreamingResponse (SSE) works correctly.
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

        # Access app state from scope
        app_state = scope.get("app")
        settings = getattr(app_state, "state", None) and app_state.state.settings if app_state else None

        if not settings or not settings.remote_access_enabled:
            await self.app(scope, receive, send)
            return

        # Skip auth for non-API routes (static files, health, mobile pages)
        path = scope.get("path", "")
        if not path.startswith("/api/"):
            await self.app(scope, receive, send)
            return

        # Determine client IP
        client_ip = self._get_client_ip(scope)

        # Localhost bypass
        if client_ip in _LOCALHOST_IPS:
            scope.setdefault("state", {})["source"] = "local"
            await self.app(scope, receive, send)
            return

        # --- Non-localhost: enforce auth ---

        now = time.monotonic()

        # General rate limit
        req_count = self._request_buckets[client_ip].hit(now, _RATE_WINDOW)
        if req_count > self._max_requests:
            await self._send_json(send, 429, {"detail": "Rate limit exceeded"})
            return

        # Brute-force rate limit check
        failed_count = self._failed_auth_buckets[client_ip].hit(now, _RATE_WINDOW)
        self._failed_auth_buckets[client_ip].timestamps.pop()  # undo probe
        if failed_count > self._max_failed_auth:
            await self._send_json(send, 429, {"detail": "Too many failed authentication attempts"})
            return

        # Extract token from Authorization header or ?token= query param
        token = ""
        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode()
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
        else:
            qs = scope.get("query_string", b"").decode()
            params = parse_qs(qs)
            token_list = params.get("token", [])
            if token_list:
                token = token_list[0]

        if not token:
            await self._send_json(send, 401, {"detail": "Authentication required"})
            return

        # Validate
        from pathlib import Path
        token_path = Path(settings.remote_token_path)
        expected_token = load_token(token_path)

        if not expected_token or not validate_token(token, expected_token):
            self._failed_auth_buckets[client_ip].hit(now, _RATE_WINDOW)
            await self._send_json(send, 401, {"detail": "Invalid token"})
            return

        # Authenticated
        scope.setdefault("state", {})["source"] = "remote"
        await self.app(scope, receive, send)

    @staticmethod
    def _get_client_ip(scope) -> str:
        headers = dict(scope.get("headers", []))
        forwarded = headers.get(b"x-forwarded-for", b"").decode()
        if forwarded:
            return forwarded.split(",")[0].strip()
        client = scope.get("client")
        if client:
            return client[0]
        return "unknown"

    @staticmethod
    async def _send_json(send, status: int, body: dict) -> None:
        """Send a JSON error response directly via ASGI send."""
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
