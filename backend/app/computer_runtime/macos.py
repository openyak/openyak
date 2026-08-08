"""macOS Computer Use runtime backed by Accessibility (AX) APIs."""

from __future__ import annotations

import base64
import io
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from app.computer_runtime.base import AppDescriptor, AppState, ElementSnapshot
from app.computer_runtime.state import StateStore


_MAX_ELEMENTS = 900
_MAX_DEPTH = 24
_TEXT_LIMIT = 500
_STABILITY_INITIAL_DELAY = 0.8
_STABILITY_QUIET_PERIOD = 0.55

_KEYCODES = {
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53,
    "esc": 53, "backspace": 51, "delete": 117, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115,
    "end": 119, "pageup": 116, "pagedown": 121, "help": 114,
    "capslock": 57,
    **{f"f{number}": code for number, code in enumerate(
        [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90],
        start=1,
    )},
    **dict(zip("abcdefghijklmnopqrstuvwxyz", [0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6], strict=True)),
    **dict(zip("1234567890", [18,19,20,21,23,22,26,28,25,29], strict=True)),
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41,
    "'": 39, "`": 50, ",": 43, ".": 47, "/": 44,
    "kp_0": 82, "kp_1": 83, "kp_2": 84, "kp_3": 85, "kp_4": 86,
    "kp_5": 87, "kp_6": 88, "kp_7": 89, "kp_8": 91, "kp_9": 92,
    "kp_decimal": 65, "kp_multiply": 67, "kp_plus": 69, "kp_clear": 71,
    "kp_divide": 75, "kp_enter": 76, "kp_minus": 78, "kp_equals": 81,
}
_SHIFTED_KEYS = dict(zip("!@#$%^&*()_+{}|:\"~<>?", "1234567890-=[]\\;'`,./", strict=True))
_MODIFIER_CODES = {"command": 55, "super": 55, "meta": 55, "cmd": 55,
                   "win": 55, "shift": 56, "option": 58, "alt": 58,
                   "control": 59, "ctrl": 59}


class MacOSComputerRuntime:
    def __init__(self) -> None:
        try:
            import ApplicationServices as AX
            import Quartz
            from AppKit import NSWorkspace
        except Exception as exc:  # pragma: no cover - packaged runtime failure
            raise RuntimeError(
                "macOS Computer Use runtime is missing. Reinstall OpenYak to restore "
                "the Accessibility and Screen Recording components."
            ) from exc
        self._ax = AX
        self._quartz = Quartz
        self._workspace = NSWorkspace.sharedWorkspace()
        self._states = StateStore()

    def _require_accessibility(self) -> None:
        if not self._ax.AXIsProcessTrusted():
            raise RuntimeError(
                "OpenYak needs Accessibility permission. Enable OpenYak in System "
                "Settings → Privacy & Security → Accessibility, then try again."
            )

    def _activate_app(self, descriptor: AppDescriptor) -> None:
        for running in self._workspace.runningApplications():
            if int(running.processIdentifier()) != descriptor.pid:
                continue
            # Activate all windows and allow OpenYak to yield foreground focus.
            if not running.activateWithOptions_(3):
                raise RuntimeError("macOS could not bring the target application to the foreground")
            return
        raise ValueError(f"Application '{descriptor.name}' is no longer running")

    def list_apps(self) -> list[AppDescriptor]:
        apps: dict[str, AppDescriptor] = {}
        window_pids = {
            int(info.get(self._quartz.kCGWindowOwnerPID, -1))
            for info in (
                self._quartz.CGWindowListCopyWindowInfo(
                    self._quartz.kCGWindowListOptionAll,
                    self._quartz.kCGNullWindowID,
                ) or []
            )
            if int(info.get(self._quartz.kCGWindowLayer, 1)) == 0
            and float(info.get(self._quartz.kCGWindowBounds, {}).get("Width", 0)) > 80
        }
        for running in self._workspace.runningApplications():
            name = str(running.localizedName() or "").strip()
            identifier = str(running.bundleIdentifier() or "").strip()
            pid = int(running.processIdentifier())
            if not name or pid <= 0 or running.isTerminated():
                continue
            # Only expose normal user applications. Accessory/background
            # agents (menu extras, helpers, UI servers) made app discovery
            # noisy and could crowd the requested app out of model context.
            if int(running.activationPolicy()) != 0:
                continue
            descriptor = AppDescriptor(
                name=name,
                identifier=identifier or name,
                pid=pid,
                executable=identifier or name,
            )
            current = apps.get(descriptor.identifier)
            if current is None or (pid in window_pids and current.pid not in window_pids):
                apps[descriptor.identifier] = descriptor
        return sorted(apps.values(), key=lambda item: (item.name.casefold(), item.pid))

    def resolve_app(self, query: str) -> AppDescriptor:
        """Public resolution so callers can enforce policy on the real target."""
        return self._resolve_app(query, launch=False)

    def _resolve_app(self, query: str, *, launch: bool = True) -> AppDescriptor:
        normalized = query.strip().casefold()
        apps = self.list_apps()
        exact = [
            item
            for item in apps
            if normalized in {item.name.casefold(), item.identifier.casefold()}
        ]
        if exact:
            # Prefer the process that owns windows when helpers share a name.
            return max(exact, key=lambda item: int(bool(self._windows_for_pid(item.pid))))
        if launch:
            command = ["open", "-g"]
            command += ["-b", query] if "." in query and " " not in query else ["-a", query]
            completed = subprocess.run(command, capture_output=True, text=True, timeout=10)
            if completed.returncode != 0:
                raise ValueError(f"Application '{query}' is not running and could not be opened")
            for _ in range(40):
                time.sleep(0.1)
                try:
                    return self._resolve_app(query, launch=False)
                except ValueError:
                    pass
        raise ValueError(f"Application '{query}' was not found")

    def _windows_for_pid(self, pid: int) -> list[Any]:
        root = self._ax.AXUIElementCreateApplication(pid)
        value = _ax_value(self._ax, root, self._ax.kAXWindowsAttribute, ())
        return list(value or ())

    def get_app_state(
        self,
        app: str,
        *,
        session_id: str,
        disable_diff: bool = False,
    ) -> AppState:
        self._require_accessibility()
        descriptor = self._resolve_app(app)
        root = self._ax.AXUIElementCreateApplication(descriptor.pid)
        windows = self._windows_for_pid(descriptor.pid)
        roots = windows or [root]

        elements: list[ElementSnapshot] = []
        handles: dict[int, Any] = {}
        seen: set[str] = set()

        def walk(handle: Any, depth: int, parent: int | None, path: str) -> None:
            if len(elements) >= _MAX_ELEMENTS or depth > _MAX_DEPTH:
                return
            identity = _ax_identity(handle, path)
            if identity in seen:
                return
            seen.add(identity)

            index = self._states.index_for(
                session_id, descriptor.identifier, identity
            )
            role = _text(_ax_value(self._ax, handle, self._ax.kAXRoleAttribute, ""))
            subrole = _text(_ax_value(self._ax, handle, self._ax.kAXSubroleAttribute, ""))
            title = _text(_ax_value(self._ax, handle, self._ax.kAXTitleAttribute, ""))
            description = _text(
                _ax_value(self._ax, handle, self._ax.kAXDescriptionAttribute, "")
            )
            identifier = _text(
                _ax_value(self._ax, handle, self._ax.kAXIdentifierAttribute, "")
            )
            sensitive = "secure" in subrole.casefold()
            value = "" if sensitive else _text(
                _ax_value(self._ax, handle, self._ax.kAXValueAttribute, "")
            )
            position = _ax_point(self._ax, _ax_value(
                self._ax, handle, self._ax.kAXPositionAttribute, None
            ))
            size = _ax_size(self._ax, _ax_value(
                self._ax, handle, self._ax.kAXSizeAttribute, None
            ))
            bounds = None
            if position is not None and size is not None:
                bounds = (position[0], position[1], size[0], size[1])
            snapshot = ElementSnapshot(
                index=index,
                role=role or "AXUnknown",
                name=_clip(title),
                value=_clip(value),
                description=_clip(description),
                identifier=_clip(identifier),
                enabled=bool(_ax_value(self._ax, handle, self._ax.kAXEnabledAttribute, True)),
                focused=bool(_ax_value(self._ax, handle, self._ax.kAXFocusedAttribute, False)),
                bounds=bounds,
                depth=depth,
                parent=parent,
                subrole=_clip(subrole),
                actions=tuple(_ax_actions(self._ax, handle)),
                selected_text_range=_ax_range(self._ax, _ax_value(
                    self._ax, handle, self._ax.kAXSelectedTextRangeAttribute, None
                )),
                busy=bool(_ax_value(self._ax, handle, "AXBusy", False)),
            )
            elements.append(snapshot)
            handles[index] = handle
            children = _ax_value(self._ax, handle, self._ax.kAXChildrenAttribute, ())
            if isinstance(children, (list, tuple)) or type(children).__name__.startswith("__NSArray"):
                role_counts: dict[str, int] = {}
                for child in children:
                    child_role = _text(_ax_value(
                        self._ax, child, self._ax.kAXRoleAttribute, "AXUnknown"
                    )) or "AXUnknown"
                    ordinal = role_counts.get(child_role, 0)
                    role_counts[child_role] = ordinal + 1
                    walk(child, depth + 1, index, f"{path}/{child_role}[{ordinal}]")

        for root_index, window in enumerate(roots):
            walk(window, 0, None, f"window[{root_index}]")

        previous = self._states.previous(session_id, descriptor.identifier)
        revision, changed, removed = self._states.save(
            session_id, descriptor.identifier, elements, handles
        )
        screenshot, width, height, screenshot_bounds = self._capture_window(descriptor.pid)
        is_diff = previous is not None and not disable_diff
        visible_elements = (
            [element for element in elements if element.index in changed]
            if is_diff
            else elements
        )
        return AppState(
            app=descriptor,
            elements=visible_elements,
            screenshot_data_url=screenshot,
            screenshot_width=width,
            screenshot_height=height,
            screenshot_bounds=screenshot_bounds,
            revision=revision,
            changed_indices=changed,
            removed_indices=removed,
            is_diff=is_diff,
            screenshot_unavailable_reason=(
                None if screenshot else self._screenshot_unavailable_reason()
            ),
        )

    def _target(self, app: str, session_id: str, element_index: int) -> tuple[AppDescriptor, Any]:
        descriptor = self._resolve_app(app)
        return descriptor, self._states.handle(session_id, descriptor.identifier, element_index)

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
        self._require_accessibility()
        if element_index is not None:
            _, target = self._target(app, session_id, element_index)
            normalized_button = _normalize_mouse_button(button)
            if normalized_button == "middle":
                raise ValueError("Middle-click requires coordinates on macOS")
            action = self._ax.kAXShowMenuAction if normalized_button == "right" else self._ax.kAXPressAction
            error = self._ax.AXUIElementPerformAction(target, action)
            if error != 0:
                raise RuntimeError(f"Accessibility action failed with AX error {error}")
            if click_count == 2:
                self._ax.AXUIElementPerformAction(target, action)
            return
        if x is None or y is None:
            raise ValueError("click requires element_index, or both x and y")
        descriptor = self._resolve_app(app)
        self._states.require_coordinate_within_app(
            session_id, descriptor.identifier, float(x), float(y)
        )
        self._activate_app(descriptor)
        event_type, up_type, mouse_button = self._mouse_event_types(button)
        for _ in range(max(1, min(2, click_count))):
            down = self._quartz.CGEventCreateMouseEvent(None, event_type, (x, y), mouse_button)
            up = self._quartz.CGEventCreateMouseEvent(None, up_type, (x, y), mouse_button)
            self._quartz.CGEventPost(self._quartz.kCGHIDEventTap, down)
            self._quartz.CGEventPost(self._quartz.kCGHIDEventTap, up)

    def _mouse_event_types(self, button: str) -> tuple[int, int, int]:
        normalized = _normalize_mouse_button(button)
        q = self._quartz
        if normalized == "right":
            return q.kCGEventRightMouseDown, q.kCGEventRightMouseUp, q.kCGMouseButtonRight
        if normalized == "middle":
            return q.kCGEventOtherMouseDown, q.kCGEventOtherMouseUp, q.kCGMouseButtonCenter
        return q.kCGEventLeftMouseDown, q.kCGEventLeftMouseUp, q.kCGMouseButtonLeft

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
        self._require_accessibility()
        descriptor = self._resolve_app(app)
        for x, y in ((from_x, from_y), (to_x, to_y)):
            self._states.require_coordinate_within_app(
                session_id, descriptor.identifier, float(x), float(y)
            )
        self._activate_app(descriptor)
        q = self._quartz
        down = q.CGEventCreateMouseEvent(
            None, q.kCGEventLeftMouseDown, (from_x, from_y), q.kCGMouseButtonLeft
        )
        q.CGEventPost(q.kCGHIDEventTap, down)
        steps = 12
        for step in range(1, steps + 1):
            fraction = step / steps
            point = (
                from_x + (to_x - from_x) * fraction,
                from_y + (to_y - from_y) * fraction,
            )
            event = q.CGEventCreateMouseEvent(
                None, q.kCGEventLeftMouseDragged, point, q.kCGMouseButtonLeft
            )
            q.CGEventPost(q.kCGHIDEventTap, event)
            time.sleep(0.012)
        up = q.CGEventCreateMouseEvent(
            None, q.kCGEventLeftMouseUp, (to_x, to_y), q.kCGMouseButtonLeft
        )
        q.CGEventPost(q.kCGHIDEventTap, up)

    def set_value(self, app: str, *, session_id: str, element_index: int, value: str) -> None:
        self._require_accessibility()
        _, target = self._target(app, session_id, element_index)
        error = self._ax.AXUIElementSetAttributeValue(target, self._ax.kAXValueAttribute, value)
        if error != 0:
            raise RuntimeError(f"Element does not accept values (AX error {error})")

    def type_text(
        self,
        app: str,
        *,
        session_id: str,
        text: str,
        element_index: int | None = None,
    ) -> None:
        self._require_accessibility()
        if element_index is None:
            descriptor = self._resolve_app(app)
            root = self._ax.AXUIElementCreateApplication(descriptor.pid)
            target = _ax_value(
                self._ax, root, self._ax.kAXFocusedUIElementAttribute, None
            )
            if target is None:
                raise ValueError(
                    "No focused editable element; provide element_index from get_app_state"
                )
        else:
            _, target = self._target(app, session_id, element_index)
        error = self._ax.AXUIElementSetAttributeValue(
            target, self._ax.kAXSelectedTextAttribute, text
        )
        if error != 0:
            current = _text(_ax_value(self._ax, target, self._ax.kAXValueAttribute, ""))
            error = self._ax.AXUIElementSetAttributeValue(
                target, self._ax.kAXValueAttribute, current + text
            )
        if error != 0:
            raise RuntimeError(f"Element does not accept typed text (AX error {error})")

    def press_key(
        self,
        app: str,
        *,
        session_id: str,
        key: str,
        modifiers: list[str] | None = None,
    ) -> None:
        del session_id
        self._require_accessibility()
        descriptor = self._resolve_app(app)
        root = self._ax.AXUIElementCreateApplication(descriptor.pid)
        normalized, chord_modifiers = _parse_key_chord(key)
        if normalized not in _KEYCODES:
            raise ValueError(f"Unsupported background key: {key}")
        code = _KEYCODES[normalized]
        requested = [*(modifiers or []), *chord_modifiers]
        pressed_modifiers = []
        for item in requested:
            modifier = _MODIFIER_CODES.get(item.casefold())
            if modifier is None:
                raise ValueError(f"Unsupported modifier: {item}")
            if modifier not in pressed_modifiers:
                pressed_modifiers.append(modifier)
        for modifier in pressed_modifiers:
            self._ax.AXUIElementPostKeyboardEvent(root, 0, modifier, True)
        self._ax.AXUIElementPostKeyboardEvent(root, 0, code, True)
        self._ax.AXUIElementPostKeyboardEvent(root, 0, code, False)
        for modifier in reversed(pressed_modifiers):
            self._ax.AXUIElementPostKeyboardEvent(root, 0, modifier, False)

    def scroll(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        direction: str,
        pages: int = 1,
    ) -> None:
        _, target = self._target(app, session_id, element_index)
        # Scroll actions are implemented by AppKit controls but are not
        # exported as constants by every macOS SDK/PyObjC combination.
        normalized = direction.strip().casefold()
        directions = {
            "up": "Scroll Up By Page", "u": "Scroll Up By Page",
            "down": "Scroll Down By Page", "d": "Scroll Down By Page",
            "left": "Scroll Left By Page", "l": "Scroll Left By Page",
            "right": "Scroll Right By Page", "r": "Scroll Right By Page",
        }
        requested = directions.get(normalized)
        if requested is None:
            raise ValueError("direction must be up, down, left, or right")
        available = _ax_action_pairs(self._ax, target)
        canonical = _canonical_action(requested)
        action = next(
            (raw for raw, display in available if canonical in {
                _canonical_action(raw), _canonical_action(display)
            }),
            "AX" + requested.replace(" ", ""),
        )
        page_count = max(1, min(20, int(pages)))
        for _ in range(page_count):
            error = self._ax.AXUIElementPerformAction(target, action)
            if error != 0:
                if self._set_scrollbar_page(target, normalized, page_count):
                    return
                raise RuntimeError(f"Element does not support scrolling (AX error {error})")

    def _set_scrollbar_page(
        self, target: Any, direction: str, pages: int
    ) -> bool:
        horizontal = direction in {"left", "right", "l", "r"}
        attribute = "AXHorizontalScrollBar" if horizontal else "AXVerticalScrollBar"
        scrollbar = _ax_value(self._ax, target, attribute, None)
        if scrollbar is None:
            return False
        current = _ax_value(self._ax, scrollbar, self._ax.kAXValueAttribute, None)
        if not isinstance(current, (int, float)):
            return False
        positive = direction in {"down", "right", "d", "r"}
        delta = 0.8 * pages * (1 if positive else -1)
        new_value = max(0.0, min(1.0, float(current) + delta))
        error = self._ax.AXUIElementSetAttributeValue(
            scrollbar, self._ax.kAXValueAttribute, new_value
        )
        return error == 0

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
        _, target = self._target(app, session_id, element_index)
        value = _text(_ax_value(self._ax, target, self._ax.kAXValueAttribute, ""))
        if not text:
            raise ValueError("text must not be empty")
        matches = []
        offset = 0
        while True:
            position = value.find(text, offset)
            if position < 0:
                break
            before_ok = not prefix or value[max(0, position - len(prefix)):position] == prefix
            end = position + len(text)
            after_ok = not suffix or value[end:end + len(suffix)] == suffix
            if before_ok and after_ok:
                matches.append((position, end))
            offset = position + 1
        if not matches:
            raise ValueError("Requested text was not found in the editable element")
        if len(matches) > 1:
            raise ValueError("Text match is ambiguous; provide prefix and/or suffix")
        start, end = matches[0]
        if selection_type == "text":
            location, length = start, end - start
        elif selection_type == "cursor_before":
            location, length = start, 0
        elif selection_type == "cursor_after":
            location, length = end, 0
        else:
            raise ValueError(
                "selection_type must be text, cursor_before, or cursor_after"
            )
        range_value = self._ax.AXValueCreate(
            self._ax.kAXValueCFRangeType, (location, length)
        )
        error = self._ax.AXUIElementSetAttributeValue(
            target, self._ax.kAXSelectedTextRangeAttribute, range_value
        )
        if error != 0:
            raise RuntimeError(f"Element does not support text selection (AX error {error})")

    def perform_secondary_action(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        action: str,
    ) -> None:
        _, target = self._target(app, session_id, element_index)
        available = _ax_action_pairs(self._ax, target)
        requested = _canonical_action(action)
        resolved = next(
            (raw for raw, display in available if requested in {
                _canonical_action(raw), _canonical_action(display)
            }),
            None,
        )
        if resolved is None:
            names = ", ".join(display for _, display in available) or "none"
            raise ValueError(f"Action '{action}' is not exposed by the element; available: {names}")
        error = self._ax.AXUIElementPerformAction(target, resolved)
        if error != 0:
            raise RuntimeError(f"Accessibility action failed with AX error {error}")

    def wait_for_stability(
        self,
        app: str,
        *,
        session_id: str,
        timeout: float = 5.0,
    ) -> None:
        del session_id
        descriptor = self._resolve_app(app)
        deadline = time.monotonic() + max(0.5, min(timeout, 5.0))
        time.sleep(min(_STABILITY_INITIAL_DELAY, max(0.0, deadline - time.monotonic())))
        previous: tuple[Any, ...] | None = None
        unchanged_since = time.monotonic()
        while time.monotonic() < deadline:
            signature, busy = self._state_signature(descriptor.pid)
            now = time.monotonic()
            if signature != previous or busy:
                previous = signature
                unchanged_since = now
            elif now - unchanged_since >= _STABILITY_QUIET_PERIOD:
                return
            time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))

    def _state_signature(self, pid: int) -> tuple[tuple[Any, ...], bool]:
        roots = self._windows_for_pid(pid) or [self._ax.AXUIElementCreateApplication(pid)]
        values: list[tuple[Any, ...]] = []
        busy = False

        def walk(handle: Any, depth: int) -> None:
            nonlocal busy
            if len(values) >= 350 or depth > 16:
                return
            role = _text(_ax_value(self._ax, handle, self._ax.kAXRoleAttribute, ""))
            title = _clip(_text(_ax_value(self._ax, handle, self._ax.kAXTitleAttribute, "")))
            value = _clip(_text(_ax_value(self._ax, handle, self._ax.kAXValueAttribute, "")))
            is_busy = bool(_ax_value(self._ax, handle, "AXBusy", False))
            busy = busy or is_busy or role in {"AXProgressIndicator", "AXBusyIndicator"}
            values.append((role, title, value, is_busy))
            children = _ax_value(self._ax, handle, self._ax.kAXChildrenAttribute, ())
            if isinstance(children, (list, tuple)) or type(children).__name__.startswith("__NSArray"):
                for child in children:
                    walk(child, depth + 1)

        for root in roots:
            walk(root, 0)
        return tuple(values), busy

    def _capture_window(
        self, pid: int
    ) -> tuple[
        str | None,
        int | None,
        int | None,
        tuple[float, float, float, float] | None,
    ]:
        q = self._quartz
        infos = q.CGWindowListCopyWindowInfo(q.kCGWindowListOptionAll, q.kCGNullWindowID) or []
        candidates = [
            info for info in infos
            if int(info.get(q.kCGWindowOwnerPID, -1)) == pid
            and int(info.get(q.kCGWindowLayer, 1)) == 0
            and float(info.get(q.kCGWindowBounds, {}).get("Width", 0)) > 80
        ]
        if not candidates:
            return None, None, None, None
        info = max(
            candidates,
            key=lambda item: float(item[q.kCGWindowBounds].get("Width", 0))
            * float(item[q.kCGWindowBounds].get("Height", 0)),
        )
        bounds = info[q.kCGWindowBounds]
        screen_bounds = (
            float(bounds.get("X", 0)),
            float(bounds.get("Y", 0)),
            float(bounds.get("Width", 0)),
            float(bounds.get("Height", 0)),
        )
        image = q.CGWindowListCreateImage(
            q.CGRectNull,
            q.kCGWindowListOptionIncludingWindow,
            int(info[q.kCGWindowNumber]),
            q.kCGWindowImageBoundsIgnoreFraming | q.kCGWindowImageBestResolution,
        )
        if image is None:
            fallback = self._capture_window_with_screencapture(int(info[q.kCGWindowNumber]))
            if fallback is not None:
                return (*fallback, screen_bounds)
            return None, None, None, screen_bounds
        width = int(q.CGImageGetWidth(image))
        height = int(q.CGImageGetHeight(image))
        row_bytes = int(q.CGImageGetBytesPerRow(image))
        raw = bytes(q.CGDataProviderCopyData(q.CGImageGetDataProvider(image)))
        from PIL import Image

        pil = Image.frombuffer("RGBA", (width, height), raw, "raw", "BGRA", row_bytes, 1)
        if width > 1440 or height > 900:
            pil.thumbnail((1440, 900), Image.Resampling.LANCZOS)
            width, height = pil.size
        buffer = io.BytesIO()
        pil.convert("RGB").save(buffer, format="PNG", optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}", width, height, screen_bounds

    def _capture_window_with_screencapture(
        self, window_id: int
    ) -> tuple[str, int, int] | None:
        try:
            with tempfile.TemporaryDirectory(prefix="openyak-capture-") as directory:
                path = Path(directory) / "window.png"
                completed = subprocess.run(
                    ["/usr/sbin/screencapture", "-x", "-l", str(window_id), str(path)],
                    capture_output=True,
                    timeout=8,
                )
                if completed.returncode != 0 or not path.is_file():
                    return None
                from PIL import Image

                with Image.open(path) as source:
                    image = source.convert("RGB")
                    if image.width > 1440 or image.height > 900:
                        image.thumbnail((1440, 900), Image.Resampling.LANCZOS)
                    buffer = io.BytesIO()
                    image.save(buffer, format="PNG", optimize=True)
                    width, height = image.size
                encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                return f"data:image/png;base64,{encoded}", width, height
        except Exception:
            return None

    def _screenshot_unavailable_reason(self) -> str:
        preflight = getattr(self._quartz, "CGPreflightScreenCaptureAccess", None)
        if preflight is not None:
            try:
                if not preflight():
                    return (
                        "OpenYak needs Screen Recording permission in System Settings → "
                        "Privacy & Security → Screen Recording"
                    )
            except Exception:
                pass
        return "The target app has no capturable window on the current macOS session"


def _ax_value(ax: Any, handle: Any, attribute: str, default: Any) -> Any:
    try:
        error, value = ax.AXUIElementCopyAttributeValue(handle, attribute, None)
        return value if error == 0 and value is not None else default
    except Exception:
        return default


def _ax_point(ax: Any, value: Any) -> tuple[float, float] | None:
    if value is None:
        return None
    try:
        ok, point = ax.AXValueGetValue(value, ax.kAXValueCGPointType, None)
        return (float(point.x), float(point.y)) if ok else None
    except Exception:
        return None


def _ax_size(ax: Any, value: Any) -> tuple[float, float] | None:
    if value is None:
        return None


def _ax_range(ax: Any, value: Any) -> tuple[int, int] | None:
    if value is None:
        return None
    try:
        ok, result = ax.AXValueGetValue(value, ax.kAXValueCFRangeType, None)
        if not ok:
            return None
        if hasattr(result, "location"):
            return int(result.location), int(result.length)
        return int(result[0]), int(result[1])
    except Exception:
        return None


def _ax_identity(handle: Any, structural_path: str) -> str:
    try:
        return f"cf:{hash(handle)}"
    except Exception:
        return f"path:{structural_path}"


def _ax_action_pairs(ax: Any, handle: Any) -> list[tuple[str, str]]:
    try:
        error, names = ax.AXUIElementCopyActionNames(handle, None)
        if error != 0 or not names:
            return []
        return [(str(name), _display_action(str(name))) for name in names]
    except Exception:
        return []


def _ax_actions(ax: Any, handle: Any) -> list[str]:
    return [display for _, display in _ax_action_pairs(ax, handle)]


def _display_action(action: str) -> str:
    value = action[2:] if action.startswith("AX") else action
    return re.sub(r"(?<!^)(?=[A-Z])", " ", value).strip()


def _canonical_action(action: str) -> str:
    return re.sub(r"[^a-z0-9]", "", action.casefold().removeprefix("ax"))


def _normalize_mouse_button(button: str) -> str:
    normalized = button.strip().casefold()
    aliases = {"l": "left", "r": "right", "m": "middle"}
    normalized = aliases.get(normalized, normalized)
    if normalized not in {"left", "right", "middle"}:
        raise ValueError("mouse button must be left, right, or middle")
    return normalized


def _parse_key_chord(value: str) -> tuple[str, list[str]]:
    parts = [part.strip() for part in value.split("+") if part.strip()]
    if not parts:
        raise ValueError("key must not be empty")
    raw_key = parts[-1]
    key = raw_key.casefold()
    modifiers = [part.casefold() for part in parts[:-1]]
    if len(key) == 1 and key in _SHIFTED_KEYS:
        key = _SHIFTED_KEYS[key]
        modifiers.append("shift")
    if len(raw_key) == 1 and raw_key.isupper():
        modifiers.append("shift")
    return key, modifiers
    try:
        ok, size = ax.AXValueGetValue(value, ax.kAXValueCGSizeType, None)
        return (float(size.width), float(size.height)) if ok else None
    except Exception:
        return None


def _text(value: Any) -> str:
    if value is None or isinstance(value, (list, tuple, dict)):
        return ""
    return str(value)


def _clip(value: str) -> str:
    value = value.replace("\x00", "").strip()
    return value if len(value) <= _TEXT_LIMIT else value[: _TEXT_LIMIT - 1] + "…"
