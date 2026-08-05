from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import pytest

from app.computer_runtime.base import AppDescriptor, AppState, ElementSnapshot
from app.computer_runtime.macos import MacOSComputerRuntime
from app.computer_runtime.state import StateStore
from app.computer_runtime.windows import WindowsComputerRuntime
from app.schemas.agent import AgentInfo
from app.tool.builtin.computer import ComputerTool, _state_to_result
from app.tool.context import ToolContext


class FakeSemanticRuntime:
    def __init__(self) -> None:
        self.app = AppDescriptor("Notes", "com.example.notes", 42)
        self.elements = [
            ElementSnapshot(0, "AXWindow", "Todo", bounds=(10, 20, 600, 400)),
            ElementSnapshot(1, "AXTextArea", "Body", "alpha", focused=True, parent=0),
            ElementSnapshot(2, "AXButton", "Save", parent=0),
        ]
        self.calls: list[tuple] = []
        self.revision = 0

    def list_apps(self):
        return [self.app]

    def get_app_state(self, app, *, session_id, disable_diff=False):
        self.calls.append(("state", app, session_id, disable_diff))
        self.revision += 1
        return AppState(
            app=self.app,
            elements=self.elements if self.revision == 1 or disable_diff else [],
            screenshot_data_url="data:image/png;base64,aW1hZ2U=",
            screenshot_width=600,
            screenshot_height=400,
            revision=self.revision,
            changed_indices=[0, 1, 2] if self.revision == 1 else [],
            is_diff=self.revision > 1 and not disable_diff,
        )

    def click(self, app, **kwargs): self.calls.append(("click", app, kwargs))
    def drag(self, app, **kwargs): self.calls.append(("drag", app, kwargs))
    def set_value(self, app, **kwargs): self.calls.append(("set_value", app, kwargs))
    def type_text(self, app, **kwargs): self.calls.append(("type_text", app, kwargs))
    def press_key(self, app, **kwargs): self.calls.append(("press_key", app, kwargs))
    def scroll(self, app, **kwargs): self.calls.append(("scroll", app, kwargs))
    def select_text(self, app, **kwargs): self.calls.append(("select_text", app, kwargs))
    def perform_secondary_action(self, app, **kwargs): self.calls.append(("secondary", app, kwargs))
    def wait_for_stability(self, app, **kwargs): self.calls.append(("stability", app, kwargs))


def _ctx(session_id: str = "session-1") -> ToolContext:
    return ToolContext(
        session_id=session_id,
        message_id="message-1",
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="call-1",
        abort_event=asyncio.Event(),
    )


async def test_get_app_state_returns_accessibility_tree_and_screenshot():
    runtime = FakeSemanticRuntime()
    result = await ComputerTool(runtime)(
        {"action": "get_app_state", "application": "Notes"}, _ctx()
    )

    assert result.success
    payload = json.loads(result.output)
    assert payload["application"]["identifier"] == "com.example.notes"
    assert '[1] AXTextArea name="Body" value="alpha"' in payload["text"]
    assert result.attachments[0]["mime_type"] == "image/png"
    assert result.metadata["surface"] == "native"


async def test_element_click_does_not_require_focus_or_coordinate_observation():
    runtime = FakeSemanticRuntime()
    result = await ComputerTool(runtime)(
        {"action": "click", "application": "Notes", "element_index": 2}, _ctx()
    )

    assert result.success
    assert runtime.calls[0] == (
        "click",
        "Notes",
        {
            "session_id": "session-1",
            "element_index": 2,
            "x": None,
            "y": None,
            "button": "left",
            "click_count": 1,
        },
    )
    assert all(call[0] != "focus" for call in runtime.calls)


async def test_action_returns_compact_state_diff():
    runtime = FakeSemanticRuntime()
    tool = ComputerTool(runtime)
    await tool({"action": "get_app_state", "application": "Notes"}, _ctx())
    result = await tool(
        {"action": "set_value", "application": "Notes", "element_index": 1, "value": "beta"},
        _ctx(),
    )

    payload = json.loads(result.output)
    assert payload["is_diff"] is True
    assert "[1] AXTextArea" not in payload["text"]
    assert runtime.calls[1][0] == "set_value"


async def test_state_is_scoped_by_agent_session():
    runtime = FakeSemanticRuntime()
    tool = ComputerTool(runtime)
    await tool({"action": "get_app_state", "application": "Notes"}, _ctx("a"))
    await tool({"action": "get_app_state", "application": "Notes"}, _ctx("b"))

    assert runtime.calls[0][2] == "a"
    assert runtime.calls[1][2] == "b"


async def test_sensitive_application_is_blocked_before_runtime_access():
    runtime = FakeSemanticRuntime()
    result = await ComputerTool(runtime)(
        {"action": "get_app_state", "application": "1Password"}, _ctx()
    )

    assert not result.success
    assert "blocked for sensitive application" in (result.error or "")
    assert runtime.calls == []


async def test_list_apps_has_stable_identifiers():
    runtime = FakeSemanticRuntime()
    runtime.list_apps = lambda: [
        runtime.app,
        AppDescriptor("Terminal", "com.apple.Terminal", 43),
    ]
    result = await ComputerTool(runtime)({"action": "list_apps"}, _ctx())
    payload = json.loads(result.output)
    assert payload == {
        "applications": [{
            "id": "com.example.notes",
            "displayName": "Notes",
            "isRunning": True,
            "name": "Notes",
            "identifier": "com.example.notes",
            "pid": 42,
        }]
    }


async def test_codex_parity_actions_are_dispatched_with_exact_semantics():
    runtime = FakeSemanticRuntime()
    tool = ComputerTool(runtime)

    await tool({
        "action": "drag", "application": "Notes",
        "from_x": 20, "from_y": 30, "to_x": 80, "to_y": 90,
    }, _ctx())
    await tool({
        "action": "scroll", "application": "Notes", "element_index": 0,
        "direction": "down", "pages": 2,
    }, _ctx())
    await tool({
        "action": "select_text", "application": "Notes", "element_index": 1,
        "text": "alpha", "prefix": "", "suffix": "", "selection_type": "text",
    }, _ctx())
    await tool({
        "action": "perform_secondary_action", "application": "Notes",
        "element_index": 2, "secondary_action": "Show Menu",
    }, _ctx())

    assert runtime.calls[0] == (
        "drag", "Notes", {
            "session_id": "session-1", "from_x": 20.0, "from_y": 30.0,
            "to_x": 80.0, "to_y": 90.0,
        },
    )
    assert any(call[0] == "scroll" and call[2]["pages"] == 2 for call in runtime.calls)
    assert any(call[0] == "select_text" for call in runtime.calls)
    assert any(
        call[0] == "secondary" and call[2]["action"] == "Show Menu"
        for call in runtime.calls
    )


async def test_action_time_confirmation_and_handoff_are_enforced():
    runtime = FakeSemanticRuntime()
    confirmations = []
    context = _ctx()

    async def ask(permission, patterns, arguments, message):
        confirmations.append((permission, patterns, arguments, message))
        return True

    context._ask_fn = ask
    result = await ComputerTool(runtime)({
        "action": "click", "application": "Notes", "element_index": 2,
        "confirmation_mode": "action",
        "confirmation_reason": "Permanently deletes the note",
    }, context)
    assert result.success
    assert confirmations[0][0] == "computer.sensitive_action"
    assert confirmations[0][2]["action"] == "click"

    result = await ComputerTool(runtime)({
        "action": "click", "application": "Notes", "element_index": 2,
        "confirmation_mode": "handoff",
        "confirmation_reason": "Changes an account password",
    }, _ctx())
    assert not result.success
    assert "hand-off required" in (result.error or "")


def test_state_store_assigns_stable_non_recycled_indices():
    store = StateStore()
    assert store.index_for("s", "app", "window") == 0
    assert store.index_for("s", "app", "save") == 1
    assert store.index_for("s", "app", "window") == 0
    assert store.index_for("s", "app", "new") == 2


def test_large_native_state_is_serialized_once_for_token_efficiency():
    state = AppState(
        app=AppDescriptor("Large App", "com.example.large", 99),
        elements=[
            ElementSnapshot(
                index=index,
                role="AXButton",
                name=f"Control {index}",
                actions=("Press", "Show Menu"),
                bounds=(10.0, float(index), 100.0, 20.0),
            )
            for index in range(300)
        ],
        revision=1,
        changed_indices=list(range(300)),
    )
    result = _state_to_result("get_app_state", state)
    payload = json.loads(result.output)

    assert "elements" not in payload
    assert "[299] AXButton" in payload["text"]
    assert len(result.output.encode("utf-8")) < 50 * 1024


def test_native_state_is_bounded_before_generic_tool_truncation():
    state = AppState(
        app=AppDescriptor("Large App", "com.example.large", 99),
        elements=[
            ElementSnapshot(
                index=index,
                role="AXStaticText",
                name=f"Control {index}",
                value="long accessible value " * 30,
                description="long accessible description " * 20,
                bounds=(10.0, float(index), 500.0, 20.0),
            )
            for index in range(900)
        ],
        screenshot_data_url="data:image/png;base64,aW1hZ2U=",
        screenshot_width=600,
        screenshot_height=400,
        revision=1,
        changed_indices=list(range(900)),
    )

    result = _state_to_result("get_app_state", state)
    payload = json.loads(result.output)

    assert payload["element_count"] == 900
    assert payload["screenshot"] == {"width": 600, "height": 400}
    assert "additional elements omitted" in payload["text"]
    assert len(result.output.encode("utf-8")) < 50 * 1024


def test_macos_key_parser_accepts_xdotool_style_chords():
    from app.computer_runtime.macos import _parse_key_chord

    assert _parse_key_chord("super+c") == ("c", ["super"])
    assert _parse_key_chord("KP_0") == ("kp_0", [])
    assert _parse_key_chord("A") == ("a", ["shift"])


def test_state_store_computes_changed_and_removed_elements():
    store = StateStore()
    original = [ElementSnapshot(0, "Window", "Main"), ElementSnapshot(1, "Button", "Save")]
    revision, changed, removed = store.save("s", "app", original, {0: "w", 1: "b"})
    assert (revision, changed, removed) == (1, [0, 1], [])

    updated = [replace(original[0], name="Renamed")]
    revision, changed, removed = store.save("s", "app", updated, {0: "w"})
    assert revision == 2
    assert changed == [0]
    assert removed == [1]


def test_state_store_rejects_stale_element_index():
    store = StateStore()
    store.save("s", "app", [ElementSnapshot(0, "Window")], {0: object()})
    with pytest.raises(ValueError, match="stale or unknown"):
        store.handle("s", "app", 9)


def test_coordinate_fallback_is_scoped_to_latest_app_window():
    store = StateStore()
    store.save(
        "s", "app",
        [ElementSnapshot(0, "Window", bounds=(100, 200, 300, 200))],
        {0: object()},
    )
    store.require_coordinate_within_app("s", "app", 150, 250)
    with pytest.raises(ValueError, match="outside"):
        store.require_coordinate_within_app("s", "app", 50, 50)


def test_windows_uia_snapshot_and_element_click_do_not_focus(monkeypatch):
    class Rect:
        left, top, right, bottom = 10, 20, 310, 220
        def width(self): return self.right - self.left
        def height(self): return self.bottom - self.top

    class ValuePattern:
        Value = "hello"
        def SetValue(self, value): self.Value = value

    class Control:
        ControlTypeName = "EditControl"
        Name = "Body"
        HelpText = ""
        AutomationId = "body"
        IsEnabled = True
        HasKeyboardFocus = False
        BoundingRectangle = Rect()
        def __init__(self): self.clicked = False; self.value_pattern = ValuePattern()
        def GetValuePattern(self): return self.value_pattern
        def GetChildren(self): return []
        def Click(self, *, simulateMove): self.clicked = not simulateMove

    control = Control()
    runtime = object.__new__(WindowsComputerRuntime)
    runtime._auto = type("Auto", (), {"ControlFromHandle": staticmethod(lambda _handle: control)})()
    runtime._states = StateStore()
    app = AppDescriptor("Editor", "123", 7)
    monkeypatch.setattr(runtime, "_resolve_app", lambda _query: app)
    monkeypatch.setattr(
        "app.computer_runtime.windows._capture_window",
        lambda _root: ("data:image/png;base64,aW1hZ2U=", 300, 200, (10, 20, 300, 200)),
    )

    state = runtime.get_app_state("Editor", session_id="windows", disable_diff=True)
    runtime.click("Editor", session_id="windows", element_index=0)

    assert state.elements[0].role == "EditControl"
    assert state.elements[0].value == "hello"
    assert state.screenshot_width == 300
    assert control.clicked is True


def test_windows_coordinate_and_keyboard_input_activate_the_target_window(monkeypatch):
    calls = []

    class User32:
        def ShowWindow(self, hwnd, command): calls.append(("show", hwnd, command))
        def SetForegroundWindow(self, hwnd): calls.append(("foreground", hwnd)); return 1

    class Auto:
        def Click(self, x, y, *, waitTime): calls.append(("click", x, y, waitTime))
        def SendKeys(self, keys, *, waitTime): calls.append(("keys", keys, waitTime))

    runtime = object.__new__(WindowsComputerRuntime)
    runtime._auto = Auto()
    runtime._user32 = User32()
    runtime._states = StateStore()
    app = AppDescriptor("Editor", "123", 7)
    monkeypatch.setattr(runtime, "_resolve_app", lambda _query: app)
    runtime._states.save(
        "windows", app.identifier,
        [ElementSnapshot(0, "Window", bounds=(10, 20, 300, 200))],
        {0: object()},
    )

    runtime.click("Editor", session_id="windows", x=100, y=100)
    runtime.press_key("Editor", session_id="windows", key="escape")

    assert calls == [
        ("show", 123, 9),
        ("foreground", 123),
        ("click", 100, 100, 0),
        ("show", 123, 9),
        ("foreground", 123),
        ("keys", "{Esc}", 0),
    ]


def test_macos_coordinate_input_activates_the_target_application(monkeypatch):
    calls = []

    class RunningApplication:
        def processIdentifier(self): return 42
        def activateWithOptions_(self, options): calls.append(("activate", options)); return True

    class Workspace:
        def runningApplications(self): return [RunningApplication()]

    class AX:
        @staticmethod
        def AXIsProcessTrusted(): return True

    class Quartz:
        kCGEventLeftMouseDown = 1
        kCGEventLeftMouseUp = 2
        kCGMouseButtonLeft = 0
        kCGHIDEventTap = 4
        @staticmethod
        def CGEventCreateMouseEvent(_source, event_type, point, button):
            return (event_type, point, button)
        @staticmethod
        def CGEventPost(tap, event): calls.append(("event", tap, event))

    runtime = object.__new__(MacOSComputerRuntime)
    runtime._ax = AX()
    runtime._quartz = Quartz()
    runtime._workspace = Workspace()
    runtime._states = StateStore()
    app = AppDescriptor("Notes", "com.example.notes", 42)
    monkeypatch.setattr(runtime, "_resolve_app", lambda _query: app)
    runtime._states.save(
        "macos", app.identifier,
        [ElementSnapshot(0, "AXWindow", bounds=(10, 20, 300, 200))],
        {0: object()},
    )

    runtime.click("Notes", session_id="macos", x=100, y=100)

    assert calls[0] == ("activate", 3)
    assert [call[0] for call in calls[1:]] == ["event", "event"]
