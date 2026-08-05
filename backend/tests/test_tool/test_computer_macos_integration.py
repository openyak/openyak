from __future__ import annotations

import os
import platform

import pytest

from app.computer_runtime.macos import MacOSComputerRuntime, _ax_range, _ax_value


pytestmark = pytest.mark.skipif(
    platform.system() != "Darwin"
    or os.getenv("OPENYAK_RUN_COMPUTER_USE_INTEGRATION") != "1",
    reason="requires opt-in macOS Accessibility and Screen Recording access",
)


def test_real_macos_ax_state_indices_selection_scroll_and_capture() -> None:
    runtime = MacOSComputerRuntime()
    first = runtime.get_app_state(
        "TextEdit", session_id="macos-integration", disable_diff=True
    )
    second = runtime.get_app_state(
        "TextEdit", session_id="macos-integration", disable_diff=True
    )

    assert first.elements
    assert {item.index for item in first.elements} == {
        item.index for item in second.elements
    }
    assert second.screenshot_data_url is not None
    assert second.screenshot_width and second.screenshot_height
    assert any(item.actions for item in second.elements)

    editable = next(item for item in second.elements if item.role == "AXTextArea")
    _, handle = runtime._target("TextEdit", "macos-integration", editable.index)
    original_range = _ax_value(
        runtime._ax, handle, runtime._ax.kAXSelectedTextRangeAttribute, None
    )
    value = str(_ax_value(runtime._ax, handle, runtime._ax.kAXValueAttribute, ""))
    candidate = next(
        (value[:width] for width in range(1, min(len(value), 80) + 1)
         if value.count(value[:width]) == 1),
        None,
    )
    if candidate:
        runtime.select_text(
            "TextEdit",
            session_id="macos-integration",
            element_index=editable.index,
            text=candidate,
        )
        assert _ax_range(
            runtime._ax,
            _ax_value(
                runtime._ax,
                handle,
                runtime._ax.kAXSelectedTextRangeAttribute,
                None,
            ),
        ) == (0, len(candidate))
        runtime._ax.AXUIElementSetAttributeValue(
            handle, runtime._ax.kAXSelectedTextRangeAttribute, original_range
        )
        assert _ax_range(
            runtime._ax,
            _ax_value(
                runtime._ax,
                handle,
                runtime._ax.kAXSelectedTextRangeAttribute,
                None,
            ),
        ) == _ax_range(runtime._ax, original_range)

    scroll_area = next(
        item for item in second.elements if "Scroll Down By Page" in item.actions
    )
    _, scroll_handle = runtime._target(
        "TextEdit", "macos-integration", scroll_area.index
    )
    scrollbar = _ax_value(runtime._ax, scroll_handle, "AXVerticalScrollBar", None)
    original_scroll = _ax_value(
        runtime._ax, scrollbar, runtime._ax.kAXValueAttribute, 0.0
    )
    runtime.scroll(
        "TextEdit",
        session_id="macos-integration",
        element_index=scroll_area.index,
        direction="down",
        pages=1,
    )
    assert _ax_value(
        runtime._ax, scrollbar, runtime._ax.kAXValueAttribute, 0.0
    ) != original_scroll
    runtime._ax.AXUIElementSetAttributeValue(
        scrollbar, runtime._ax.kAXValueAttribute, original_scroll
    )
    runtime.wait_for_stability(
        "TextEdit", session_id="macos-integration", timeout=2.0
    )
