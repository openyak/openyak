from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.browser_runtime import PlaywrightBrowserRuntime


pytestmark = pytest.mark.skipif(
    os.getenv("OPENYAK_RUN_BROWSER_INTEGRATION") != "1",
    reason="requires opt-in visible Chrome integration testing",
)


@contextmanager
def fixture_server():
    directory = Path(__file__).parents[1] / "fixtures"
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/browser_lab.html"
    finally:
        server.shutdown()
        thread.join(timeout=5)


async def test_real_browser_dom_cua_frames_shadow_logs_dialog_and_capture(
    tmp_path: Path,
) -> None:
    runtime = PlaywrightBrowserRuntime(tmp_path / "profile")
    try:
        with fixture_server() as url:
            tab_id = await runtime.open(url)
            state = await runtime.snapshot(tab_id, include_screenshot=True)
            by_name = {item.get("name"): item for item in state["elements"]}
            expected = {
                "Codename", "Color", "Verify", "Enable advanced", "Write log",
                "Open dialog", "Shadow action", "Frame action",
            }
            assert expected <= set(by_name)
            assert len(state["frames"]) == 2
            assert state["screenshot"]

            await runtime.fill(tab_id, by_name["Codename"]["ref"], "yak")
            await runtime.select_option(tab_id, by_name["Color"]["ref"], "blue")
            await runtime.set_checked(
                tab_id, by_name["Enable advanced"]["ref"], True
            )
            await runtime.click(tab_id, by_name["Verify"]["ref"])
            await runtime.click(tab_id, by_name["Shadow action"]["ref"])
            await runtime.click(tab_id, by_name["Frame action"]["ref"])
            await runtime.click(tab_id, by_name["Write log"]["ref"])

            await runtime.clipboard(tab_id, text="clipboard-ok")
            assert await runtime.clipboard(tab_id) == "clipboard-ok"

            await runtime.click(tab_id, by_name["Open dialog"]["ref"])
            dialog = await runtime.dialog(tab_id, response="dismiss")
            assert dialog["type"] == "confirm"

            final = await runtime.snapshot(tab_id, include_screenshot=True)
            assert "verified:yak:blue" in final["text"]
            assert not any(
                item.get("name") == "Frame action" for item in final["elements"]
            )
            assert any(
                item["text"] == "openyak-browser-log"
                for item in await runtime.logs(tab_id, kind="console")
            )
            assert await runtime.logs(tab_id, kind="network")

            bounds = by_name["Verify"]["bounds"]
            x = bounds[0] + bounds[2] / 2
            y = bounds[1] + bounds[3] / 2
            await runtime.hover(tab_id, x, y)
            await runtime.coordinate_click(tab_id, x, y)
    finally:
        await runtime.close()
