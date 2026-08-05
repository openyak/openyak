from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from app.schemas.agent import AgentInfo
from app.tool.builtin.browser import BrowserTool
from app.tool.context import ToolContext
from app.browser_runtime import PlaywrightBrowserRuntime, _normalize_key


@dataclass
class FakeTab:
    id: str
    url: str
    title: str


class FakeBrowserRuntime:
    def __init__(self) -> None:
        self.url = "https://example.test/start"
        self.calls: list[tuple] = []

    async def list_tabs(self): return [FakeTab("tab-1", self.url, "Example")]
    async def open(self, url): self.calls.append(("open", url)); self.url = url; return "tab-1"
    async def navigate(self, tab_id, url): self.calls.append(("navigate", tab_id, url)); self.url = url
    async def current_url(self, tab_id): return self.url
    async def snapshot(self, tab_id, *, include_screenshot=True):
        self.calls.append(("snapshot", tab_id, include_screenshot))
        return {
            "tab_id": tab_id,
            "url": self.url,
            "title": "Example",
            "tabs": [{"id": "tab-1", "url": self.url, "title": "Example"}],
            "elements": [{"ref": "e1", "role": "button", "name": "Continue"}],
            "text": "Hello",
            "screenshot": b"png",
        }
    async def inspect_ref(self, tab_id, ref):
        self.calls.append(("inspect", tab_id, ref))
        return {"role": "button", "name": "Continue", "input_type": ""}
    async def click(self, tab_id, ref, **kwargs): self.calls.append(("click", tab_id, ref, kwargs))
    async def fill(self, tab_id, ref, value): self.calls.append(("fill", tab_id, ref, value))
    async def type_text(self, tab_id, ref, text): self.calls.append(("type", tab_id, ref, text))
    async def press(self, tab_id, key, ref=None): self.calls.append(("press", tab_id, key, ref))
    async def select_option(self, tab_id, ref, value): self.calls.append(("select", tab_id, ref, value))
    async def set_checked(self, tab_id, ref, checked): self.calls.append(("checked", tab_id, ref, checked))
    async def scroll(self, tab_id, delta_y, ref=None): self.calls.append(("scroll", tab_id, delta_y, ref))
    async def coordinate_click(self, tab_id, x, y, **kwargs): self.calls.append(("coord", tab_id, x, y, kwargs))
    async def drag(self, tab_id, from_x, from_y, to_x, to_y): self.calls.append(("drag", tab_id, from_x, from_y, to_x, to_y))
    async def hover(self, tab_id, x, y): self.calls.append(("hover", tab_id, x, y))
    async def clipboard(self, tab_id, *, text=None): self.calls.append(("clipboard", tab_id, text)); return text or "copied"
    async def logs(self, tab_id, *, kind="console", limit=200): return [{"kind": kind, "limit": limit}]
    async def dialog(self, tab_id, *, response, text=""): return {"response": response, "text": text}
    async def history(self, tab_id, direction): self.calls.append(("history", tab_id, direction))
    async def close_tab(self, tab_id): self.calls.append(("close", tab_id))
    async def close(self): self.calls.append(("runtime_close",))


class GatedBrowserRuntime(FakeBrowserRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.agent_control = asyncio.Event()

    async def wait_for_agent_control(self) -> None:
        await self.agent_control.wait()


class SharedBrowserRuntime(FakeBrowserRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.control_owner = "agent"
        self.agent_control = asyncio.Event()
        self.agent_control.set()
        self.operation_lock = asyncio.Lock()

    async def wait_for_agent_control(self) -> None:
        await self.agent_control.wait()

    async def take_over(self) -> None:
        self.control_owner = "user"
        self.agent_control.clear()
        async with self.operation_lock:
            pass

    async def resume_agent(self) -> None:
        async with self.operation_lock:
            self.control_owner = "agent"
            self.agent_control.set()


def _ctx() -> ToolContext:
    return ToolContext(
        session_id="session-1",
        message_id="message-1",
        agent=AgentInfo(name="build", description="", mode="primary"),
        call_id="call-1",
        abort_event=asyncio.Event(),
    )


async def test_open_creates_managed_tab_and_returns_dom_refs():
    runtime = FakeBrowserRuntime()
    result = await BrowserTool(runtime)(
        {"action": "open", "url": "https://example.test/start"}, _ctx()
    )
    payload = json.loads(result.output)
    assert runtime.calls[0] == ("open", "https://example.test/start")
    assert payload["tab_id"] == "tab-1"
    assert payload["elements"][0]["ref"] == "e1"
    assert result.metadata["surface"] == "browser"
    assert result.attachments[0]["mime_type"] == "image/png"


async def test_ref_click_never_calls_desktop_computer_runtime():
    runtime = FakeBrowserRuntime()
    result = await BrowserTool(runtime)(
        {
            "action": "click",
            "tab_id": "tab-1",
            "url": "https://example.test/anything",
            "ref": "e1",
        },
        _ctx(),
    )
    assert result.success
    assert runtime.calls[0] == (
        "inspect", "tab-1", "e1"
    )
    assert runtime.calls[1] == (
        "click", "tab-1", "e1", {"button": "left", "click_count": 1}
    )


async def test_tab_action_rejects_wrong_permission_origin():
    runtime = FakeBrowserRuntime()
    result = await BrowserTool(runtime)(
        {
            "action": "click",
            "tab_id": "tab-1",
            "url": "https://evil.test/",
            "ref": "e1",
        },
        _ctx(),
    )
    assert not result.success
    assert "permission origin" in (result.error or "")
    assert runtime.calls == []


async def test_browser_rejects_file_and_credential_urls():
    tool = BrowserTool(FakeBrowserRuntime())
    file_result = await tool({"action": "open", "url": "file:///etc/passwd"}, _ctx())
    secret_result = await tool(
        {"action": "open", "url": "https://user:pass@example.test/"}, _ctx()
    )
    assert not file_result.success
    assert not secret_result.success


def test_browser_normalizes_common_model_key_spellings():
    assert _normalize_key("END") == "End"
    assert _normalize_key("CTRL+ARROWDOWN") == "Control+ArrowDown"


async def test_agent_actions_pause_while_user_has_taken_over(tmp_path):
    runtime = PlaywrightBrowserRuntime(profile_dir=tmp_path / "browser-profile")

    await runtime.take_over()
    waiting = asyncio.create_task(runtime.wait_for_agent_control())
    await asyncio.sleep(0)
    assert not waiting.done()

    await runtime.resume_agent()
    await asyncio.wait_for(waiting, timeout=0.1)
    assert runtime.control_owner == "agent"


async def test_browser_tool_waits_until_user_returns_control():
    runtime = GatedBrowserRuntime()
    pending = asyncio.create_task(
        BrowserTool(runtime)({"action": "list_tabs"}, _ctx())
    )
    await asyncio.sleep(0)
    assert not pending.done()

    runtime.agent_control.set()
    result = await asyncio.wait_for(pending, timeout=0.1)
    assert result.success


async def test_browser_takeover_wins_when_agent_is_waiting_for_runtime_lock():
    runtime = SharedBrowserRuntime()
    await runtime.operation_lock.acquire()
    pending = asyncio.create_task(
        BrowserTool(runtime)({"action": "list_tabs"}, _ctx())
    )
    await asyncio.sleep(0)

    takeover = asyncio.create_task(runtime.take_over())
    await asyncio.sleep(0)
    runtime.operation_lock.release()
    await asyncio.wait_for(takeover, timeout=0.1)
    await asyncio.sleep(0)

    assert not pending.done()
    assert runtime.calls == []
    await runtime.resume_agent()
    result = await asyncio.wait_for(pending, timeout=0.1)
    assert result.success


async def test_cross_origin_navigation_checks_destination_not_current_origin():
    runtime = FakeBrowserRuntime()
    result = await BrowserTool(runtime)({
        "action": "navigate",
        "tab_id": "tab-1",
        "url": "https://destination.test/page",
    }, _ctx())
    assert result.success
    assert ("navigate", "tab-1", "https://destination.test/page") in runtime.calls


async def test_browser_cua_clipboard_logs_and_dialog_surfaces():
    runtime = FakeBrowserRuntime()
    tool = BrowserTool(runtime)
    coordinate = await tool({
        "action": "coordinate_click", "tab_id": "tab-1",
        "url": runtime.url, "x": 10, "y": 20,
    }, _ctx())
    assert coordinate.success
    assert ("coord", "tab-1", 10.0, 20.0, {"button": "left", "click_count": 1}) in runtime.calls

    clipboard = await tool({
        "action": "clipboard_write", "tab_id": "tab-1",
        "url": runtime.url, "text": "hello",
    }, _ctx())
    assert json.loads(clipboard.output)["text"] == "hello"

    logs = await tool({
        "action": "network_log", "tab_id": "tab-1", "url": runtime.url,
    }, _ctx())
    assert json.loads(logs.output)["entries"][0]["kind"] == "network"

    dialog = await tool({
        "action": "dialog", "tab_id": "tab-1", "url": runtime.url,
        "dialog_response": "dismiss",
    }, _ctx())
    assert json.loads(dialog.output)["dialog"]["response"] == "dismiss"


async def test_obvious_password_target_requires_handoff_even_if_model_omits_it():
    runtime = FakeBrowserRuntime()

    async def inspect_password(_tab_id, _ref):
        return {"role": "input", "name": "Password", "input_type": "password"}

    runtime.inspect_ref = inspect_password
    result = await BrowserTool(runtime)({
        "action": "fill", "tab_id": "tab-1", "url": runtime.url,
        "ref": "e1", "value": "secret",
    }, _ctx())
    assert not result.success
    assert "credential" in (result.error or "")
    assert not any(call[0] == "fill" for call in runtime.calls)
