from __future__ import annotations

import asyncio

import pytest

from app.computer_runtime.base import AppDescriptor, AppState, ElementSnapshot
from app.tool.builtin.computer import ComputerTool
from app.tool.context import ToolContext
from app.schemas.agent import AgentInfo


class _WorkspaceRuntime:
    def __init__(self) -> None:
        self.apps = [
            AppDescriptor("Notes", "com.example.notes", 42),
            AppDescriptor("Terminal", "com.apple.Terminal", 43),
        ]
        self.elements = [
            ElementSnapshot(0, "Window", "Notes", bounds=(10, 20, 600, 400))
        ]
        self.calls: list[tuple] = []

    def list_apps(self):
        return self.apps

    def get_app_state(self, app, *, session_id, disable_diff=False):
        assert app == "com.example.notes"
        assert session_id in {"__openyak_computer_workspace__", "agent-session"}
        if session_id == "__openyak_computer_workspace__":
            assert disable_diff is True
        return AppState(
            app=self.apps[0],
            elements=self.elements,
            screenshot_data_url="data:image/png;base64,aW1hZ2U=",
            screenshot_width=1200,
            screenshot_height=800,
            screenshot_bounds=(10, 20, 600, 400),
            revision=3,
        )

    def click(self, app, **kwargs):
        self.calls.append(("click", app, kwargs))

    def press_key(self, app, **kwargs):
        self.calls.append(("press_key", app, kwargs))

    def wait_for_stability(self, app, **kwargs):
        self.calls.append(("stability", app, kwargs))


def _tool_context() -> ToolContext:
    return ToolContext(
        session_id="agent-session",
        message_id="message-1",
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="call-1",
        abort_event=asyncio.Event(),
    )


@pytest.mark.asyncio
async def test_computer_status_reports_macos_system_permissions(
    app_client, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.api.computer_control.get_computer_capability_status",
        lambda: {
            "platform": "macos",
            "supported": True,
            "interaction_mode": "background",
            "accessibility": "granted",
            "screen_recording": "denied",
            "runtime": "available",
            "settings_url": (
                "x-apple.systempreferences:com.apple.preference.security"
                "?Privacy_Accessibility"
            ),
        },
    )

    response = await app_client.get("/api/computer-control/status")

    assert response.status_code == 200
    assert response.json() == {
        "platform": "macos",
        "supported": True,
        "interaction_mode": "background",
        "accessibility": "granted",
        "screen_recording": "denied",
        "runtime": "available",
        "settings_url": (
            "x-apple.systempreferences:com.apple.preference.security"
            "?Privacy_Accessibility"
        ),
    }


@pytest.mark.asyncio
async def test_computer_status_explains_windows_foreground_constraint(
    app_client, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.api.computer_control.get_computer_capability_status",
        lambda: {
            "platform": "windows",
            "supported": True,
            "interaction_mode": "foreground",
            "accessibility": "not_applicable",
            "screen_recording": "not_applicable",
            "runtime": "available",
            "settings_url": None,
        },
    )

    response = await app_client.get("/api/computer-control/status")

    assert response.status_code == 200
    assert response.json()["interaction_mode"] == "foreground"
    assert response.json()["runtime"] == "available"


@pytest.mark.asyncio
async def test_workspace_lists_safe_apps_and_switches_the_shared_target(app_client) -> None:
    tool = ComputerTool(_WorkspaceRuntime())
    app_client.app.state.tool_registry.get.return_value = tool

    status = await app_client.get("/api/computer-control/workspace/status")

    assert status.status_code == 200
    assert status.json() == {
        "control_owner": "agent",
        "selected_application": None,
        "applications": [
            {
                "id": "com.example.notes",
                "name": "Notes",
                "pid": 42,
                "is_running": True,
            }
        ],
    }

    selected = await app_client.post(
        "/api/computer-control/workspace/select",
        json={"application": "com.example.notes"},
    )

    assert selected.status_code == 200
    assert selected.json() == {
        "selected_application": "com.example.notes",
        "application": {
            "id": "com.example.notes",
            "name": "Notes",
            "pid": 42,
            "is_running": True,
        },
    }


@pytest.mark.asyncio
async def test_workspace_returns_a_live_native_application_frame(app_client) -> None:
    tool = ComputerTool(_WorkspaceRuntime())
    app_client.app.state.tool_registry.get.return_value = tool
    await app_client.post(
        "/api/computer-control/workspace/select",
        json={"application": "com.example.notes"},
    )

    snapshot = await app_client.get("/api/computer-control/workspace/snapshot")

    assert snapshot.status_code == 200
    assert snapshot.json() == {
        "application": {"id": "com.example.notes", "name": "Notes", "pid": 42},
        "revision": 3,
        "image_data_url": "data:image/png;base64,aW1hZ2U=",
        "frame": {
            "image_width": 1200,
            "image_height": 800,
            "left": 10,
            "top": 20,
            "width": 600,
            "height": 400,
        },
    }


@pytest.mark.asyncio
async def test_user_takeover_pauses_agent_actions_until_control_is_returned(
    app_client,
) -> None:
    runtime = _WorkspaceRuntime()
    tool = ComputerTool(runtime)
    app_client.app.state.tool_registry.get.return_value = tool

    takeover = await app_client.post(
        "/api/computer-control/workspace/control", json={"owner": "user"}
    )
    assert takeover.json() == {"control_owner": "user"}

    pending = asyncio.create_task(
        tool(
            {
                "action": "click",
                "application": "com.example.notes",
                "element_index": 0,
            },
            _tool_context(),
        )
    )
    await asyncio.sleep(0)
    assert not pending.done()
    assert runtime.calls == []

    returned = await app_client.post(
        "/api/computer-control/workspace/control", json={"owner": "agent"}
    )
    assert returned.json() == {"control_owner": "agent"}
    result = await asyncio.wait_for(pending, timeout=1)
    assert result.success
    assert runtime.calls[0][0] == "click"


@pytest.mark.asyncio
async def test_takeover_wins_when_an_agent_action_is_waiting_for_the_runtime() -> None:
    runtime = _WorkspaceRuntime()
    tool = ComputerTool(runtime)
    await tool._operation_lock.acquire()
    pending = asyncio.create_task(
        tool(
            {
                "action": "click",
                "application": "com.example.notes",
                "element_index": 0,
            },
            _tool_context(),
        )
    )
    await asyncio.sleep(0)

    takeover = asyncio.create_task(tool.take_over())
    await asyncio.sleep(0)
    tool._operation_lock.release()
    await asyncio.wait_for(takeover, timeout=1)
    await asyncio.sleep(0)

    assert not pending.done()
    assert runtime.calls == []
    await tool.resume_agent()
    result = await asyncio.wait_for(pending, timeout=1)
    assert result.success


@pytest.mark.asyncio
async def test_user_clicks_the_live_frame_in_native_window_coordinates(app_client) -> None:
    runtime = _WorkspaceRuntime()
    tool = ComputerTool(runtime)
    app_client.app.state.tool_registry.get.return_value = tool
    await app_client.post(
        "/api/computer-control/workspace/select",
        json={"application": "com.example.notes"},
    )
    await app_client.post(
        "/api/computer-control/workspace/control", json={"owner": "user"}
    )

    clicked = await app_client.post(
        "/api/computer-control/workspace/interact",
        json={"action": "click", "x": 600, "y": 400},
    )

    assert clicked.status_code == 200
    assert clicked.json()["ok"] is True
    assert runtime.calls[0] == (
        "click",
        "com.example.notes",
        {
            "session_id": "__openyak_computer_workspace__",
            "element_index": None,
            "x": 310.0,
            "y": 220.0,
            "button": "left",
            "click_count": 1,
        },
    )


@pytest.mark.asyncio
async def test_user_click_prefers_the_accessible_element_under_the_pointer(
    app_client,
) -> None:
    runtime = _WorkspaceRuntime()
    runtime.elements.append(
        ElementSnapshot(
            7,
            "AXButton",
            "Save",
            bounds=(280, 200, 60, 40),
            actions=("Press",),
        )
    )
    tool = ComputerTool(runtime)
    app_client.app.state.tool_registry.get.return_value = tool
    await app_client.post(
        "/api/computer-control/workspace/select",
        json={"application": "com.example.notes"},
    )
    await app_client.post(
        "/api/computer-control/workspace/control", json={"owner": "user"}
    )

    clicked = await app_client.post(
        "/api/computer-control/workspace/interact",
        json={"action": "click", "x": 600, "y": 400},
    )

    assert clicked.status_code == 200
    assert runtime.calls[0] == (
        "click",
        "com.example.notes",
        {
            "session_id": "__openyak_computer_workspace__",
            "element_index": 7,
            "x": None,
            "y": None,
            "button": "left",
            "click_count": 1,
        },
    )


@pytest.mark.asyncio
async def test_user_keyboard_input_is_sent_only_during_takeover(app_client) -> None:
    runtime = _WorkspaceRuntime()
    tool = ComputerTool(runtime)
    app_client.app.state.tool_registry.get.return_value = tool
    await app_client.post(
        "/api/computer-control/workspace/select",
        json={"application": "com.example.notes"},
    )

    blocked = await app_client.post(
        "/api/computer-control/workspace/interact",
        json={"action": "key", "key": "a", "modifiers": ["shift"]},
    )
    assert blocked.status_code == 409
    assert runtime.calls == []

    await app_client.post(
        "/api/computer-control/workspace/control", json={"owner": "user"}
    )
    sent = await app_client.post(
        "/api/computer-control/workspace/interact",
        json={"action": "key", "key": "a", "modifiers": ["shift"]},
    )

    assert sent.status_code == 200
    assert runtime.calls == [
        (
            "press_key",
            "com.example.notes",
            {
                "session_id": "__openyak_computer_workspace__",
                "key": "a",
                "modifiers": ["shift"],
            },
        )
    ]
