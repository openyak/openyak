"""Session-local element indexing and accessibility-state diffs."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.computer_runtime.base import ElementSnapshot


def element_fingerprint(element: ElementSnapshot) -> tuple[Any, ...]:
    return (
        element.role,
        element.name,
        element.value,
        element.description,
        element.identifier,
        element.enabled,
        element.focused,
        element.bounds,
        element.depth,
        element.parent,
        element.subrole,
        element.actions,
        element.selected_text_range,
        element.busy,
    )


@dataclass
class SessionState:
    revision: int = 0
    elements: dict[int, ElementSnapshot] = field(default_factory=dict)
    handles: dict[int, Any] = field(default_factory=dict)


class StateStore:
    def __init__(self) -> None:
        self._states: dict[tuple[str, str], SessionState] = {}
        self._identity_indices: dict[tuple[str, str], dict[str, int]] = {}
        self._next_indices: dict[tuple[str, str], int] = {}

    def index_for(self, session_id: str, app_identifier: str, identity: str) -> int:
        """Return a session-stable element index without ever recycling indices."""
        key = (session_id, app_identifier)
        indices = self._identity_indices.setdefault(key, {})
        if identity in indices:
            return indices[identity]
        index = self._next_indices.get(key, 0)
        self._next_indices[key] = index + 1
        indices[identity] = index
        return index

    def previous(self, session_id: str, app_identifier: str) -> SessionState | None:
        return self._states.get((session_id, app_identifier))

    def save(
        self,
        session_id: str,
        app_identifier: str,
        elements: list[ElementSnapshot],
        handles: dict[int, Any],
    ) -> tuple[int, list[int], list[int]]:
        key = (session_id, app_identifier)
        previous = self._states.get(key)
        revision = (previous.revision + 1) if previous else 1
        current = {element.index: element for element in elements}
        if previous is None:
            changed = list(current)
            removed: list[int] = []
        else:
            changed = [
                index
                for index, element in current.items()
                if index not in previous.elements
                or element_fingerprint(previous.elements[index]) != element_fingerprint(element)
            ]
            removed = [index for index in previous.elements if index not in current]
        self._states[key] = SessionState(
            revision=revision,
            elements=current,
            handles=dict(handles),
        )
        return revision, changed, removed

    def handle(self, session_id: str, app_identifier: str, element_index: int) -> Any:
        state = self._states.get((session_id, app_identifier))
        if state is None:
            raise ValueError("Call get_app_state before using element_index")
        try:
            return state.handles[element_index]
        except KeyError as exc:
            raise ValueError(
                f"element_index {element_index} is stale or unknown; call get_app_state again"
            ) from exc

    def element(
        self, session_id: str, app_identifier: str, element_index: int
    ) -> ElementSnapshot:
        state = self._states.get((session_id, app_identifier))
        if state is None:
            raise ValueError("Call get_app_state before using element_index")
        try:
            return state.elements[element_index]
        except KeyError as exc:
            raise ValueError(
                f"element_index {element_index} is stale or unknown; call get_app_state again"
            ) from exc

    def require_coordinate_within_app(
        self,
        session_id: str,
        app_identifier: str,
        x: float,
        y: float,
    ) -> None:
        state = self._states.get((session_id, app_identifier))
        if state is None:
            raise ValueError("Call get_app_state before using coordinate fallback")
        windows = [item for item in state.elements.values() if item.depth == 0 and item.bounds]
        if not any(
            left <= x <= left + width and top <= y <= top + height
            for item in windows
            for left, top, width, height in [item.bounds]
        ):
            raise ValueError("Coordinate is outside the latest target-application window")
