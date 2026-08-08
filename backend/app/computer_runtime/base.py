"""Contracts shared by the macOS AX and Windows UIA runtimes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class AppDescriptor:
    name: str
    identifier: str
    pid: int
    is_running: bool = True
    last_used_date: str | None = None
    use_count: int | None = None
    # Stable program identity used to gate sensitive applications: the bundle
    # identifier on macOS, the executable basename on Windows. `name` is the
    # window title there, which the open document controls, so it cannot carry
    # a security decision on its own.
    executable: str = ""


@dataclass(frozen=True)
class ElementSnapshot:
    index: int
    role: str
    name: str = ""
    value: str = ""
    description: str = ""
    identifier: str = ""
    enabled: bool = True
    focused: bool = False
    bounds: tuple[float, float, float, float] | None = None
    depth: int = 0
    parent: int | None = None
    subrole: str = ""
    actions: tuple[str, ...] = ()
    selected_text_range: tuple[int, int] | None = None
    busy: bool = False

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"index": self.index, "role": self.role}
        for key in ("name", "value", "description", "identifier", "subrole"):
            item = getattr(self, key)
            if item:
                value[key] = item
        if not self.enabled:
            value["enabled"] = False
        if self.focused:
            value["focused"] = True
        if self.bounds is not None:
            value["bounds"] = list(self.bounds)
        if self.depth:
            value["depth"] = self.depth
        if self.parent is not None:
            value["parent"] = self.parent
        if self.actions:
            value["actions"] = list(self.actions)
        if self.selected_text_range is not None:
            value["selected_text_range"] = list(self.selected_text_range)
        if self.busy:
            value["busy"] = True
        return value


@dataclass
class AppState:
    app: AppDescriptor
    elements: list[ElementSnapshot]
    screenshot_data_url: str | None = None
    screenshot_width: int | None = None
    screenshot_height: int | None = None
    # Absolute screen-space bounds of the captured native window.
    screenshot_bounds: tuple[float, float, float, float] | None = None
    revision: int = 0
    changed_indices: list[int] = field(default_factory=list)
    removed_indices: list[int] = field(default_factory=list)
    is_diff: bool = False
    screenshot_unavailable_reason: str | None = None


class ComputerRuntime(Protocol):
    """Element-first native application automation contract."""

    def list_apps(self) -> list[AppDescriptor]: ...

    def resolve_app(self, query: str) -> AppDescriptor:
        """Resolve a model-supplied name or identifier to a concrete app."""
        ...

    def get_app_state(
        self,
        app: str,
        *,
        session_id: str,
        disable_diff: bool = False,
    ) -> AppState: ...

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
    ) -> None: ...

    def drag(
        self,
        app: str,
        *,
        session_id: str,
        from_x: float,
        from_y: float,
        to_x: float,
        to_y: float,
    ) -> None: ...

    def set_value(self, app: str, *, session_id: str, element_index: int, value: str) -> None: ...
    def type_text(self, app: str, *, session_id: str, text: str, element_index: int | None = None) -> None: ...
    def press_key(
        self,
        app: str,
        *,
        session_id: str,
        key: str,
        modifiers: list[str] | None = None,
    ) -> None: ...
    def scroll(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        direction: str,
        pages: int = 1,
    ) -> None: ...
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
    ) -> None: ...
    def perform_secondary_action(
        self,
        app: str,
        *,
        session_id: str,
        element_index: int,
        action: str,
    ) -> None: ...
    def wait_for_stability(
        self,
        app: str,
        *,
        session_id: str,
        timeout: float = 5.0,
    ) -> None: ...
