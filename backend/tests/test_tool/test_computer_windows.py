"""Windows Computer Use unit tests.

These cover the parts of the Windows runtime that are pure logic and therefore
meaningful on any platform. The behaviour that only a real desktop can prove --
COM marshalling, foreground acquisition, window capture, live UIA trees -- is in
tests/test_tool/test_computer_windows_integration.py, because stubbing it here
is exactly how the original suite stayed green while the runtime was unusable.
"""

from __future__ import annotations

import sys

import pytest

from app.computer_runtime.base import AppDescriptor
from app.tool.builtin.computer import (
    _app_is_allowed,
    _assert_descriptor_allowed,
    _clickable_element_at,
)
from app.computer_runtime.base import AppState, ElementSnapshot


def _descriptor(name: str, executable: str = "", identifier: str = "1234") -> AppDescriptor:
    return AppDescriptor(name=name, identifier=identifier, pid=7, executable=executable)


class TestSensitiveApplicationPolicy:
    """A Windows app name is the window title, which the open document controls."""

    @pytest.mark.parametrize(
        "title, executable",
        [
            (r"C:\WINDOWS\SYSTEM32\cmd.exe", "cmd.exe"),
            ("Windows PowerShell", "powershell.exe"),
            ("OPENYAK_CONSOLE_PROBE", "WindowsTerminal.exe"),
            ("dev", "pwsh.exe"),
            ("My Vault", "1Password.exe"),
        ],
    )
    def test_consoles_and_secret_stores_are_blocked_by_executable(self, title, executable):
        assert not _app_is_allowed(title, executable)

    @pytest.mark.parametrize(
        "title, executable",
        [
            ("Q3 terminal refresh plan.docx - Word", "WINWORD.EXE"),
            ("coinbase-invoice.pdf - Acrobat", "Acrobat.exe"),
            ("passwords.md - Notepad", "Notepad.exe"),
            ("openyak-notes.txt - Notepad", "Notepad.exe"),
        ],
    )
    def test_ordinary_documents_are_not_blocked_by_their_filename(self, title, executable):
        assert _app_is_allowed(title, executable)

    def test_bundle_identifier_still_gates_macos_apps(self):
        assert not _app_is_allowed("Terminal", "com.apple.Terminal")
        assert _app_is_allowed("Safari", "com.apple.Safari")

    def test_display_name_is_used_when_no_program_identity_is_available(self):
        assert not _app_is_allowed("Terminal")
        assert _app_is_allowed("Notes")

    def test_opaque_identifier_cannot_bypass_the_blocklist(self):
        """On Windows the identifier is a numeric HWND and matches nothing."""
        console = _descriptor(r"C:\WINDOWS\SYSTEM32\cmd.exe", "cmd.exe", identifier="1050644")
        with pytest.raises(PermissionError, match="blocked for sensitive application"):
            _assert_descriptor_allowed(console)

    def test_resolved_safe_application_is_allowed(self):
        _assert_descriptor_allowed(_descriptor("Notes - Notepad", "Notepad.exe"))


class TestScreenshotHitTesting:
    def test_windows_uia_roles_resolve_to_a_semantic_target(self):
        """Roles arrive as e.g. "ButtonControl"; actions come from UIA patterns."""
        state = AppState(
            app=_descriptor("Editor", "Notepad.exe"),
            elements=[
                ElementSnapshot(0, "WindowControl", "Editor", bounds=(0, 0, 800, 600)),
                ElementSnapshot(
                    1, "ButtonControl", "Save", bounds=(10, 10, 80, 30),
                    parent=0, depth=1, actions=("invoke", "showmenu"),
                ),
                ElementSnapshot(
                    2, "TabItemControl", "Page 2", bounds=(100, 10, 80, 30),
                    parent=0, depth=1, actions=("select", "showmenu"),
                ),
            ],
        )
        assert _clickable_element_at(state, 40, 20).index == 1
        assert _clickable_element_at(state, 140, 20).index == 2
        # A point over nothing actionable falls through to coordinates.
        assert _clickable_element_at(state, 400, 400) is None

    def test_showmenu_alone_is_not_treated_as_a_click_target(self):
        """Every element exposes showmenu, so it must not make everything clickable."""
        state = AppState(
            app=_descriptor("Editor", "Notepad.exe"),
            elements=[
                ElementSnapshot(
                    0, "PaneControl", "Body", bounds=(0, 0, 800, 600),
                    actions=("showmenu",),
                ),
            ],
        )
        assert _clickable_element_at(state, 100, 100) is None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows runtime module")
class TestWindowsRuntimeLogic:
    def test_modifier_map_sends_ctrl_for_the_macos_accelerator(self):
        from app.computer_runtime.windows import _MODIFIERS

        # A model trained on macOS emits cmd+s; on Windows the equivalent
        # accelerator is Ctrl, not the Windows key.
        assert _MODIFIERS["cmd"] == "{Ctrl}"
        assert _MODIFIERS["command"] == "{Ctrl}"
        # The workspace UI sends "meta" for event.metaKey, which is the
        # physical Windows key.
        assert _MODIFIERS["meta"] == "{Win}"
        assert _MODIFIERS["super"] == "{Win}"
        assert _MODIFIERS["control"] == "{Ctrl}"

    def test_scroll_directions_map_to_uia_scroll_amounts(self):
        from app.computer_runtime.windows import _SCROLL_DIRECTIONS

        # (horizontal, forward). ScrollPattern.Scroll takes ScrollAmount enum
        # members; signed deltas silently scroll the wrong way or not at all.
        assert _SCROLL_DIRECTIONS["down"] == (False, True)
        assert _SCROLL_DIRECTIONS["up"] == (False, False)
        assert _SCROLL_DIRECTIONS["right"] == (True, True)
        assert _SCROLL_DIRECTIONS["left"] == (True, False)

    def test_send_keys_literal_braces_are_escaped(self):
        from app.computer_runtime.windows import _escape_send_keys

        # SendKeys reads {...} as a key name, so typing JSON would be lost.
        assert _escape_send_keys('{"a": 1}') == '{{}"a": 1{}}'
        assert _escape_send_keys("plain") == "plain"

    def test_modified_document_marker_does_not_break_target_resolution(self):
        from app.computer_runtime.windows import _bare_title

        # Editing a document renames the window mid-task.
        assert _bare_title("*cu-probe.txt - notepad") == "cu-probe.txt - notepad"
        assert _bare_title("cu-probe.txt - notepad") == "cu-probe.txt - notepad"

    def test_element_identity_prefers_the_uia_runtime_id(self):
        from app.computer_runtime.windows import _element_identity

        class WithRuntimeId:
            def GetRuntimeId(self):
                return (42, 264324)

        class WithoutRuntimeId:
            def GetRuntimeId(self):
                raise OSError("not available")

        assert _element_identity(WithRuntimeId(), "root/Pane[0]") == "rt:42.264324"
        assert _element_identity(WithoutRuntimeId(), "root/Pane[0]") == "path:root/Pane[0]"

    def test_stable_indices_survive_a_reordered_tree(self):
        """Positional indices made the agent click a different control."""
        from app.computer_runtime.state import StateStore

        store = StateStore()
        first = store.index_for("s", "app", "rt:42.100")
        second = store.index_for("s", "app", "rt:42.200")
        # A new element appears ahead of both in walk order.
        inserted = store.index_for("s", "app", "rt:42.050")

        assert first != second != inserted
        assert store.index_for("s", "app", "rt:42.100") == first
        assert store.index_for("s", "app", "rt:42.200") == second

    def test_uia_calls_are_marshalled_onto_one_thread(self):
        """uiautomation forbids using a Control from another thread."""
        import threading

        from app.computer_runtime.windows import _UiaThread

        thread = _UiaThread()
        try:
            owner = thread.run(threading.get_ident)
            again = thread.run(threading.get_ident)
            assert owner == again
            assert owner != threading.get_ident()

            # A nested call must run inline rather than deadlock the single worker.
            def outer() -> int:
                return thread.run(threading.get_ident)

            assert thread.run(outer) == owner
        finally:
            thread.shutdown()
