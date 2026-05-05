"""Tests for the DomainError hierarchy and FastAPI exception handler."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app.errors import (
    BadInput,
    Conflict,
    DomainError,
    InternalError,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    UpstreamError,
    register_error_handlers,
)


# ---------------------------------------------------------------------------
# Subclass status / code mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cls, status, code",
    [
        (BadInput, 400, "bad_input"),
        (Unauthenticated, 401, "unauthenticated"),
        (PermissionDenied, 403, "permission_denied"),
        (NotFound, 404, "not_found"),
        (Conflict, 409, "conflict"),
        (InternalError, 500, "internal_error"),
        (UpstreamError, 502, "upstream_error"),
    ],
)
def test_subclass_attributes(cls, status, code):
    assert cls.status_code == status
    assert cls.code == code
    inst = cls("boom")
    assert inst.detail == "boom"
    assert str(inst) == "boom"
    assert isinstance(inst, DomainError)


# ---------------------------------------------------------------------------
# Handler integration — raise from an endpoint, assert response shape
# ---------------------------------------------------------------------------


def _build_app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/notfound")
    async def _notfound():
        raise NotFound("missing")

    @app.get("/conflict")
    async def _conflict():
        raise Conflict("busy")

    @app.get("/upstream")
    async def _upstream():
        raise UpstreamError("provider down")

    @app.get("/badinput")
    async def _badinput():
        raise BadInput("nope")

    @app.get("/internal")
    async def _internal():
        raise InternalError("oops")

    return app


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path, status, code, detail",
    [
        ("/notfound", 404, "not_found", "missing"),
        ("/conflict", 409, "conflict", "busy"),
        ("/upstream", 502, "upstream_error", "provider down"),
        ("/badinput", 400, "bad_input", "nope"),
        ("/internal", 500, "internal_error", "oops"),
    ],
)
async def test_handler_response_shape(path, status, code, detail):
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(path)
    assert resp.status_code == status
    assert resp.json() == {"detail": detail, "code": code}


@pytest.mark.asyncio
async def test_handler_logs_5xx(caplog):
    """5xx domain errors emit a log line; 4xx do not."""
    import logging

    app = _build_app()
    transport = httpx.ASGITransport(app=app)

    with caplog.at_level(logging.ERROR, logger="app.errors"):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            await client.get("/notfound")
            assert not any("DomainError" in r.message for r in caplog.records)

            await client.get("/upstream")
            assert any(
                "DomainError 502 UpstreamError" in r.message and "/upstream" in r.message
                for r in caplog.records
            )
