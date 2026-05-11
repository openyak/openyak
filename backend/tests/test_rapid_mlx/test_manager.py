"""Tests for Rapid-MLX runtime manager helpers."""

from __future__ import annotations

from pathlib import Path

from app.rapid_mlx import manager as manager_module
from app.rapid_mlx.manager import RapidMLXManager


def test_rapid_mlx_binary_detection_checks_homebrew_paths(monkeypatch, tmp_path: Path):
    fake_binary = tmp_path / "rapid-mlx"
    fake_binary.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.setattr(manager_module.shutil, "which", lambda _name: None)
    monkeypatch.setattr(manager_module, "_COMMON_BINARY_PATHS", (str(fake_binary),))

    mgr = RapidMLXManager(tmp_path)

    assert mgr.executable_path == str(fake_binary)
    assert mgr.is_binary_installed is True


def test_rapid_mlx_port_parsing():
    assert manager_module._port_from_base_url("http://localhost:8000/v1") == 8000
    assert manager_module._port_from_base_url("https://example.test/v1") is None
