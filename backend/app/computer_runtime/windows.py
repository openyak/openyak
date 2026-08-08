"""Windows Computer Use runtime backed by Microsoft UI Automation."""

from __future__ import annotations

import base64
import ctypes
import functools
import io
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes
from dataclasses import replace
from typing import Any, Callable, TypeVar

from app.computer_runtime.base import AppDescriptor, AppState, ElementSnapshot
from app.computer_runtime.state import StateStore

_MAX_ELEMENTS = 900
_MAX_DEPTH = 24
_MAX_IMAGE = (1440, 900)

_SW_SHOW = 5
_SW_RESTORE = 9
_SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
_SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
_SPIF_SENDCHANGE = 0x0002
_ASFW_ANY = -1
_VK_MENU = 0x12
_KEYEVENTF_KEYUP = 0x0002
_PW_RENDERFULLCONTENT = 0x00000002
_DWMWA_CLOAKED = 14
_GW_OWNER = 4
_WS_EX_TOOLWINDOW = 0x00000080
_GWL_EXSTYLE = -20
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# Window classes owned by the shell itself. They are not applications a user
# would ever pick as an automation target.
_SHELL_WINDOW_CLASSES = frozenset({
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "ApplicationManager_DesktopShellWindow", "MultitaskingViewFrame",
    "ForegroundStaging", "XamlExplorerHostIslandWindow",
})
# A packaged (UWP) app enumerates twice: ApplicationFrameHost owns the visible
# ApplicationFrameWindow, and the app's own process owns the CoreWindow holding
# its content. Keeping only the frame is what stops Settings appearing as two
# identical, indistinguishable entries in the target picker.
_UWP_CONTENT_CLASS = "Windows.UI.Core.CoreWindow"

# Control types that never carry a Value; skipping the pattern probe for them
# removes one cross-process COM call per element from every tree walk.
_VALUELESS_ROLES = frozenset({
    "PaneControl", "GroupControl", "WindowControl", "ScrollBarControl",
    "ThumbControl", "TitleBarControl", "SeparatorControl", "ImageControl",
    "ToolBarControl", "MenuBarControl", "StatusBarControl", "TreeControl",
    "TabControl", "ListControl", "TableControl", "CustomControl",
})

_SECONDARY_ACTIONS = ("invoke", "expand", "collapse", "select", "toggle",
                      "scrollintoview", "showmenu")

# Layout and decoration roles. They dominate a real UIA tree and never carry
# Invoke/Toggle/Select/ExpandCollapse/ScrollItem, so probing them is pure cost.
_STRUCTURAL_ROLES = frozenset({
    "PaneControl", "GroupControl", "WindowControl", "TitleBarControl",
    "SeparatorControl", "ImageControl", "TextControl", "ToolBarControl",
    "MenuBarControl", "StatusBarControl", "ScrollBarControl", "ThumbControl",
    "CustomControl", "DocumentControl",
})

# uiautomation mirrors the UIA enums: TextPatternRangeEndpoint and TextUnit.
_ENDPOINT_START = 0
_ENDPOINT_END = 1
_TEXT_UNIT_CHARACTER = 0
_TREE_SCOPE_SUBTREE = 7


def _PROPERTIES() -> Any:
    import uiautomation as auto

    return auto.PropertyId


def _AUTOMATION_CLIENT() -> Any:
    """The process-wide IUIAutomation, which owns cache requests."""
    from uiautomation import uiautomation as internals

    return internals._AutomationClient.instance().IUIAutomation


@functools.lru_cache(maxsize=1)
def _role_names() -> dict[int, str]:
    """UIA control-type ids to the names the rest of the contract uses."""
    import uiautomation as auto

    return dict(auto.ControlTypeNames)


@functools.lru_cache(maxsize=1)
def _cached_property_ids() -> tuple[Any, ...]:
    properties = _PROPERTIES()
    return (
        properties.RuntimeIdProperty,
        properties.NameProperty,
        properties.ControlTypeProperty,
        properties.ClassNameProperty,
        properties.AutomationIdProperty,
        properties.HelpTextProperty,
        properties.IsEnabledProperty,
        properties.HasKeyboardFocusProperty,
        properties.BoundingRectangleProperty,
        properties.ValueValueProperty,
        properties.IsInvokePatternAvailableProperty,
        properties.IsExpandCollapsePatternAvailableProperty,
        properties.IsSelectionItemPatternAvailableProperty,
        properties.IsTogglePatternAvailableProperty,
        properties.IsScrollItemPatternAvailableProperty,
    )


_T = TypeVar("_T")
_thread_state = threading.local()


class WindowsComputerRuntimeError(RuntimeError):
    """A Windows-specific Computer Use failure with actionable detail."""


# ---------------------------------------------------------------------------
# Win32 bindings
#
# HDC/HBITMAP/HGDIOBJ are pointer-sized. ctypes defaults every restype to
# c_int, which truncates them on 64-bit Windows, so every handle-returning
# function used here declares its signature explicitly.
# ---------------------------------------------------------------------------

# This module is imported by tests that run on every platform, so the Windows
# libraries must not be resolved at import time.
if sys.platform == "win32":  # pragma: no branch - platform gate
    _user32 = ctypes.windll.user32
    _gdi32 = ctypes.windll.gdi32
    _kernel32 = ctypes.windll.kernel32
else:  # pragma: no cover - import-time compatibility only
    _user32 = _gdi32 = _kernel32 = None


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def _bind() -> None:
    if _user32 is None:  # pragma: no cover - non-Windows import
        return
    _user32.GetWindowDC.restype = wintypes.HDC
    _user32.GetWindowDC.argtypes = [wintypes.HWND]
    _user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    _user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    _user32.GetWindowLongW.restype = wintypes.LONG
    _user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    _gdi32.CreateCompatibleDC.restype = wintypes.HDC
    _gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    _gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    _gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    _gdi32.SelectObject.restype = wintypes.HGDIOBJ
    _gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    _gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    _gdi32.DeleteDC.argtypes = [wintypes.HDC]
    _gdi32.GetDIBits.argtypes = [
        wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
        ctypes.c_void_p, ctypes.POINTER(_BITMAPINFO), wintypes.UINT,
    ]
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


_bind()


# ---------------------------------------------------------------------------
# Dedicated UI Automation thread
# ---------------------------------------------------------------------------


def _initialize_uia_thread() -> None:
    import comtypes

    comtypes.CoInitialize()
    _thread_state.inside = True
    try:
        import uiautomation as auto

        # uiautomation otherwise drops an @AutomationLog.txt in the working
        # directory, which for a packaged build is the user's data directory.
        auto.Logger.SetLogFile(os.devnull)
    except Exception:
        pass


class _UiaThread:
    """Owns every UI Automation call made by this process.

    UI Automation is COM, so each thread must CoInitialize before touching it.
    uiautomation goes further and forbids using a Control or Pattern from any
    thread other than the one that created it. ComputerTool dispatches actions
    through asyncio.to_thread, so the element handles cached in StateStore would
    otherwise be created on one pool worker and used from another. Confining all
    UIA work to a single thread satisfies both constraints and serializes access
    to the runtime for free.
    """

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="openyak-uia",
            initializer=_initialize_uia_thread,
        )

    def run(self, work: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
        if getattr(_thread_state, "inside", False):
            # Re-entrant call from within the UIA thread (get_app_state ->
            # _resolve_app). Submitting again would deadlock the single worker.
            return work(*args, **kwargs)
        return self._executor.submit(work, *args, **kwargs).result()

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False)


def _uia(method: Callable[..., _T]) -> Callable[..., _T]:
    """Marshal a runtime entry point onto the dedicated UI Automation thread."""

    @functools.wraps(method)
    def wrapper(self: "WindowsComputerRuntime", *args: Any, **kwargs: Any) -> _T:
        return self._thread.run(method, self, *args, **kwargs)

    return wrapper


class WindowsComputerRuntime:
    def __init__(self) -> None:
        try:
            import uiautomation as auto
        except Exception as exc:  # pragma: no cover - Windows-only dependency
            raise WindowsComputerRuntimeError(
                "Windows Computer Use runtime is missing. Reinstall OpenYak to restore "
                "Microsoft UI Automation support."
            ) from exc
        self._auto = auto
        self._user32 = _user32
        self._states = StateStore()
        self._thread = _UiaThread()
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            _user32.SetProcessDPIAware()

    # -- discovery ---------------------------------------------------------

    def list_apps(self) -> list[AppDescriptor]:
        user32 = self._user32
        apps: list[AppDescriptor] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def collect(hwnd: int, _lparam: int) -> bool:
            if not _is_user_window(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                # Keyed by HWND, not PID: Explorer, Word and Chrome all put
                # several independent top-level windows on one process, and
                # collapsing them hides every window but the last one seen.
                apps.append(AppDescriptor(
                    name=title.value,
                    identifier=str(int(hwnd)),
                    pid=int(pid.value),
                    executable=_executable_for_pid(int(pid.value)),
                ))
            return True

        user32.EnumWindows(collect, 0)
        return sorted(apps, key=lambda item: (item.name.casefold(), item.identifier))

    def resolve_app(self, query: str) -> AppDescriptor:
        """Public resolution so callers can enforce policy on the real target."""
        return self._resolve_app(query)

    def _resolve_app(self, query: str) -> AppDescriptor:
        normalized = query.strip().casefold()
        apps = self.list_apps()
        exact = [item for item in apps if normalized in {item.name.casefold(), item.identifier}]
        if exact:
            return exact[0]
        # A Windows app name is its window title, and titles move under us: the
        # moment the agent edits a document the app prepends a modified marker.
        # Compare on the stripped title so a task does not lose its own target.
        bare = _bare_title(normalized)
        stripped = [item for item in apps if _bare_title(item.name.casefold()) == bare]
        if stripped:
            return stripped[0]
        partial = [
            item for item in apps
            if bare in _bare_title(item.name.casefold())
            or _bare_title(item.name.casefold()) in bare
        ]
        if len(partial) == 1:
            return partial[0]
        if partial:
            return max(partial, key=lambda item: len(item.name))
        raise ValueError(
            f"Application '{query}' was not found. Open windows: "
            + ", ".join(repr(item.name) for item in apps[:12])
        )

    # -- foreground --------------------------------------------------------

    def _activate_app(self, descriptor: AppDescriptor) -> None:
        """Bring the target window to the foreground.

        Windows refuses SetForegroundWindow from a process that does not already
        own the foreground or the last input event, which is always true of the
        OpenYak backend subprocess. Escalate through the documented sequence
        instead of taking the first refusal as final.
        """
        hwnd = int(descriptor.identifier)
        user32 = self._user32
        if user32.GetForegroundWindow() == hwnd:
            return
        if not user32.IsWindow(hwnd):
            raise WindowsComputerRuntimeError(
                f"The window for '{descriptor.name}' has closed; call get_app_state again"
            )
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, _SW_RESTORE)

        previous_timeout = _foreground_lock_timeout()
        _set_foreground_lock_timeout(0)
        try:
            for attempt in range(3):
                self._request_foreground(hwnd)
                if _wait_for_foreground(hwnd):
                    return
                # The system re-enables foreground changes after the user
                # presses ALT; synthesizing one has the same effect.
                _tap_alt()
        finally:
            _set_foreground_lock_timeout(previous_timeout)

        foreground = user32.GetForegroundWindow()
        blocker = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(foreground, blocker, 256)
        raise WindowsComputerRuntimeError(
            f"Windows kept '{blocker.value or 'another window'}' in the foreground, so "
            f"'{descriptor.name}' could not receive synthetic input. Windows Computer Use "
            "needs the target app on the active, unlocked desktop; a full-screen app, the "
            "lock screen or a UAC secure-desktop prompt will block it."
        )

    def _request_foreground(self, hwnd: int) -> None:
        user32 = self._user32
        current = _kernel32.GetCurrentThreadId()
        foreground = user32.GetForegroundWindow()
        threads = {
            user32.GetWindowThreadProcessId(hwnd, None),
            user32.GetWindowThreadProcessId(foreground, None) if foreground else 0,
        }
        attached = []
        for thread in threads:
            if thread and thread != current and user32.AttachThreadInput(current, thread, True):
                attached.append(thread)
        try:
            user32.AllowSetForegroundWindow(_ASFW_ANY)
            user32.ShowWindow(hwnd, _SW_SHOW)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
        finally:
            for thread in attached:
                user32.AttachThreadInput(current, thread, False)

    # -- state -------------------------------------------------------------

    @_uia
    def get_app_state(
        self,
        app: str,
        *,
        session_id: str,
        disable_diff: bool = False,
    ) -> AppState:
        descriptor = self._resolve_app(app)
        hwnd = int(descriptor.identifier)
        root = self._auto.ControlFromHandle(hwnd)
        if root is None:
            raise WindowsComputerRuntimeError(
                f"'{descriptor.name}' did not expose a UI Automation tree"
            )
        elements, handles = self._read_tree(root, session_id, descriptor)
        previous = self._states.previous(session_id, descriptor.identifier)
        revision, changed, removed = self._states.save(
            session_id, descriptor.identifier, elements, handles
        )
        screenshot, width, height, bounds, reason = _capture_window(hwnd)
        is_diff = previous is not None and not disable_diff
        return AppState(
            app=descriptor,
            elements=[item for item in elements if item.index in changed] if is_diff else elements,
            screenshot_data_url=screenshot,
            screenshot_width=width,
            screenshot_height=height,
            screenshot_bounds=bounds,
            revision=revision,
            changed_indices=changed,
            removed_indices=removed,
            is_diff=is_diff,
            screenshot_unavailable_reason=reason,
        )

    def _read_tree(
        self, root: Any, session_id: str, descriptor: AppDescriptor
    ) -> tuple[list[ElementSnapshot], dict[int, Any]]:
        """Snapshot the accessibility tree, preferring a single bulk fetch.

        Reading properties one at a time is a cross-process COM call each, which
        is what UI Automation's cache requests exist to avoid: one
        BuildUpdatedCache pulls the whole subtree and every property we need,
        after which the walk is in-process. Falls back to the live walk for apps
        whose providers refuse a cached request.
        """
        try:
            return self._read_tree_cached(root, session_id, descriptor)
        except Exception:
            return self._read_tree_live(root, session_id, descriptor)

    def _read_tree_cached(
        self, root: Any, session_id: str, descriptor: AppDescriptor
    ) -> tuple[list[ElementSnapshot], dict[int, Any]]:
        auto = self._auto
        request = _AUTOMATION_CLIENT().CreateCacheRequest()
        for property_id in _cached_property_ids():
            request.AddProperty(property_id)
        request.TreeScope = _TREE_SCOPE_SUBTREE
        # The raw view matches what uiautomation's own GetChildren traverses, so
        # the cached element set is identical to the live one.
        request.TreeFilter = _AUTOMATION_CLIENT().RawViewCondition
        cached_root = root.Element.BuildUpdatedCache(request)

        elements: list[ElementSnapshot] = []
        handles: dict[int, Any] = {}
        seen: set[str] = set()
        # Focus is reported by the focused element *and* its ancestors, so this
        # collects every candidate rather than assuming a single one.
        focused: list[tuple[int, Any]] = []

        def walk(element: Any, depth: int, parent: int | None, path: str) -> None:
            if len(elements) >= _MAX_ELEMENTS or depth > _MAX_DEPTH:
                return
            identity = _cached_identity(element, path)
            if identity in seen:
                return
            seen.add(identity)
            index = self._states.index_for(session_id, descriptor.identifier, identity)
            role = _role_names().get(_cached(element, "CachedControlType"), "Control")
            has_focus = bool(_cached(element, "CachedHasKeyboardFocus", False))
            if has_focus:
                focused.append((index, element))
            elements.append(ElementSnapshot(
                index=index,
                role=role,
                name=_clip(str(_cached(element, "CachedName", "") or "")),
                value=_clip(_cached_value(element, role)),
                description=_clip(str(_cached(element, "CachedHelpText", "") or "")),
                identifier=_clip(str(_cached(element, "CachedAutomationId", "") or "")),
                enabled=bool(_cached(element, "CachedIsEnabled", True)),
                focused=has_focus,
                bounds=_cached_bounds(element),
                depth=depth,
                parent=parent,
                subrole=_clip(str(_cached(element, "CachedClassName", "") or "")),
                actions=_cached_actions(element),
                selected_text_range=None,
                busy=False,
            ))
            handles[index] = element
            try:
                children = element.GetCachedChildren()
            except Exception:
                children = None
            if not children:
                return
            counts: dict[str, int] = {}
            for position in range(children.Length):
                child = children.GetElement(position)
                child_role = _role_names().get(
                    _cached(child, "CachedControlType"), "Control"
                )
                order = counts.get(child_role, 0)
                counts[child_role] = order + 1
                walk(child, depth + 1, index, f"{path}/{child_role}[{order}]")

        walk(cached_root, 0, None, "root")
        if not elements:
            raise WindowsComputerRuntimeError("cached tree was empty")

        # Selection offsets need a live TextPattern, so they stay outside the
        # cached fetch; only elements holding focus can carry one. Deepest
        # first, because the innermost focused element is the text host.
        positions = {item.index: order for order, item in enumerate(elements)}
        for index, element in reversed(focused):
            control = auto.Control.CreateControlFromElement(element)
            selection = self._selected_text_range(control, True) if control else None
            if selection is None:
                continue
            order = positions.get(index)
            if order is not None:
                elements[order] = replace(
                    elements[order], selected_text_range=selection
                )
            break
        return elements, handles

    def _read_tree_live(
        self, root: Any, session_id: str, descriptor: AppDescriptor
    ) -> tuple[list[ElementSnapshot], dict[int, Any]]:
        elements: list[ElementSnapshot] = []
        handles: dict[int, Any] = {}
        seen: set[str] = set()

        def walk(control: Any, depth: int, parent: int | None, path: str) -> None:
            if len(elements) >= _MAX_ELEMENTS or depth > _MAX_DEPTH:
                return
            identity = _element_identity(control, path)
            if identity in seen:
                return
            seen.add(identity)
            # Session-stable and never recycled, so an index handed to the model
            # in one revision still means the same element in the next one.
            index = self._states.index_for(session_id, descriptor.identifier, identity)
            role = str(getattr(control, "ControlTypeName", "Control"))
            focused = bool(getattr(control, "HasKeyboardFocus", False))
            snapshot = ElementSnapshot(
                index=index,
                role=role,
                name=_clip(str(getattr(control, "Name", "") or "")),
                value=_clip(self._element_value(control, role)),
                description=_clip(str(getattr(control, "HelpText", "") or "")),
                identifier=_clip(str(getattr(control, "AutomationId", "") or "")),
                enabled=bool(getattr(control, "IsEnabled", True)),
                focused=focused,
                bounds=_bounds(control),
                depth=depth,
                parent=parent,
                subrole=_clip(str(getattr(control, "ClassName", "") or "")),
                actions=self._element_actions(control, role),
                selected_text_range=self._selected_text_range(control, focused),
                busy=False,
            )
            elements.append(snapshot)
            handles[index] = control
            try:
                children = control.GetChildren()
            except Exception:
                children = []
            counts: dict[str, int] = {}
            for child in children:
                child_role = str(getattr(child, "ControlTypeName", "Control"))
                order = counts.get(child_role, 0)
                counts[child_role] = order + 1
                walk(child, depth + 1, index, f"{path}/{child_role}[{order}]")

        walk(root, 0, None, "root")
        return elements, handles

    def _element_value(self, control: Any, role: str) -> str:
        if role in _VALUELESS_ROLES or "Password" in role:
            return ""
        try:
            pattern = control.GetPattern(self._auto.PatternId.ValuePattern)
            return str(pattern.Value or "") if pattern else ""
        except Exception:
            return ""

    def _element_actions(self, control: Any, role: str) -> tuple[str, ...]:
        """Report the secondary actions this element actually supports.

        The tool contract tells the model to pass exposed actions verbatim to
        perform_secondary_action, and computer.py hit-tests screenshot clicks on
        this field, so it has to reflect real UIA pattern availability.

        Every probe is a cross-process COM call, so purely structural roles --
        which make up most of a real tree and never carry these patterns -- skip
        straight to the context menu that any element supports.
        """
        if role in _STRUCTURAL_ROLES:
            return ("showmenu",)
        auto = self._auto
        available = []
        for action, pattern_id in (
            ("invoke", auto.PatternId.InvokePattern),
            ("expand", auto.PatternId.ExpandCollapsePattern),
            ("collapse", auto.PatternId.ExpandCollapsePattern),
            ("select", auto.PatternId.SelectionItemPattern),
            ("toggle", auto.PatternId.TogglePattern),
            ("scrollintoview", auto.PatternId.ScrollItemPattern),
        ):
            try:
                if control.GetPattern(pattern_id) is not None:
                    available.append(action)
            except Exception:
                continue
        available.append("showmenu")
        return tuple(available)

    def _selected_text_range(self, control: Any, focused: bool) -> tuple[int, int] | None:
        """Character offsets of the selection, for the focused element only.

        Computing this costs a GetText over the whole document, so doing it for
        every element dominated the cost of a snapshot. A selection only matters
        where the caret is.
        """
        if not focused:
            return None
        try:
            pattern = control.GetPattern(self._auto.PatternId.TextPattern)
            if pattern is None:
                return None
            selection = pattern.GetSelection()
            if not selection:
                return None
            head = pattern.DocumentRange.Clone()
            # Move the clone's end back to the selection's start; its length is
            # then the selection's character offset.
            head.MoveEndpointByRange(_ENDPOINT_END, selection[0], _ENDPOINT_START, waitTime=0)
            start = len(head.GetText(-1))
            return (start, len(selection[0].GetText(-1)))
        except Exception:
            return None

    def _target(self, app: str, session_id: str, element_index: int) -> Any:
        descriptor = self._resolve_app(app)
        handle = self._states.handle(session_id, descriptor.identifier, element_index)
        # The cached walk stores raw IUIAutomationElements; actions need the
        # uiautomation Control wrapper around them. Wrapping here keeps the
        # snapshot itself free of ~900 wrapper objects it never uses.
        if not hasattr(handle, "ControlTypeName"):
            control = self._auto.Control.CreateControlFromElement(handle)
            if control is None:
                raise ValueError(
                    f"element_index {element_index} no longer resolves to a live "
                    "element; call get_app_state again"
                )
            return control
        return handle

    @_uia
    def inspect_element(
        self, app: str, *, session_id: str, element_index: int
    ) -> ElementSnapshot:
        descriptor = self._resolve_app(app)
        return self._states.element(session_id, descriptor.identifier, element_index)

    # -- input -------------------------------------------------------------

    @_uia
    def click(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        button: str = "left",
        click_count: int = 1,
    ) -> None:
        if element_index is not None:
            target = self._target(app, session_id, element_index)
            if button in {"right", "r"}:
                target.RightClick(simulateMove=False, waitTime=0)
            elif click_count == 2:
                target.DoubleClick(simulateMove=False, waitTime=0)
            else:
                # UIA Invoke/Selection patterns are used by Click when available.
                target.Click(simulateMove=False, waitTime=0)
            return
        if x is None or y is None:
            raise ValueError("click requires element_index, or both x and y")
        descriptor = self._resolve_app(app)
        self._states.require_coordinate_within_app(
            session_id, descriptor.identifier, float(x), float(y)
        )
        self._activate_app(descriptor)
        if button in {"right", "r"}:
            self._auto.RightClick(int(x), int(y), waitTime=0)
        elif click_count == 2:
            self._auto.Click(int(x), int(y), waitTime=0)
            self._auto.Click(int(x), int(y), waitTime=0)
        else:
            self._auto.Click(int(x), int(y), waitTime=0)

    @_uia
    def drag(
        self,
        app: str,
        *,
        session_id: str,
        from_x: float,
        from_y: float,
        to_x: float,
        to_y: float,
    ) -> None:
        descriptor = self._resolve_app(app)
        for x, y in ((from_x, from_y), (to_x, to_y)):
            self._states.require_coordinate_within_app(
                session_id, descriptor.identifier, float(x), float(y)
            )
        self._activate_app(descriptor)
        self._auto.DragDrop(int(from_x), int(from_y), int(to_x), int(to_y), waitTime=0)

    @_uia
    def set_value(self, app: str, *, session_id: str, element_index: int, value: str) -> None:
        target = self._target(app, session_id, element_index)
        pattern = self._pattern(target, self._auto.PatternId.ValuePattern)
        if pattern is None or getattr(pattern, "IsReadOnly", False):
            raise WindowsComputerRuntimeError(
                f"{_role_of(target)} does not accept a value through UI Automation"
            )
        pattern.SetValue(value, waitTime=0)

    @_uia
    def type_text(
        self,
        app: str,
        *,
        session_id: str,
        text: str,
        element_index: int | None = None,
    ) -> None:
        target = None
        if element_index is not None:
            target = self._target(app, session_id, element_index)
        else:
            # macOS falls back to the focused element; match that here instead
            # of forcing the model to re-read state just to type.
            try:
                target = self._auto.GetFocusedControl()
            except Exception:
                target = None
        if target is not None:
            pattern = self._pattern(target, self._auto.PatternId.ValuePattern)
            if pattern is not None and not getattr(pattern, "IsReadOnly", False):
                pattern.SetValue(str(pattern.Value or "") + text, waitTime=0)
                return
        # Last resort: real keystrokes, which need the window in the foreground.
        descriptor = self._resolve_app(app)
        self._activate_app(descriptor)
        self._auto.SendKeys(_escape_send_keys(text), waitTime=0)

    @_uia
    def press_key(
        self,
        app: str,
        *,
        session_id: str,
        key: str,
        modifiers: list[str] | None = None,
    ) -> None:
        del session_id
        descriptor = self._resolve_app(app)
        parts = [part.strip() for part in key.split("+") if part.strip()]
        if not parts:
            raise ValueError("key must not be empty")
        key = parts[-1]
        chord = [*(modifiers or []), *parts[:-1]]
        prefix = "".join(_MODIFIERS.get(item.casefold(), "") for item in chord)
        unknown = [item for item in chord if item.casefold() not in _MODIFIERS]
        if unknown:
            raise ValueError(f"Unsupported modifier(s): {', '.join(unknown)}")
        self._activate_app(descriptor)
        stroke = _KEY_ALIASES.get(key.casefold())
        if stroke is None:
            stroke = key if len(key) == 1 else "{" + key + "}"
            if len(key) == 1:
                stroke = _escape_send_keys(key)
        self._auto.SendKeys(prefix + stroke, waitTime=0)

    @_uia
    def scroll(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        direction: str,
        pages: int = 1,
    ) -> None:
        target = self._target(app, session_id, element_index)
        normalized = direction.strip().casefold()
        if normalized not in _SCROLL_DIRECTIONS:
            raise ValueError(
                f"direction must be one of up, down, left, right (got {direction!r})"
            )
        horizontal, forward = _SCROLL_DIRECTIONS[normalized]
        amounts = self._auto.ScrollAmount
        # ScrollPattern.Scroll takes ScrollAmount enum members, not signed
        # deltas: NoAmount=2 leaves an axis alone, and passing 0/-1 either
        # scrolls the wrong way or silently does nothing.
        step = amounts.LargeIncrement if forward else amounts.LargeDecrement
        horizontal_amount = step if horizontal else amounts.NoAmount
        vertical_amount = amounts.NoAmount if horizontal else step
        repeats = max(1, min(20, int(pages)))

        pattern = self._pattern(target, self._auto.PatternId.ScrollPattern)
        if pattern is not None:
            scrollable = (
                getattr(pattern, "HorizontallyScrollable", False) if horizontal
                else getattr(pattern, "VerticallyScrollable", False)
            )
            if scrollable:
                for _ in range(repeats):
                    pattern.Scroll(horizontal_amount, vertical_amount, waitTime=0)
                return
        if self._scroll_by_wheel(target, horizontal, forward, repeats):
            return
        raise WindowsComputerRuntimeError(
            f"{_role_of(target)} is not scrollable in that direction"
        )

    def _scroll_by_wheel(
        self, target: Any, horizontal: bool, forward: bool, repeats: int
    ) -> bool:
        """Fall back to a real wheel event over the element's centre.

        uiautomation only synthesizes a vertical wheel, so horizontal scrolling
        has no fallback beyond ScrollPattern.
        """
        if horizontal:
            return False
        bounds = _bounds(target)
        if bounds is None:
            return False
        left, top, width, height = bounds
        try:
            _user32.SetCursorPos(int(left + width / 2), int(top + height / 2))
            for _ in range(repeats):
                if forward:
                    self._auto.WheelDown(3, waitTime=0)
                else:
                    self._auto.WheelUp(3, waitTime=0)
            return True
        except Exception:
            return False

    @_uia
    def select_text(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        text: str,
        prefix: str = "",
        suffix: str = "",
        selection_type: str = "text",
    ) -> None:
        if selection_type not in {"text", "cursor_before", "cursor_after"}:
            raise ValueError("selection_type must be text, cursor_before, or cursor_after")
        if not text:
            raise ValueError("text must not be empty")
        target = self._target(app, session_id, element_index)
        pattern = self._pattern(target, self._auto.PatternId.TextPattern)
        if pattern is None:
            raise WindowsComputerRuntimeError(
                f"{_role_of(target)} does not expose selectable text"
            )
        document = pattern.DocumentRange
        body = document.GetText(-1)
        # Same contract as the macOS runtime: prefix/suffix are adjacency
        # constraints on the surrounding text, and an ambiguous match is an
        # error rather than a silent pick of the first occurrence.
        matches = []
        offset = 0
        while True:
            position = body.find(text, offset)
            if position < 0:
                break
            end = position + len(text)
            before_ok = not prefix or body[max(0, position - len(prefix)):position] == prefix
            after_ok = not suffix or body[end:end + len(suffix)] == suffix
            if before_ok and after_ok:
                matches.append((position, end))
            offset = position + 1
        if not matches:
            raise ValueError(f"Requested text was not found in {_role_of(target)}")
        if len(matches) > 1:
            raise ValueError("Text match is ambiguous; provide prefix and/or suffix")
        start, end = matches[0]
        if selection_type == "cursor_before":
            selection = _character_range(document, start, 0)
        elif selection_type == "cursor_after":
            selection = _character_range(document, end, 0)
        else:
            selection = _character_range(document, start, end - start)
        selection.Select(waitTime=0)

    @_uia
    def perform_secondary_action(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        action: str,
    ) -> None:
        target = self._target(app, session_id, element_index)
        normalized = "".join(character for character in action.casefold() if character.isalnum())
        if normalized not in _SECONDARY_ACTIONS:
            raise ValueError(
                f"Unsupported action {action!r}; this element exposes "
                f"{list(self._element_actions(target, _role_of(target)))}"
            )
        auto = self._auto
        if normalized == "showmenu":
            target.RightClick(simulateMove=False, waitTime=0)
            return
        pattern_id, call = {
            "invoke": (auto.PatternId.InvokePattern, lambda p: p.Invoke(waitTime=0)),
            "expand": (auto.PatternId.ExpandCollapsePattern, lambda p: p.Expand(waitTime=0)),
            "collapse": (auto.PatternId.ExpandCollapsePattern, lambda p: p.Collapse(waitTime=0)),
            "select": (auto.PatternId.SelectionItemPattern, lambda p: p.Select(waitTime=0)),
            "toggle": (auto.PatternId.TogglePattern, lambda p: p.Toggle(waitTime=0)),
            "scrollintoview": (auto.PatternId.ScrollItemPattern, lambda p: p.ScrollIntoView(waitTime=0)),
        }[normalized]
        pattern = self._pattern(target, pattern_id)
        if pattern is None:
            raise WindowsComputerRuntimeError(
                f"{_role_of(target)} does not support {normalized!r}; it exposes "
                f"{list(self._element_actions(target, _role_of(target)))}"
            )
        call(pattern)

    @_uia
    def wait_for_stability(
        self,
        app: str,
        *,
        session_id: str,
        timeout: float = 5.0,
    ) -> None:
        """Settle adaptively instead of sleeping for a fixed period."""
        del session_id
        descriptor = self._resolve_app(app)
        hwnd = int(descriptor.identifier)
        deadline = time.monotonic() + max(0.5, min(timeout, 5.0))
        time.sleep(min(0.15, max(0.0, deadline - time.monotonic())))
        previous: tuple[Any, ...] | None = None
        unchanged_since = time.monotonic()
        while time.monotonic() < deadline:
            signature = self._state_signature(hwnd)
            now = time.monotonic()
            if signature != previous:
                previous = signature
                unchanged_since = now
            elif now - unchanged_since >= 0.25:
                return
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))

    def _state_signature(self, hwnd: int) -> tuple[Any, ...]:
        try:
            root = self._auto.ControlFromHandle(hwnd)
        except Exception:
            return ()
        if root is None:
            return ()
        values: list[tuple[Any, ...]] = []

        def walk(control: Any, depth: int) -> None:
            if len(values) >= 200 or depth > 8:
                return
            try:
                rect = control.BoundingRectangle
                box = (rect.left, rect.top, rect.right, rect.bottom) if rect else None
            except Exception:
                box = None
            values.append((
                str(getattr(control, "ControlTypeName", "")),
                _clip(str(getattr(control, "Name", "") or ""))[:80],
                box,
            ))
            try:
                children = control.GetChildren()
            except Exception:
                children = []
            for child in children:
                walk(child, depth + 1)

        walk(root, 0)
        return tuple(values)

    def _pattern(self, control: Any, pattern_id: Any) -> Any:
        """Generic pattern access.

        The per-control-type helpers (GetInvokePattern, GetScrollItemPattern,
        ...) only exist on the uiautomation classes that declare them, so
        calling them raises AttributeError for a merely unsupported pattern.
        GetPattern is defined on every Control and returns None instead.
        """
        try:
            return control.GetPattern(pattern_id)
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MODIFIERS = {
    "control": "{Ctrl}", "ctrl": "{Ctrl}",
    "shift": "{Shift}",
    "alt": "{Alt}", "option": "{Alt}",
    # cmd/command is a macOS accelerator; its Windows equivalent is Ctrl, not
    # the Windows key. meta/super/win stay mapped to the physical Windows key
    # because the workspace UI sends "meta" for event.metaKey.
    "cmd": "{Ctrl}", "command": "{Ctrl}",
    "win": "{Win}", "windows": "{Win}", "super": "{Win}", "meta": "{Win}",
}

_KEY_ALIASES = {
    "return": "{Enter}", "enter": "{Enter}", "escape": "{Esc}", "esc": "{Esc}",
    "tab": "{Tab}", "backspace": "{Back}", "delete": "{Delete}", "del": "{Delete}",
    "left": "{Left}", "right": "{Right}", "up": "{Up}", "down": "{Down}",
    "pageup": "{PageUp}", "pagedown": "{PageDown}", "home": "{Home}", "end": "{End}",
    "space": " ", "insert": "{Insert}",
    **{f"f{n}": f"{{F{n}}}" for n in range(1, 25)},
}

_SCROLL_DIRECTIONS = {
    "up": (False, False), "u": (False, False),
    "down": (False, True), "d": (False, True),
    "left": (True, False), "l": (True, False),
    "right": (True, True), "r": (True, True),
}


def _escape_send_keys(text: str) -> str:
    """uiautomation.SendKeys treats {...} as key names; escape literal braces.

    Single pass: replacing "{" then "}" would re-escape the brace introduced by
    the first substitution.
    """
    return "".join(_SEND_KEYS_ESCAPES.get(character, character) for character in text)


_SEND_KEYS_ESCAPES = {"{": "{{}", "}": "{}}"}


def _cached(element: Any, name: str, default: Any = None) -> Any:
    try:
        return getattr(element, name)
    except Exception:
        return default


def _cached_identity(element: Any, structural_path: str) -> str:
    try:
        runtime_id = element.GetCachedPropertyValue(_PROPERTIES().RuntimeIdProperty)
        if runtime_id:
            return "rt:" + ".".join(str(part) for part in runtime_id)
    except Exception:
        pass
    return "path:" + structural_path


def _cached_bounds(element: Any) -> tuple[float, float, float, float] | None:
    rect = _cached(element, "CachedBoundingRectangle")
    if rect is None:
        return None
    try:
        left, top, right, bottom = (
            float(rect.left), float(rect.top), float(rect.right), float(rect.bottom)
        )
    except AttributeError:
        try:
            left, top, right, bottom = (float(value) for value in rect)
        except Exception:
            return None
    except Exception:
        return None
    if right - left <= 0 or bottom - top <= 0:
        return None
    return (left, top, right - left, bottom - top)


def _cached_value(element: Any, role: str) -> str:
    if role in _VALUELESS_ROLES or "Password" in role:
        return ""
    try:
        value = element.GetCachedPropertyValue(_PROPERTIES().ValueValueProperty)
        return str(value or "")
    except Exception:
        return ""


def _cached_actions(element: Any) -> tuple[str, ...]:
    """Secondary actions, read from cached pattern availability.

    Free once the subtree is cached, so unlike the live walk this reports the
    real availability for every element rather than skipping structural roles.
    """
    properties = _PROPERTIES()
    available: list[str] = []
    try:
        if element.GetCachedPropertyValue(properties.IsInvokePatternAvailableProperty):
            available.append("invoke")
        if element.GetCachedPropertyValue(
            properties.IsExpandCollapsePatternAvailableProperty
        ):
            available.extend(("expand", "collapse"))
        if element.GetCachedPropertyValue(
            properties.IsSelectionItemPatternAvailableProperty
        ):
            available.append("select")
        if element.GetCachedPropertyValue(properties.IsTogglePatternAvailableProperty):
            available.append("toggle")
        if element.GetCachedPropertyValue(
            properties.IsScrollItemPatternAvailableProperty
        ):
            available.append("scrollintoview")
    except Exception:
        pass
    # Any element can be right-clicked for a context menu.
    available.append("showmenu")
    return tuple(available)


def _bare_title(title: str) -> str:
    """Drop the unsaved-changes markers apps prepend or append to a title."""
    return title.strip().lstrip("*•● ").removesuffix(" - modified").strip()


def _role_of(control: Any) -> str:
    return str(getattr(control, "ControlTypeName", "Element"))


def _bounds(control: Any) -> tuple[float, float, float, float] | None:
    try:
        rect = control.BoundingRectangle
    except Exception:
        return None
    if not rect or rect.width() <= 0 or rect.height() <= 0:
        return None
    return (float(rect.left), float(rect.top), float(rect.width()), float(rect.height()))


def _element_identity(control: Any, structural_path: str) -> str:
    """Identity that survives tree changes, so indices stay meaningful."""
    try:
        runtime_id = control.GetRuntimeId()
        if runtime_id:
            return "rt:" + ".".join(str(part) for part in runtime_id)
    except Exception:
        pass
    return "path:" + structural_path


def _character_range(document: Any, start: int, length: int) -> Any:
    """Build a text range from character offsets into the document text."""
    selection = document.Clone()
    selection.MoveEndpointByRange(_ENDPOINT_END, selection, _ENDPOINT_START, waitTime=0)
    if start:
        selection.MoveEndpointByUnit(_ENDPOINT_START, _TEXT_UNIT_CHARACTER, start, waitTime=0)
        selection.MoveEndpointByRange(_ENDPOINT_END, selection, _ENDPOINT_START, waitTime=0)
    if length:
        selection.MoveEndpointByUnit(_ENDPOINT_END, _TEXT_UNIT_CHARACTER, length, waitTime=0)
    return selection


def _is_user_window(hwnd: int) -> bool:
    if not _user32.IsWindowVisible(hwnd) or _user32.GetWindowTextLengthW(hwnd) == 0:
        return False
    if _user32.GetWindow(hwnd, _GW_OWNER):
        return False
    if _user32.GetWindowLongW(hwnd, _GWL_EXSTYLE) & _WS_EX_TOOLWINDOW:
        return False
    class_name = ctypes.create_unicode_buffer(256)
    _user32.GetClassNameW(hwnd, class_name, 256)
    if class_name.value in _SHELL_WINDOW_CLASSES:
        return False
    if class_name.value == _UWP_CONTENT_CLASS:
        return False
    # DWM reports suspended packaged apps and stale placeholders as cloaked;
    # they are on the window list but cannot be seen or driven.
    cloaked = wintypes.DWORD()
    try:
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(hwnd), _DWMWA_CLOAKED,
            ctypes.byref(cloaked), ctypes.sizeof(cloaked),
        ) == 0 and cloaked.value:
            return False
    except Exception:
        pass
    return True


def _executable_for_pid(pid: int) -> str:
    """Executable basename, used to gate sensitive applications.

    Window titles are attacker- and document-controlled, so they cannot be the
    basis of a security decision; the image name is stable.
    """
    handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if _kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(size)
        ):
            return os.path.basename(buffer.value)
        return ""
    finally:
        _kernel32.CloseHandle(handle)


def _foreground_lock_timeout() -> int:
    value = wintypes.DWORD()
    if _user32.SystemParametersInfoW(
        _SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(value), 0
    ):
        return int(value.value)
    return 0


def _set_foreground_lock_timeout(milliseconds: int) -> None:
    try:
        _user32.SystemParametersInfoW(
            _SPI_SETFOREGROUNDLOCKTIMEOUT, 0,
            ctypes.c_void_p(milliseconds), _SPIF_SENDCHANGE,
        )
    except Exception:
        pass


def _tap_alt() -> None:
    try:
        _user32.keybd_event(_VK_MENU, 0, 0, 0)
        _user32.keybd_event(_VK_MENU, 0, _KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def _wait_for_foreground(hwnd: int, timeout: float = 0.6) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.03)
    return _user32.GetForegroundWindow() == hwnd


def _capture_window(
    hwnd: int,
) -> tuple[
    str | None,
    int | None,
    int | None,
    tuple[float, float, float, float] | None,
    str | None,
]:
    rect = wintypes.RECT()
    if not _user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None, None, None, None, "The target window has no on-screen rectangle"
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None, None, None, None, "The target window is minimized or has zero size"
    screen_bounds = (float(rect.left), float(rect.top), float(width), float(height))

    image = _print_window(hwnd, width, height)
    if image is None:
        # PrintWindow depends on the app honouring WM_PRINT. Fall back to a
        # screen grab, which is correct only while nothing overlaps the window.
        image = _grab_screen_region(rect)
        if image is None:
            return None, None, None, screen_bounds, "Windows could not capture this window"

    if image.width > _MAX_IMAGE[0] or image.height > _MAX_IMAGE[1]:
        from PIL import Image

        image.thumbnail(_MAX_IMAGE, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    # compress_level 1 keeps the live view responsive; these frames are
    # transient and re-encoded on every poll.
    image.convert("RGB").save(buffer, format="PNG", compress_level=1)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return (
        f"data:image/png;base64,{encoded}",
        image.width,
        image.height,
        screen_bounds,
        None,
    )


def _print_window(hwnd: int, width: int, height: int) -> Any:
    """Capture the window's own pixels, even when another window covers it."""
    window_dc = _user32.GetWindowDC(hwnd)
    if not window_dc:
        return None
    memory_dc = _gdi32.CreateCompatibleDC(window_dc)
    bitmap = _gdi32.CreateCompatibleBitmap(window_dc, width, height)
    try:
        if not memory_dc or not bitmap:
            return None
        _gdi32.SelectObject(memory_dc, bitmap)
        if not _user32.PrintWindow(hwnd, memory_dc, _PW_RENDERFULLCONTENT):
            return None
        info = _BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height  # negative: top-down rows
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0
        pixels = ctypes.create_string_buffer(width * height * 4)
        if not _gdi32.GetDIBits(memory_dc, bitmap, 0, height, pixels,
                                ctypes.byref(info), 0):
            return None
        from PIL import Image

        image = Image.frombuffer("RGB", (width, height), pixels, "raw", "BGRX", 0, 1)
        if image.convert("L").getextrema() == (0, 0):
            return None  # fully black: the app ignored WM_PRINT
        return image
    except Exception:
        return None
    finally:
        if bitmap:
            _gdi32.DeleteObject(bitmap)
        if memory_dc:
            _gdi32.DeleteDC(memory_dc)
        _user32.ReleaseDC(hwnd, window_dc)


def _grab_screen_region(rect: wintypes.RECT) -> Any:
    try:
        from PIL import ImageGrab

        return ImageGrab.grab(
            bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True
        )
    except Exception:
        return None


def _clip(value: str) -> str:
    value = value.replace("\x00", "").strip()
    return value if len(value) <= 500 else value[:499] + "…"
