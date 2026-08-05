"""Windows Computer Use runtime backed by Microsoft UI Automation."""

from __future__ import annotations

import base64
import ctypes
import io
import time
from ctypes import wintypes
from typing import Any

from app.computer_runtime.base import AppDescriptor, AppState, ElementSnapshot
from app.computer_runtime.state import StateStore


class WindowsComputerRuntime:
    def __init__(self) -> None:
        try:
            import uiautomation as auto
        except Exception as exc:  # pragma: no cover - Windows-only dependency
            raise RuntimeError(
                "Windows Computer Use runtime is missing. Reinstall OpenYak to restore "
                "Microsoft UI Automation support."
            ) from exc
        self._auto = auto
        self._user32 = ctypes.windll.user32
        self._states = StateStore()
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()

    def list_apps(self) -> list[AppDescriptor]:
        user32 = self._user32
        apps: dict[int, AppDescriptor] = {}

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def collect(hwnd: int, _lparam: int) -> bool:
            if not user32.IsWindowVisible(hwnd) or user32.GetWindowTextLengthW(hwnd) == 0:
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                apps[int(pid.value)] = AppDescriptor(
                    name=title.value,
                    identifier=str(int(hwnd)),
                    pid=int(pid.value),
                )
            return True

        user32.EnumWindows(collect, 0)
        return sorted(apps.values(), key=lambda item: item.name.casefold())

    def _resolve_app(self, query: str) -> AppDescriptor:
        normalized = query.strip().casefold()
        apps = self.list_apps()
        exact = [item for item in apps if normalized in {item.name.casefold(), item.identifier}]
        if exact:
            return exact[0]
        partial = [item for item in apps if normalized in item.name.casefold()]
        if len(partial) == 1:
            return partial[0]
        if partial:
            return max(partial, key=lambda item: len(item.name))
        raise ValueError(f"Application '{query}' was not found")

    def _activate_app(self, descriptor: AppDescriptor) -> None:
        hwnd = int(descriptor.identifier)
        # Restore minimized windows before requesting foreground ownership.
        # Windows intentionally runs Computer Use in foreground mode.
        self._user32.ShowWindow(hwnd, 9)
        if not self._user32.SetForegroundWindow(hwnd):
            raise RuntimeError("Windows could not bring the target application to the foreground")

    def get_app_state(
        self,
        app: str,
        *,
        session_id: str,
        disable_diff: bool = False,
    ) -> AppState:
        descriptor = self._resolve_app(app)
        root = self._auto.ControlFromHandle(int(descriptor.identifier))
        elements: list[ElementSnapshot] = []
        handles: dict[int, Any] = {}

        def walk(control: Any, depth: int, parent: int | None) -> None:
            if len(elements) >= 900 or depth > 24:
                return
            index = len(elements)
            rect = getattr(control, "BoundingRectangle", None)
            bounds = None
            if rect and rect.width() > 0 and rect.height() > 0:
                bounds = (float(rect.left), float(rect.top), float(rect.width()), float(rect.height()))
            value = ""
            try:
                if "Password" not in str(getattr(control, "ControlTypeName", "")):
                    value = str(control.GetValuePattern().Value or "")
            except Exception:
                pass
            elements.append(ElementSnapshot(
                index=index,
                role=str(getattr(control, "ControlTypeName", "Control")),
                name=_clip(str(getattr(control, "Name", "") or "")),
                value=_clip(value),
                description=_clip(str(getattr(control, "HelpText", "") or "")),
                identifier=_clip(str(getattr(control, "AutomationId", "") or "")),
                enabled=bool(getattr(control, "IsEnabled", True)),
                focused=bool(getattr(control, "HasKeyboardFocus", False)),
                bounds=bounds,
                depth=depth,
                parent=parent,
            ))
            handles[index] = control
            try:
                children = control.GetChildren()
            except Exception:
                children = []
            for child in children:
                walk(child, depth + 1, index)

        walk(root, 0, None)
        previous = self._states.previous(session_id, descriptor.identifier)
        revision, changed, removed = self._states.save(
            session_id, descriptor.identifier, elements, handles
        )
        screenshot, width, height, screenshot_bounds = _capture_window(root)
        is_diff = previous is not None and not disable_diff
        return AppState(
            app=descriptor,
            elements=[item for item in elements if item.index in changed] if is_diff else elements,
            screenshot_data_url=screenshot,
            screenshot_width=width,
            screenshot_height=height,
            screenshot_bounds=screenshot_bounds,
            revision=revision,
            changed_indices=changed,
            removed_indices=removed,
            is_diff=is_diff,
        )

    def _target(self, app: str, session_id: str, element_index: int) -> Any:
        descriptor = self._resolve_app(app)
        return self._states.handle(session_id, descriptor.identifier, element_index)

    def inspect_element(
        self, app: str, *, session_id: str, element_index: int
    ) -> ElementSnapshot:
        descriptor = self._resolve_app(app)
        return self._states.element(session_id, descriptor.identifier, element_index)

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
            if button == "right":
                target.RightClick(simulateMove=False)
            elif click_count == 2:
                target.DoubleClick(simulateMove=False)
            else:
                # UIA Invoke/Selection patterns are used by Click when available.
                target.Click(simulateMove=False)
            return
        if x is None or y is None:
            raise ValueError("click requires element_index, or both x and y")
        descriptor = self._resolve_app(app)
        self._states.require_coordinate_within_app(
            session_id, descriptor.identifier, float(x), float(y)
        )
        self._activate_app(descriptor)
        self._auto.Click(int(x), int(y), waitTime=0)

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
        self._auto.DragDrop(
            int(from_x), int(from_y), int(to_x), int(to_y), waitTime=0
        )

    def set_value(self, app: str, *, session_id: str, element_index: int, value: str) -> None:
        target = self._target(app, session_id, element_index)
        try:
            target.GetValuePattern().SetValue(value)
        except Exception as exc:
            raise RuntimeError("Element does not support the UIA Value pattern") from exc

    def type_text(
        self,
        app: str,
        *,
        session_id: str,
        text: str,
        element_index: int | None = None,
    ) -> None:
        if element_index is None:
            raise ValueError("type_text requires element_index")
        target = self._target(app, session_id, element_index)
        try:
            pattern = target.GetValuePattern()
            pattern.SetValue(str(pattern.Value or "") + text)
        except Exception as exc:
            raise RuntimeError("Element does not support background text insertion") from exc

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
        modifiers = [*(modifiers or []), *parts[:-1]]
        prefix = "".join({"control": "{Ctrl}", "shift": "{Shift}", "alt": "{Alt}",
                          "ctrl": "{Ctrl}", "option": "{Alt}", "command": "{Win}",
                          "cmd": "{Win}", "super": "{Win}", "meta": "{Win}"}
                         .get(item.casefold(), "") for item in modifiers)
        aliases = {"return": "{Enter}", "enter": "{Enter}", "escape": "{Esc}",
                   "tab": "{Tab}", "backspace": "{Back}", "delete": "{Delete}",
                   "left": "{Left}", "right": "{Right}", "up": "{Up}", "down": "{Down}",
                   "pageup": "{PageUp}", "pagedown": "{PageDown}", "space": " "}
        self._activate_app(descriptor)
        self._auto.SendKeys(prefix + aliases.get(key.casefold(), key), waitTime=0)

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
        normalized = direction.casefold()
        horizontal = normalized in {"left", "right", "l", "r"}
        amount = 1 if normalized in {"down", "right", "d", "r"} else -1
        try:
            for _ in range(max(1, min(20, int(pages)))):
                target.GetScrollPattern().Scroll(
                    amount if horizontal else 0,
                    0 if horizontal else amount,
                )
        except Exception as exc:
            raise RuntimeError("Element does not support the UIA Scroll pattern") from exc

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
        del prefix, suffix
        target = self._target(app, session_id, element_index)
        try:
            document = target.GetTextPattern().DocumentRange
            match = document.FindText(text, False, False)
            if match is None:
                raise ValueError("Requested text was not found in the editable element")
            if selection_type == "cursor_before":
                match.MoveEndpointByRange(1, match, 0)
            elif selection_type == "cursor_after":
                match.MoveEndpointByRange(0, match, 1)
            elif selection_type != "text":
                raise ValueError(
                    "selection_type must be text, cursor_before, or cursor_after"
                )
            match.Select()
        except ValueError:
            raise
        except Exception as exc:
            raise RuntimeError("Element does not support the UIA Text pattern") from exc

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
        actions = {
            "showmenu": lambda: target.RightClick(simulateMove=False),
            "invoke": lambda: target.GetInvokePattern().Invoke(),
            "expand": lambda: target.GetExpandCollapsePattern().Expand(),
            "collapse": lambda: target.GetExpandCollapsePattern().Collapse(),
            "select": lambda: target.GetSelectionItemPattern().Select(),
            "toggle": lambda: target.GetTogglePattern().Toggle(),
            "scrollintoview": lambda: target.GetScrollItemPattern().ScrollIntoView(),
        }
        handler = actions.get(normalized)
        if handler is None:
            raise ValueError(f"Unsupported UIA secondary action: {action}")
        handler()

    def wait_for_stability(
        self,
        app: str,
        *,
        session_id: str,
        timeout: float = 5.0,
    ) -> None:
        del app, session_id, timeout
        time.sleep(0.8)


def _capture_window(
    root: Any,
) -> tuple[
    str | None,
    int | None,
    int | None,
    tuple[float, float, float, float] | None,
]:
    rect = root.BoundingRectangle
    if not rect or rect.width() <= 0 or rect.height() <= 0:
        return None, None, None, None
    screen_bounds = (
        float(rect.left),
        float(rect.top),
        float(rect.width()),
        float(rect.height()),
    )
    from PIL import ImageGrab

    image = ImageGrab.grab(
        bbox=(rect.left, rect.top, rect.right, rect.bottom),
        all_screens=True,
    )
    if image.width > 1440 or image.height > 900:
        from PIL import Image

        image.thumbnail((1440, 900), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}", image.width, image.height, screen_bounds


def _clip(value: str) -> str:
    value = value.replace("\x00", "").strip()
    return value if len(value) <= 500 else value[:499] + "…"
