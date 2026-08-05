"""User-facing controls for OpenYak's shared managed Browser workspace."""

from __future__ import annotations

import base64
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/browser-control")


class BrowserControlRequest(BaseModel):
    owner: Literal["agent", "user"]


class BrowserInteractionRequest(BaseModel):
    action: Literal[
        "new_tab", "navigate", "back", "forward", "reload", "close_tab", "click",
        "type", "key", "scroll",
    ]
    tab_id: str | None = None
    url: str | None = None
    x: float | None = None
    y: float | None = None
    text: str | None = None
    key: str | None = None
    delta_y: int | None = None


def _runtime(request: Request) -> Any:
    registry = getattr(request.app.state, "tool_registry", None)
    tool = registry.get("browser") if registry is not None else None
    runtime = getattr(tool, "runtime", None)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Managed Browser is unavailable")
    return runtime


@router.get("/status")
async def browser_status(request: Request) -> dict[str, Any]:
    runtime = _runtime(request)
    tabs = await runtime.list_tabs()
    return {
        "control_owner": getattr(runtime, "control_owner", "agent"),
        "tabs": [
            {"id": tab.id, "url": tab.url, "title": tab.title}
            for tab in tabs
        ],
    }


@router.post("/control")
async def set_browser_control(
    body: BrowserControlRequest,
    request: Request,
) -> dict[str, str]:
    runtime = _runtime(request)
    if body.owner == "user":
        await runtime.take_over()
    else:
        await runtime.resume_agent()
    return {"control_owner": getattr(runtime, "control_owner", body.owner)}


@router.get("/snapshot")
async def browser_snapshot(tab_id: str, request: Request) -> dict[str, Any]:
    try:
        observation = dict(await _runtime(request).observe(tab_id))
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    image = observation.pop("screenshot", None)
    observation["image_data_url"] = (
        "data:image/png;base64," + base64.b64encode(image).decode("ascii")
        if image
        else None
    )
    return observation


@router.post("/interact")
async def interact_with_browser(
    body: BrowserInteractionRequest,
    request: Request,
) -> dict[str, Any]:
    runtime = _runtime(request)
    if getattr(runtime, "control_owner", "agent") != "user":
        raise HTTPException(
            status_code=409,
            detail="Take over the Browser before sending manual input",
        )
    try:
        if body.action == "new_tab":
            return {"ok": True, "tab_id": await runtime.new_tab()}

        if not body.tab_id:
            raise HTTPException(status_code=422, detail="tab_id is required")
        if body.action == "navigate":
            if not body.url:
                raise HTTPException(status_code=422, detail="url is required")
            await runtime.navigate(body.tab_id, _safe_browser_url(body.url))
        elif body.action in {"back", "forward", "reload"}:
            await runtime.history(body.tab_id, body.action)
        elif body.action == "close_tab":
            await runtime.close_tab(body.tab_id)
        elif body.action == "click":
            if body.x is None or body.y is None:
                raise HTTPException(status_code=422, detail="x and y are required")
            await runtime.coordinate_click(
                body.tab_id,
                body.x,
                body.y,
                button="left",
                click_count=1,
            )
        elif body.action == "type":
            if body.text is None:
                raise HTTPException(status_code=422, detail="text is required")
            await runtime.manual_type(body.tab_id, body.text[:20_000])
        elif body.action == "key":
            if not body.key or not body.key.strip():
                raise HTTPException(status_code=422, detail="key is required")
            await runtime.press(body.tab_id, body.key.strip())
        elif body.action == "scroll":
            if body.delta_y is None:
                raise HTTPException(status_code=422, detail="delta_y is required")
            await runtime.scroll(
                body.tab_id,
                max(-10_000, min(10_000, body.delta_y)),
            )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"ok": True}


def _safe_browser_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=422, detail="Only http:// and https:// URLs are allowed")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=422, detail="URLs containing credentials are not allowed")
    return value.strip()
