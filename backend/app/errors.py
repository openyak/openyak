"""Domain error hierarchy and FastAPI exception handler.

Every layer of the application — manager free functions, services, route
handlers — raises a :class:`DomainError` subclass instead of
``fastapi.HTTPException``. A single handler registered via
:func:`register_error_handlers` translates them to ``JSONResponse`` with the
subclass's ``status_code`` and a stable ``code`` string.

Why not raise ``HTTPException`` directly:

- It couples the manager layer to the web framework.
- It makes the response shape ad-hoc per call site (``detail`` strings drift,
  there is no machine-readable code field).
- It bypasses any cross-cutting concern (audit log, metrics) we may want to
  attach at the boundary.

Per ADR-0007 (Route Module + DomainError → HTTPException mapping). Subclass
list seeded by the categories raised across ``app/api/``: 4xx for client
errors, 5xx reserved for ``UpstreamError`` (external dependency failed) and
``InternalError`` (unwrappable 5xx — used sparingly).
"""

from __future__ import annotations

import logging
from typing import ClassVar

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)


class DomainError(Exception):
    """Base for application errors with a fixed HTTP status mapping."""

    status_code: ClassVar[int] = 500
    code: ClassVar[str] = "domain_error"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class BadInput(DomainError):
    status_code: ClassVar[int] = 400
    code: ClassVar[str] = "bad_input"


class Unauthenticated(DomainError):
    status_code: ClassVar[int] = 401
    code: ClassVar[str] = "unauthenticated"


class PermissionDenied(DomainError):
    status_code: ClassVar[int] = 403
    code: ClassVar[str] = "permission_denied"


class NotFound(DomainError):
    status_code: ClassVar[int] = 404
    code: ClassVar[str] = "not_found"


class Conflict(DomainError):
    status_code: ClassVar[int] = 409
    code: ClassVar[str] = "conflict"


class InternalError(DomainError):
    """Unwrappable 5xx — only when no narrower category fits."""

    status_code: ClassVar[int] = 500
    code: ClassVar[str] = "internal_error"


class UpstreamError(DomainError):
    """An external dependency (provider, MCP server, OAuth issuer) failed."""

    status_code: ClassVar[int] = 502
    code: ClassVar[str] = "upstream_error"


async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
    if exc.status_code >= 500:
        log.error(
            "DomainError %d %s on %s %s: %s",
            exc.status_code,
            type(exc).__name__,
            request.method,
            request.url.path,
            exc.detail,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
    )


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(DomainError, domain_error_handler)
