"""Read-only operating-system capability checks for Computer Use."""

from __future__ import annotations

import importlib.util
import sys
from typing import Literal, TypedDict


PermissionState = Literal["granted", "denied", "not_applicable", "unknown"]
RuntimeState = Literal["available", "missing", "unsupported"]


class ComputerCapabilityStatus(TypedDict):
    platform: Literal["macos", "windows", "linux", "unsupported"]
    supported: bool
    interaction_mode: Literal["background", "foreground", "unsupported"]
    accessibility: PermissionState
    screen_recording: PermissionState
    runtime: RuntimeState
    settings_url: str | None


def get_computer_capability_status() -> ComputerCapabilityStatus:
    """Return current capability state without opening an OS permission prompt."""
    if sys.platform == "darwin":
        return _macos_status()
    if sys.platform == "win32":
        return _windows_status()
    if sys.platform.startswith("linux"):
        platform = "linux"
    else:
        platform = "unsupported"
    return {
        "platform": platform,
        "supported": False,
        "interaction_mode": "unsupported",
        "accessibility": "not_applicable",
        "screen_recording": "not_applicable",
        "runtime": "unsupported",
        "settings_url": None,
    }


def _macos_status() -> ComputerCapabilityStatus:
    try:
        import ApplicationServices as AX
        import Quartz
    except Exception:
        return {
            "platform": "macos",
            "supported": True,
            "interaction_mode": "background",
            "accessibility": "unknown",
            "screen_recording": "unknown",
            "runtime": "missing",
            "settings_url": _MACOS_ACCESSIBILITY_SETTINGS,
        }

    accessibility: PermissionState
    try:
        accessibility = "granted" if AX.AXIsProcessTrusted() else "denied"
    except Exception:
        accessibility = "unknown"

    screen_recording: PermissionState = "unknown"
    preflight = getattr(Quartz, "CGPreflightScreenCaptureAccess", None)
    if preflight is not None:
        try:
            screen_recording = "granted" if preflight() else "denied"
        except Exception:
            pass

    return {
        "platform": "macos",
        "supported": True,
        "interaction_mode": "background",
        "accessibility": accessibility,
        "screen_recording": screen_recording,
        "runtime": "available",
        "settings_url": (
            _MACOS_ACCESSIBILITY_SETTINGS
            if accessibility != "granted"
            else _MACOS_SCREEN_RECORDING_SETTINGS
            if screen_recording != "granted"
            else None
        ),
    }


def _windows_status() -> ComputerCapabilityStatus:
    return {
        "platform": "windows",
        "supported": True,
        "interaction_mode": "foreground",
        "accessibility": "not_applicable",
        "screen_recording": "not_applicable",
        "runtime": (
            "available" if importlib.util.find_spec("uiautomation") else "missing"
        ),
        "settings_url": None,
    }


_MACOS_ACCESSIBILITY_SETTINGS = (
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
)
_MACOS_SCREEN_RECORDING_SETTINGS = (
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
)
