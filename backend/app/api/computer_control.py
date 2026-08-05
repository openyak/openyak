"""User-facing status for native Computer Use."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.computer_runtime.capabilities import get_computer_capability_status

router = APIRouter(prefix="/computer-control")


class ComputerApplicationRequest(BaseModel):
    application: str


class ComputerControlRequest(BaseModel):
    owner: Literal["agent", "user"]


class ComputerInteractionRequest(BaseModel):
    action: Literal["click", "key", "scroll"]
    x: float | None = None
    y: float | None = None
    key: str | None = None
    modifiers: list[str] = Field(default_factory=list)
    delta_y: int | None = None


@router.get("/status")
async def computer_status() -> dict[str, object]:
    return dict(get_computer_capability_status())


def _computer_tool(request: Request) -> Any:
    registry = getattr(request.app.state, "tool_registry", None)
    tool = registry.get("computer") if registry is not None else None
    if tool is None or not hasattr(tool, "workspace_apps"):
        raise HTTPException(status_code=503, detail="Native Computer Use is unavailable")
    return tool


def _application_payload(application: Any) -> dict[str, object]:
    return {
        "id": application.identifier,
        "name": application.name,
        "pid": application.pid,
        "is_running": application.is_running,
    }


@router.get("/workspace/status")
async def computer_workspace_status(request: Request) -> dict[str, object]:
    tool = _computer_tool(request)
    applications = await tool.workspace_apps()
    return {
        "control_owner": tool.control_owner,
        "selected_application": tool.selected_application,
        "applications": [_application_payload(item) for item in applications],
    }


@router.post("/workspace/select")
async def select_computer_application(
    body: ComputerApplicationRequest,
    request: Request,
) -> dict[str, object]:
    tool = _computer_tool(request)
    try:
        application = await tool.select_workspace_application(body.application)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {
        "selected_application": application.identifier,
        "application": _application_payload(application),
    }


@router.get("/workspace/snapshot")
async def computer_workspace_snapshot(request: Request) -> dict[str, object]:
    tool = _computer_tool(request)
    try:
        state = await tool.workspace_snapshot()
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    bounds = state.screenshot_bounds
    frame = None
    if (
        bounds is not None
        and state.screenshot_width is not None
        and state.screenshot_height is not None
    ):
        frame = {
            "image_width": state.screenshot_width,
            "image_height": state.screenshot_height,
            "left": bounds[0],
            "top": bounds[1],
            "width": bounds[2],
            "height": bounds[3],
        }
    return {
        "application": {
            "id": state.app.identifier,
            "name": state.app.name,
            "pid": state.app.pid,
        },
        "revision": state.revision,
        "image_data_url": state.screenshot_data_url,
        "frame": frame,
    }


@router.post("/workspace/control")
async def set_computer_workspace_control(
    body: ComputerControlRequest,
    request: Request,
) -> dict[str, str]:
    tool = _computer_tool(request)
    if body.owner == "user":
        await tool.take_over()
    else:
        await tool.resume_agent()
    return {"control_owner": tool.control_owner}


@router.post("/workspace/interact")
async def interact_with_computer_workspace(
    body: ComputerInteractionRequest,
    request: Request,
) -> dict[str, bool]:
    tool = _computer_tool(request)
    try:
        if body.action == "click":
            if body.x is None or body.y is None:
                raise ValueError("click requires x and y")
            await tool.workspace_click(body.x, body.y)
        elif body.action == "key":
            if body.key is None:
                raise ValueError("key action requires key")
            await tool.workspace_key(body.key, body.modifiers)
        else:
            if body.delta_y is None or body.delta_y == 0:
                raise ValueError("scroll requires a non-zero delta_y")
            await tool.workspace_scroll(body.delta_y)
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"ok": True}
