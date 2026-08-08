"""Windows Computer Use visible integration matrix.

The counterpart to test_computer_macos_integration.py. docs/computer-use.md
gates Windows parity on this matrix passing on physical Windows hardware, so
nothing here is faked: it drives a real Notepad window through the real UI
Automation runtime and asserts on observable results.

Opt in with:

    cd backend
    OPENYAK_RUN_COMPUTER_USE_INTEGRATION=1 venv/Scripts/python -m pytest -q \
      tests/test_tool/test_computer_windows_integration.py

It takes over the foreground while it runs.
"""

from __future__ import annotations

import asyncio
import base64
import ctypes
import io
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from ctypes import wintypes

import pytest

pytestmark = [
    pytest.mark.skipif(sys.platform != "win32", reason="Windows-only matrix"),
    pytest.mark.skipif(
        os.environ.get("OPENYAK_RUN_COMPUTER_USE_INTEGRATION") != "1",
        reason="set OPENYAK_RUN_COMPUTER_USE_INTEGRATION=1 to drive the real desktop",
    ),
]

BODY = "alpha\nbravo\ncharlie\n" + "\n".join(f"line {index}" for index in range(200))
SESSION = "windows-integration"


@pytest.fixture(scope="module")
def runtime():
    from app.computer_runtime import create_computer_runtime

    return create_computer_runtime()


@pytest.fixture(scope="module")
def notepad(tmp_path_factory, runtime):
    """A real Notepad window over a known document."""
    path = tmp_path_factory.mktemp("computer-use") / "openyak-matrix.txt"
    path.write_text(BODY, encoding="utf-8")
    # Windows 11 Notepad reuses a single window and opens documents as tabs, so
    # a leftover instance would leave the probe document on an inactive tab.
    subprocess.run(["taskkill", "/F", "/IM", "notepad.exe"],
                   capture_output=True, check=False)
    time.sleep(1.0)
    process = subprocess.Popen(["notepad.exe", str(path)])
    descriptor = None
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        descriptor = next(
            (item for item in runtime.list_apps()
             if "openyak-matrix" in item.name.casefold()),
            None,
        )
        if descriptor is not None:
            break
        time.sleep(0.5)
    if descriptor is None:
        process.kill()
        pytest.skip("Notepad did not open a window for the probe document")
    yield descriptor
    process.kill()


def _state(runtime, descriptor, session=SESSION, **kwargs):
    return runtime.get_app_state(descriptor.identifier, session_id=session, **kwargs)


def _document(state):
    element = next(
        (item for item in state.elements
         if "Document" in item.role or "Edit" in item.role),
        None,
    )
    assert element is not None, f"no editable element among {len(state.elements)}"
    return element


# --------------------------------------------------------------------------
# COM and threading
# --------------------------------------------------------------------------


async def test_every_action_survives_the_asyncio_thread_pool(runtime, notepad):
    """ComputerTool dispatches through asyncio.to_thread.

    UI Automation is COM and uiautomation forbids using a Control from a thread
    other than its creator, so a runtime that touches UIA on the calling thread
    fails with "CoInitialize has not been called" for every single action.
    """
    states = await asyncio.gather(*(
        asyncio.to_thread(_state, runtime, notepad, disable_diff=True)
        for _ in range(4)
    ))
    for state in states:
        assert state.elements, "empty UI Automation tree"

    # Handles cached by one call must still be usable from a different worker.
    element = _document(states[0])
    await asyncio.to_thread(
        runtime.set_value, notepad.identifier,
        session_id=SESSION, element_index=element.index, value=BODY,
    )


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------


def test_state_exposes_elements_actions_and_a_window_capture(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)

    assert len(state.elements) > 5
    assert state.screenshot_data_url, state.screenshot_unavailable_reason
    assert state.screenshot_width and state.screenshot_height
    assert state.screenshot_bounds is not None

    # The tool contract tells the model to pass exposed actions verbatim to
    # perform_secondary_action, so they have to be populated.
    assert all(item.actions for item in state.elements)
    assert any("invoke" in item.actions for item in state.elements)
    assert any(item.subrole for item in state.elements)


def test_element_indices_stay_bound_to_the_same_element(runtime, notepad):
    """Positional indices made the agent act on a different control."""
    first = _state(runtime, notepad, session="stability", disable_diff=True)
    before = {item.index: (item.role, item.name) for item in first.elements}

    # Perturb the tree: resizing reflows the toolbar and reparents children.
    handle = int(notepad.identifier)
    rect = wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(handle, ctypes.byref(rect))
    ctypes.windll.user32.SetWindowPos(handle, 0, rect.left, rect.top, 900, 640, 0x0004)
    time.sleep(1.2)

    second = _state(runtime, notepad, session="stability", disable_diff=True)
    after = {item.index: (item.role, item.name) for item in second.elements}

    drifted = [
        index for index in set(before) & set(after)
        if before[index] != after[index]
    ]
    assert not drifted, f"{len(drifted)} indices now point at a different element"


def test_cached_and_live_tree_reads_agree(runtime, notepad):
    """The bulk cache fetch must be a faithful drop-in for the live walk.

    get_app_state prefers one BuildUpdatedCache over per-property cross-process
    reads and falls back to the live walk when a provider refuses. Both paths
    have to describe the same tree, or a fallback would silently change what the
    model sees.
    """
    import uiautomation as auto

    root = auto.ControlFromHandle(int(notepad.identifier))
    cached, cached_handles = runtime._read_tree_cached(root, "agree-cached", notepad)
    live, live_handles = runtime._read_tree_live(root, "agree-live", notepad)

    def shape(elements):
        return [
            (item.role, item.name, item.subrole, item.depth, item.bounds)
            for item in elements
        ]

    assert len(cached) == len(live)
    assert shape(cached) == shape(live)
    assert set(cached_handles) and set(live_handles)


def test_cached_read_falls_back_to_the_live_walk(runtime, notepad, monkeypatch):
    """A provider that refuses a cached request must not break the snapshot."""
    def refuse(*_args, **_kwargs):
        raise OSError("provider refused the cache request")

    monkeypatch.setattr(
        type(runtime), "_read_tree_cached", refuse, raising=True
    )
    state = _state(runtime, notepad, session="fallback", disable_diff=True)
    assert len(state.elements) > 5
    assert all(item.actions for item in state.elements)


def test_second_read_returns_a_diff(runtime, notepad):
    _state(runtime, notepad, session="diffing", disable_diff=True)
    diff = _state(runtime, notepad, session="diffing")
    assert diff.is_diff is True
    assert diff.revision >= 2


# --------------------------------------------------------------------------
# Window capture
# --------------------------------------------------------------------------


@contextmanager
def _cover_window(rect):
    """Park a File Explorer window on top of `rect` for the duration.

    Explorer is used rather than an arbitrary open window because it is a plain
    Win32 window that honours SetWindowPos; the check below confirms it really
    landed on top before the caller asserts anything.
    """
    user32 = ctypes.windll.user32
    before = {_hwnd for _hwnd in _visible_hwnds()}
    process = subprocess.Popen(["explorer.exe", os.environ.get("WINDIR", r"C:\Windows")])
    handle = None
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        fresh = [item for item in _visible_hwnds() if item not in before]
        for candidate in fresh:
            name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(candidate, name, 256)
            if name.value == "CabinetWClass":
                handle = candidate
                break
        if handle:
            break
        time.sleep(0.5)

    covered = False
    try:
        if handle:
            from PIL import ImageGrab

            box = (rect.left, rect.top, rect.right, rect.bottom)
            before_pixels = ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")
            user32.SetWindowPos(
                handle, -1, rect.left + 40, rect.top + 40, 520, 400, 0x0040
            )
            time.sleep(1.2)
            after_pixels = ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")
            # The precondition that matters is simply that the region on screen
            # no longer shows the target, however the window manager got there.
            changed = sum(
                1 for left, right in zip(before_pixels.getdata(), after_pixels.getdata())
                if left != right
            )
            covered = changed / (before_pixels.width * before_pixels.height) > 0.05
        yield covered
    finally:
        if handle:
            user32.PostMessageW(handle, 0x0010, 0, 0)  # WM_CLOSE
        try:
            process.kill()
        except Exception:
            pass
        time.sleep(0.6)


def _visible_hwnds() -> list[int]:
    user32 = ctypes.windll.user32
    found: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def collect(handle: int, _param: int) -> bool:
        if user32.IsWindowVisible(handle) and user32.GetWindowTextLengthW(handle):
            found.append(int(handle))
        return True

    user32.EnumWindows(collect, 0)
    return found


def test_capture_returns_the_window_not_whatever_covers_it(runtime, notepad):
    """A screen-region grab hands the model an unrelated app's pixels."""
    from PIL import Image, ImageGrab

    handle = int(notepad.identifier)
    rect = wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(handle, ctypes.byref(rect))

    with _cover_window(rect) as covered:
        if not covered:
            pytest.skip("could not place a window over the target")

        state = _state(runtime, notepad, session="occlusion", disable_diff=True)
        assert state.screenshot_data_url, state.screenshot_unavailable_reason
        captured = Image.open(
            io.BytesIO(base64.b64decode(state.screenshot_data_url.split(",", 1)[1]))
        ).convert("RGB")
        on_screen = ImageGrab.grab(
            bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True
        ).resize(captured.size).convert("RGB")

    differing = sum(
        1 for left, right in zip(captured.getdata(), on_screen.getdata())
        if left != right
    )
    share = differing / (captured.width * captured.height)
    assert share > 0.10, (
        "capture matches the screen region, so the occluding window was "
        "baked into the frame the model sees"
    )


# --------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------


def test_synthetic_input_acquires_the_foreground(runtime, notepad):
    """Windows refuses SetForegroundWindow to a background backend process."""
    runtime.press_key(notepad.identifier, session_id=SESSION, key="end",
                      modifiers=["control"])
    assert ctypes.windll.user32.GetForegroundWindow() == int(notepad.identifier)


def test_coordinate_click_and_drag_reach_the_target(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    left, top, width, height = state.screenshot_bounds
    runtime.click(notepad.identifier, session_id=SESSION,
                  x=left + width / 2, y=top + height / 2)
    runtime.drag(notepad.identifier, session_id=SESSION,
                 from_x=left + 60, from_y=top + height / 2,
                 to_x=left + 160, to_y=top + height / 2)


def test_coordinates_outside_the_window_are_rejected(runtime, notepad):
    _state(runtime, notepad, disable_diff=True)
    with pytest.raises(ValueError, match="outside"):
        runtime.click(notepad.identifier, session_id=SESSION, x=-5000, y=-5000)


def test_value_and_text_editing(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)

    # Short body on purpose: snapshot values are clipped to 500 characters, so
    # an append past that bound would not be observable in the tree.
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value="alpha\nbravo\n")
    runtime.type_text(notepad.identifier, session_id=SESSION,
                      element_index=element.index, text="appended")

    refreshed = _document(_state(runtime, notepad, disable_diff=True))
    assert "appended" in refreshed.value
    assert "alpha" in refreshed.value, "type_text replaced the value instead of appending"

    # macOS falls back to the focused element; Windows must not hard-error.
    runtime.type_text(notepad.identifier, session_id=SESSION, text="!")

    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value=BODY)


def test_text_selection_and_reported_range(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value=BODY)

    runtime.select_text(notepad.identifier, session_id=SESSION,
                        element_index=element.index, text="charlie")
    time.sleep(0.4)

    refreshed = _document(_state(runtime, notepad, session="selection",
                                 disable_diff=True))
    assert refreshed.selected_text_range is not None
    start, length = refreshed.selected_text_range
    assert length == len("charlie")
    assert BODY.replace("\r\n", "\n")[start:start + length] == "charlie"


def test_ambiguous_selection_is_rejected(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value=BODY)
    with pytest.raises(ValueError, match="ambiguous"):
        runtime.select_text(notepad.identifier, session_id=SESSION,
                            element_index=element.index, text="line 1")


def test_literal_braces_survive_keyboard_typing(runtime, notepad):
    """SendKeys reads {...} as a key name, so JSON would be silently eaten."""
    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value="")
    runtime.press_key(notepad.identifier, session_id=SESSION, key="end",
                      modifiers=["control"])
    runtime.type_text(notepad.identifier, session_id=SESSION,
                      element_index=element.index, text='{"ok": 1}')
    time.sleep(0.4)
    refreshed = _document(_state(runtime, notepad, disable_diff=True))
    assert '{"ok": 1}' in refreshed.value
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value=BODY)


# --------------------------------------------------------------------------
# Scrolling
# --------------------------------------------------------------------------


def test_page_scrolling_moves_the_viewport_both_ways(runtime, notepad):
    """UIA Scroll takes ScrollAmount members; signed deltas silently no-op."""
    import uiautomation as auto

    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)
    runtime.set_value(notepad.identifier, session_id=SESSION,
                      element_index=element.index, value=BODY)

    def percent() -> float:
        def walk(control):
            if "Document" in str(control.ControlTypeName):
                return control
            for child in control.GetChildren():
                found = walk(child)
                if found is not None:
                    return found
            return None

        node = walk(auto.ControlFromHandle(int(notepad.identifier)))
        pattern = node.GetPattern(auto.PatternId.ScrollPattern) if node else None
        return float(pattern.VerticalScrollPercent) if pattern else -1.0

    start = percent()
    runtime.scroll(notepad.identifier, session_id=SESSION,
                   element_index=element.index, direction="down", pages=1)
    time.sleep(0.5)
    scrolled = percent()
    assert scrolled > start, "page down did not move the viewport"

    runtime.scroll(notepad.identifier, session_id=SESSION,
                   element_index=element.index, direction="up", pages=1)
    time.sleep(0.5)
    assert percent() < scrolled, "page up did not move the viewport"


def test_unknown_scroll_direction_is_rejected(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    with pytest.raises(ValueError, match="up, down, left, right"):
        runtime.scroll(notepad.identifier, session_id=SESSION,
                       element_index=_document(state).index,
                       direction="sideways", pages=1)


# --------------------------------------------------------------------------
# Secondary actions and waiting
# --------------------------------------------------------------------------


def test_unsupported_secondary_action_reports_what_is_available(runtime, notepad):
    """The per-type helpers raise AttributeError for a merely absent pattern."""
    state = _state(runtime, notepad, disable_diff=True)
    element = _document(state)
    with pytest.raises(Exception) as caught:
        runtime.perform_secondary_action(
            notepad.identifier, session_id=SESSION,
            element_index=element.index, action="invoke",
        )
    assert not isinstance(caught.value, AttributeError)
    assert "exposes" in str(caught.value)


def test_unknown_secondary_action_is_rejected(runtime, notepad):
    state = _state(runtime, notepad, disable_diff=True)
    with pytest.raises(ValueError, match="Unsupported action"):
        runtime.perform_secondary_action(
            notepad.identifier, session_id=SESSION,
            element_index=_document(state).index, action="teleport",
        )


def test_wait_for_stability_settles_early_on_a_quiet_window(runtime, notepad):
    """macOS polls until quiet; a flat sleep ignores the timeout entirely."""
    started = time.monotonic()
    runtime.wait_for_stability(notepad.identifier, session_id=SESSION, timeout=5.0)
    assert time.monotonic() - started < 2.0


# --------------------------------------------------------------------------
# Discovery and policy
# --------------------------------------------------------------------------


def test_discovery_hides_shell_windows_and_deduplicates_packaged_apps(runtime):
    apps = runtime.list_apps()
    names = [item.name for item in apps]

    assert "Program Manager" not in names
    assert "Windows Input Experience" not in names
    # A packaged app enumerates as an ApplicationFrameWindow plus its own
    # CoreWindow; both surfacing produced two identical picker entries.
    assert len(names) == len(set(zip(names, (item.identifier for item in apps))))
    assert all(item.executable for item in apps), "executable identity missing"


def test_target_resolution_survives_the_modified_document_marker(runtime, notepad):
    """Editing a document renames the window mid-task."""
    resolved = runtime.resolve_app(notepad.name)
    assert resolved.identifier == notepad.identifier
    assert runtime.resolve_app(notepad.identifier).identifier == notepad.identifier
    assert runtime.resolve_app("*" + notepad.name).identifier == notepad.identifier


def test_console_windows_are_blocked_by_executable(runtime):
    from app.tool.builtin.computer import _app_is_allowed

    console = subprocess.Popen(
        ["cmd.exe", "/k", "title OPENYAK_MATRIX_CONSOLE"],
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )
    try:
        time.sleep(2.5)
        consoles = [
            item for item in runtime.list_apps()
            if item.executable.casefold() in
            {"cmd.exe", "windowsterminal.exe", "conhost.exe", "openconsole.exe"}
        ]
        if not consoles:
            pytest.skip("no console window surfaced on this host")
        for item in consoles:
            assert not _app_is_allowed(item.name, item.executable), (
                f"{item.name!r} ({item.executable}) was reachable"
            )
    finally:
        console.kill()
