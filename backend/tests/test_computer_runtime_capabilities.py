from __future__ import annotations

import sys
from types import SimpleNamespace

from app.computer_runtime.capabilities import get_computer_capability_status


def test_macos_capabilities_are_read_without_requesting_permissions(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setitem(
        sys.modules,
        "ApplicationServices",
        SimpleNamespace(AXIsProcessTrusted=lambda: calls.append("accessibility") or True),
    )
    monkeypatch.setitem(
        sys.modules,
        "Quartz",
        SimpleNamespace(
            CGPreflightScreenCaptureAccess=lambda: calls.append("screen") or False,
            CGRequestScreenCaptureAccess=lambda: calls.append("request") or True,
        ),
    )

    status = get_computer_capability_status()

    assert status["platform"] == "macos"
    assert status["accessibility"] == "granted"
    assert status["screen_recording"] == "denied"
    assert status["interaction_mode"] == "background"
    assert calls == ["accessibility", "screen"]


def test_windows_capabilities_report_foreground_operation(monkeypatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(
        "app.computer_runtime.capabilities.importlib.util.find_spec",
        lambda name: object() if name == "uiautomation" else None,
    )

    status = get_computer_capability_status()

    assert status == {
        "platform": "windows",
        "supported": True,
        "interaction_mode": "foreground",
        "accessibility": "not_applicable",
        "screen_recording": "not_applicable",
        "runtime": "available",
        "settings_url": None,
    }
