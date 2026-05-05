"""Tests for the Route Module (app.api._route).

PR-B foundation tests — the Route class itself is exercised here; production
routers continue to use plain FastAPI APIRouter until PR-C migrates
sessions.py.
"""

from __future__ import annotations

import logging

import httpx
import pytest
from fastapi import FastAPI, Request
from pydantic import BaseModel

from app.api._route import Route, RouteSignatureError, _validate_and_bind
from app.errors import Conflict, NotFound, register_error_handlers


# ---------------------------------------------------------------------------
# Signature validation
# ---------------------------------------------------------------------------


def test_validation_rejects_sync_manager():
    def sync_manager(item_id: str) -> str:
        return item_id

    with pytest.raises(RouteSignatureError, match="must be `async def`"):
        _validate_and_bind(sync_manager, path="/items/{item_id}", body=None)


def test_validation_rejects_untyped_param():
    async def bad(item_id) -> str:  # noqa: ANN001
        return item_id

    with pytest.raises(RouteSignatureError, match="untyped"):
        _validate_and_bind(bad, path="/items/{item_id}", body=None)


def test_validation_rejects_forbidden_param_name():
    async def bad(request: str) -> str:
        return request

    with pytest.raises(RouteSignatureError, match="forbidden param"):
        _validate_and_bind(bad, path="/items", body=None)


def test_validation_rejects_request_typed_param():
    async def bad(req: Request) -> str:
        return "x"

    with pytest.raises(RouteSignatureError, match="FastAPI primitives"):
        _validate_and_bind(bad, path="/items", body=None)


def test_validation_rejects_path_placeholder_without_param():
    async def bad(other: str) -> str:
        return other

    with pytest.raises(RouteSignatureError, match="placeholder"):
        _validate_and_bind(bad, path="/items/{item_id}", body=None)


def test_validation_accepts_typed_path_only_manager():
    async def good(item_id: str) -> str:
        return item_id

    plan = _validate_and_bind(good, path="/items/{item_id}", body=None)
    assert plan.path == ["item_id"]
    assert plan.deps == {}
    assert plan.queries == {}
    assert plan.body_param is None
    assert plan.body_fields == []


# ---------------------------------------------------------------------------
# Test app — mounts a Route router for end-to-end dispatch tests
# ---------------------------------------------------------------------------


_STORE: dict[str, dict] = {}


class ItemCreate(BaseModel):
    name: str
    quantity: int


class Item(BaseModel):
    id: str
    name: str
    quantity: int


# Manager free functions — these would live in `app/<domain>/manager.py` in
# production. They take only the data they need; no FastAPI primitives.


async def list_items(limit: int = 10) -> list[Item]:
    return list(_STORE.values())[:limit]


async def get_item(item_id: str) -> Item | None:
    raw = _STORE.get(item_id)
    return Item(**raw) if raw else None


async def create_item(name: str, quantity: int) -> Item:
    item_id = f"item-{len(_STORE) + 1}"
    item = {"id": item_id, "name": name, "quantity": quantity}
    _STORE[item_id] = item
    return Item(**item)


async def create_item_via_model(body: ItemCreate) -> Item:
    return await create_item(name=body.name, quantity=body.quantity)


async def update_item(item_id: str, name: str, quantity: int) -> Item | None:
    if item_id not in _STORE:
        return None
    _STORE[item_id]["name"] = name
    _STORE[item_id]["quantity"] = quantity
    return Item(**_STORE[item_id])


async def delete_item(item_id: str) -> dict:
    if item_id not in _STORE:
        raise NotFound("item missing")
    del _STORE[item_id]
    return {"deleted": True}


def _build_app() -> FastAPI:
    _STORE.clear()
    app = FastAPI()
    register_error_handlers(app)

    route = Route(prefix="/items", tags=["items"])
    route.list("", manager=list_items, response_model=list[Item])
    route.get(
        "/{item_id}",
        manager=get_item,
        response_model=Item,
        not_found_on_none=True,
        not_found_message="item missing",
    )
    route.create("", manager=create_item, body=ItemCreate, response_model=Item)
    route.update(
        "/{item_id}",
        manager=update_item,
        body=ItemCreate,
        response_model=Item,
        not_found_on_none=True,
        not_found_message="item missing",
    )
    route.delete("/{item_id}", manager=delete_item)

    other = Route(prefix="/items-via-model", tags=["items"])
    other.create(
        "",
        manager=create_item_via_model,
        body=ItemCreate,
        response_model=Item,
    )

    app.include_router(route.api_router)
    app.include_router(other.api_router)
    return app


@pytest.fixture
async def client():
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------------------------------------------------------------------------
# CRUD dispatch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_then_create_then_get(client):
    assert (await client.get("/items")).json() == []

    resp = await client.post("/items", json={"name": "widget", "quantity": 3})
    assert resp.status_code == 201
    created = resp.json()
    assert created["name"] == "widget"
    assert created["quantity"] == 3

    item_id = created["id"]
    fetched = await client.get(f"/items/{item_id}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == item_id


@pytest.mark.asyncio
async def test_get_returns_404_when_manager_returns_none(client):
    resp = await client.get("/items/missing")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "item missing", "code": "not_found"}


@pytest.mark.asyncio
async def test_update_changes_state(client):
    await client.post("/items", json={"name": "a", "quantity": 1})
    resp = await client.patch("/items/item-1", json={"name": "b", "quantity": 7})
    assert resp.status_code == 200
    assert resp.json()["quantity"] == 7


@pytest.mark.asyncio
async def test_update_returns_404_on_missing(client):
    resp = await client.patch("/items/nope", json={"name": "x", "quantity": 1})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_propagates_domain_error(client):
    resp = await client.delete("/items/nope")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


@pytest.mark.asyncio
async def test_query_param_dispatch(client):
    for i in range(5):
        await client.post("/items", json={"name": f"x{i}", "quantity": i})
    resp = await client.get("/items?limit=3")
    assert resp.status_code == 200
    assert len(resp.json()) == 3


@pytest.mark.asyncio
async def test_body_passed_as_whole_model(client):
    resp = await client.post("/items-via-model", json={"name": "z", "quantity": 9})
    assert resp.status_code == 201
    assert resp.json()["name"] == "z"


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_audit_emits_one_line_per_request(client, caplog):
    with caplog.at_level(logging.INFO, logger="app.audit"):
        await client.post("/items", json={"name": "a", "quantity": 1})

    audit_records = [r for r in caplog.records if r.message.startswith("audit ")]
    assert len(audit_records) == 1
    msg = audit_records[0].message
    assert "user=anonymous" in msg
    assert "route=POST /items" in msg
    assert "status_code=201" in msg
    assert "duration_ms=" in msg


@pytest.mark.asyncio
async def test_audit_records_4xx_status(client, caplog):
    with caplog.at_level(logging.INFO, logger="app.audit"):
        await client.get("/items/missing")

    audit_records = [r for r in caplog.records if r.message.startswith("audit ")]
    assert len(audit_records) == 1
    assert "status_code=404" in audit_records[0].message


# ---------------------------------------------------------------------------
# Stream — open + close audit lines with shared stream_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_emits_open_then_close(caplog):
    from fastapi.responses import StreamingResponse

    app = FastAPI()
    register_error_handlers(app)
    route = Route(prefix="/s")

    async def echo_stream(stream_id: str, request: Request) -> StreamingResponse:
        async def gen():
            yield f"id={stream_id}\n".encode()
            yield b"chunk\n"

        return StreamingResponse(gen(), media_type="text/plain")

    route.stream("/echo", handler=echo_stream, method="GET")
    app.include_router(route.api_router)

    transport = httpx.ASGITransport(app=app)
    with caplog.at_level(logging.INFO, logger="app.audit"):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/s/echo")
            assert resp.status_code == 200
            assert b"chunk" in resp.content

    open_recs = [r for r in caplog.records if r.message.startswith("audit.stream.open")]
    close_recs = [r for r in caplog.records if r.message.startswith("audit.stream.close")]
    assert len(open_recs) == 1
    assert len(close_recs) == 1

    open_msg = open_recs[0].message
    close_msg = close_recs[0].message
    open_id = next(p.split("=")[1] for p in open_msg.split() if p.startswith("stream_id="))
    close_id = next(p.split("=")[1] for p in close_msg.split() if p.startswith("stream_id="))
    assert open_id == close_id
    assert "outcome=completed" in close_msg


@pytest.mark.asyncio
async def test_stream_close_records_error(caplog):
    app = FastAPI()
    register_error_handlers(app)
    route = Route(prefix="/s")

    async def boom(stream_id: str, request: Request):
        raise Conflict("nope")

    route.stream("/boom", handler=boom, method="GET")
    app.include_router(route.api_router)

    transport = httpx.ASGITransport(app=app)
    with caplog.at_level(logging.INFO, logger="app.audit"):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get("/s/boom")
            assert resp.status_code == 409

    close_recs = [r for r in caplog.records if r.message.startswith("audit.stream.close")]
    assert len(close_recs) == 1
    assert "outcome=error" in close_recs[0].message
    assert "error_class=Conflict" in close_recs[0].message


def test_stream_handler_must_accept_stream_id():
    route = Route()

    async def no_stream_id(request: Request):
        return None

    with pytest.raises(RouteSignatureError, match="stream_id"):
        route.stream("/x", handler=no_stream_id, method="GET")
