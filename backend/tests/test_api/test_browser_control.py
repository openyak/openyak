from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest


@dataclass
class _Tab:
    id: str
    url: str
    title: str


class _BrowserRuntime:
    control_owner = "agent"

    def __init__(self):
        self.calls = []

    async def list_tabs(self):
        return [_Tab("tab-1", "https://example.com/", "Example")]

    async def take_over(self):
        self.control_owner = "user"

    async def resume_agent(self):
        self.control_owner = "agent"

    async def observe(self, tab_id):
        return {
            "tab_id": tab_id,
            "url": "https://example.com/",
            "title": "Example",
            "viewport": {"width": 1280, "height": 720},
            "screenshot": b"png",
        }

    async def coordinate_click(self, tab_id, x, y, **kwargs):
        self.calls.append(("click", tab_id, x, y, kwargs))

    async def new_tab(self):
        self.calls.append(("new_tab",))
        return "tab-2"

    async def navigate(self, tab_id, url):
        self.calls.append(("navigate", tab_id, url))

    async def history(self, tab_id, direction):
        self.calls.append(("history", tab_id, direction))

    async def close_tab(self, tab_id):
        self.calls.append(("close", tab_id))

    async def manual_type(self, tab_id, text):
        self.calls.append(("type", tab_id, text))

    async def press(self, tab_id, key, ref=None):
        self.calls.append(("key", tab_id, key, ref))

    async def scroll(self, tab_id, delta_y, ref=None):
        self.calls.append(("scroll", tab_id, delta_y, ref))


class _StaleBrowserRuntime(_BrowserRuntime):
    control_owner = "user"

    async def navigate(self, tab_id, url):
        raise ValueError(f"Unknown or closed browser tab: {tab_id}")


@pytest.mark.asyncio
async def test_browser_workspace_reports_live_tabs_and_control_owner(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)

    response = await app_client.get("/api/browser-control/status")

    assert response.status_code == 200
    assert response.json() == {
        "control_owner": "agent",
        "tabs": [
            {"id": "tab-1", "url": "https://example.com/", "title": "Example"},
        ],
    }


@pytest.mark.asyncio
async def test_user_can_take_over_and_return_the_browser_to_the_agent(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)

    takeover = await app_client.post(
        "/api/browser-control/control", json={"owner": "user"}
    )
    assert takeover.status_code == 200
    assert takeover.json()["control_owner"] == "user"

    resume = await app_client.post(
        "/api/browser-control/control", json={"owner": "agent"}
    )
    assert resume.status_code == 200
    assert resume.json()["control_owner"] == "agent"


@pytest.mark.asyncio
async def test_browser_workspace_returns_a_live_visual_observation(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)

    response = await app_client.get(
        "/api/browser-control/snapshot", params={"tab_id": "tab-1"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "tab_id": "tab-1",
        "url": "https://example.com/",
        "title": "Example",
        "viewport": {"width": 1280, "height": 720},
        "image_data_url": "data:image/png;base64,cG5n",
    }


@pytest.mark.asyncio
async def test_manual_page_input_requires_user_control(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)

    blocked = await app_client.post(
        "/api/browser-control/interact",
        json={"action": "click", "tab_id": "tab-1", "x": 64, "y": 48},
    )
    assert blocked.status_code == 409

    await app_client.post("/api/browser-control/control", json={"owner": "user"})
    clicked = await app_client.post(
        "/api/browser-control/interact",
        json={"action": "click", "tab_id": "tab-1", "x": 64, "y": 48},
    )
    assert clicked.status_code == 200
    assert runtime.calls == [
        ("click", "tab-1", 64.0, 48.0, {"button": "left", "click_count": 1}),
    ]


@pytest.mark.asyncio
async def test_user_toolbar_controls_the_live_browser_tab(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)
    await app_client.post("/api/browser-control/control", json={"owner": "user"})

    created = await app_client.post(
        "/api/browser-control/interact", json={"action": "new_tab"}
    )
    assert created.json()["tab_id"] == "tab-2"
    await app_client.post(
        "/api/browser-control/interact",
        json={
            "action": "navigate",
            "tab_id": "tab-2",
            "url": "https://openai.com/",
        },
    )
    await app_client.post(
        "/api/browser-control/interact",
        json={"action": "back", "tab_id": "tab-2"},
    )
    await app_client.post(
        "/api/browser-control/interact",
        json={"action": "close_tab", "tab_id": "tab-2"},
    )

    assert runtime.calls == [
        ("new_tab",),
        ("navigate", "tab-2", "https://openai.com/"),
        ("history", "tab-2", "back"),
        ("close", "tab-2"),
    ]


@pytest.mark.asyncio
async def test_user_can_type_press_keys_and_scroll_the_live_page(app_client) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)
    await app_client.post("/api/browser-control/control", json={"owner": "user"})

    for payload in (
        {"action": "type", "tab_id": "tab-1", "text": "hello"},
        {"action": "key", "tab_id": "tab-1", "key": "Enter"},
        {"action": "scroll", "tab_id": "tab-1", "delta_y": 420},
    ):
        response = await app_client.post("/api/browser-control/interact", json=payload)
        assert response.status_code == 200

    assert runtime.calls == [
        ("type", "tab-1", "hello"),
        ("key", "tab-1", "Enter", None),
        ("scroll", "tab-1", 420, None),
    ]


@pytest.mark.asyncio
async def test_stale_browser_tabs_return_a_recoverable_client_error(app_client) -> None:
    runtime = _StaleBrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)

    response = await app_client.post(
        "/api/browser-control/interact",
        json={
            "action": "navigate",
            "tab_id": "tab-stale",
            "url": "https://example.com/",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown or closed browser tab: tab-stale"


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["file:///etc/passwd", "https://user:pass@example.com/"])
async def test_browser_address_bar_rejects_unsafe_urls(app_client, url: str) -> None:
    runtime = _BrowserRuntime()
    app_client.app.state.tool_registry.get.return_value = SimpleNamespace(runtime=runtime)
    await app_client.post("/api/browser-control/control", json={"owner": "user"})

    response = await app_client.post(
        "/api/browser-control/interact",
        json={"action": "navigate", "tab_id": "tab-1", "url": url},
    )

    assert response.status_code == 422
    assert runtime.calls == []
