"""Semantic desktop capability runtime.

The agent-facing tool is deliberately thin.  Platform adapters own app
discovery, accessibility snapshots, element identity and input dispatch so
Computer Use is a stateful capability surface rather than a screenshot macro.
"""

from __future__ import annotations

import platform

from app.computer_runtime.base import (
    AppDescriptor,
    AppState,
    ComputerRuntime,
    ElementSnapshot,
)


def create_computer_runtime() -> ComputerRuntime:
    system = platform.system()
    if system == "Darwin":
        from app.computer_runtime.macos import MacOSComputerRuntime

        return MacOSComputerRuntime()
    if system == "Windows":
        from app.computer_runtime.windows import WindowsComputerRuntime

        return WindowsComputerRuntime()
    raise RuntimeError(
        "Computer Use currently supports macOS and Windows. Linux support is planned."
    )


__all__ = [
    "AppDescriptor",
    "AppState",
    "ComputerRuntime",
    "ElementSnapshot",
    "create_computer_runtime",
]
